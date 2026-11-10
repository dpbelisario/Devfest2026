import { createHash } from "node:crypto";
import { iaFloorPlanSchema } from "../schemas/indoorAtlas.js";
import type { IndoorAtlasClient } from "./indoorAtlasClient.js";
import type { IndoorVenueService } from "./indoorVenueService.js";
import { JobError } from "./jobs/errors.js";

/**
 * Floor plan images for `GET /api/indoor/floorplans/:floorPlanId/image`.
 *
 * IndoorAtlas image URLs expire, so venue documents store only the placement.
 * This service looks the floor plan up in the public venue list (enabled,
 * IndoorAtlas-synced venues only, so it is never an open proxy), then serves
 * the copy the sync archived in Cloud Storage, or else asks the Mapping API
 * for a fresh URL with the server-side key and downloads the image (timeout,
 * size cap, PNG/JPEG/WebP only, checked by content type and magic bytes).
 * Bytes are kept in memory for {@link floorPlanImageCacheMs}. The Mapping API
 * key is sent only to the Mapping API, never to the image host.
 */

/** Fetch used for image downloads; tests pass a fake. */
export type ImageFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "follow";
    signal: AbortSignal;
  },
) => Promise<Response>;

export type FloorPlanImageType = "image/png" | "image/jpeg" | "image/webp";

export interface FloorPlanImage {
  bytes: Buffer;
  contentType: FloorPlanImageType;
  /** Strong ETag over the bytes. */
  etag: string;
}

/** Outcome of a lookup; the route maps it to an HTTP status. */
export type FloorPlanImageResult =
  | { status: "ok"; image: FloorPlanImage }
  /** Not a floor plan of an enabled synced venue (404). */
  | { status: "notFound" }
  /** Neither a Mapping API key nor an archive on this service (503). */
  | { status: "notConfigured" }
  /** IndoorAtlas or the image host failed, or the image was rejected (502). */
  | { status: "unavailable" };

/** Archived floor plan images (Cloud Storage), see indoorAtlasArchive.ts. */
export interface FloorPlanImageArchive {
  /** Newest stored image of the floor plan, or null. */
  latestFloorPlanImage(
    floorPlanId: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null>;
}

export const floorPlanImageCacheMs = 10 * 60_000;
/** After a failure the same floor plan is not fetched again for this long. */
export const floorPlanImageRetryMs = 30_000;
export const maxFloorPlanImageBytes = 8 * 1024 * 1024;
const maxCachedImages = 24;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Detect the image type from its first bytes. */
export function sniffImageType(bytes: Uint8Array): FloorPlanImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** File extension for a floor plan image type. */
export function imageExtension(type: FloorPlanImageType): string {
  return type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
}

function imageFrom(bytes: Buffer, contentType: FloorPlanImageType) {
  const etag = `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 32)}"`;
  return { bytes, contentType, etag };
}

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw new Error("image too large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error("image too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Download one floor plan image from an (expiring) IndoorAtlas image URL.
 * https only; no credentials are sent. Throws an Error whose message never
 * contains the URL when the download fails, exceeds `maxBytes` (default
 * 8 MiB), is not PNG/JPEG/WebP, or its bytes disagree with its content type.
 */
export async function downloadFloorPlanImage(
  url: string,
  options: {
    fetchImage?: ImageFetch;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<FloorPlanImage> {
  const fetchImage: ImageFetch =
    options.fetchImage ?? ((target, init) => fetch(target, init));
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("image URL invalid");
  }
  if (parsedUrl.protocol !== "https:") throw new Error("image URL not https");
  let response: Response;
  try {
    response = await fetchImage(parsedUrl.href, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg,image/webp" },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new Error(
      `image fetch failed: ${error instanceof Error ? error.name : "error"}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`image host answered HTTP ${response.status}`);
  }
  if (response.url && !response.url.startsWith("https://")) {
    await response.body?.cancel();
    throw new Error("image redirected off https");
  }
  const declaredType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (
    declaredType !== "image/png" &&
    declaredType !== "image/jpeg" &&
    declaredType !== "image/webp"
  ) {
    await response.body?.cancel();
    throw new Error(`unexpected content type ${declaredType || "(none)"}`);
  }
  const bytes = await readCapped(
    response,
    options.maxBytes ?? maxFloorPlanImageBytes,
  );
  const contentType = sniffImageType(bytes);
  if (contentType !== declaredType)
    throw new Error("image bytes do not match the content type");
  return imageFrom(bytes, contentType);
}

/**
 * Fresh image URL of a floor plan from `GET /venues/{venueId}/floorplans`
 * (the URL expires: use it at once, never store it). Null when absent.
 */
export async function freshFloorPlanImageUrl(
  client: IndoorAtlasClient,
  venueId: string,
  floorPlanId: string,
): Promise<string | null> {
  const result = await client.get(`/venues/${venueId}/floorplans`);
  if (result.status !== "ok" || !Array.isArray(result.body)) return null;
  for (const raw of result.body) {
    const parsed = iaFloorPlanSchema.safeParse(raw);
    if (parsed.success && parsed.data.id.toLowerCase() === floorPlanId)
      return parsed.data.image?.url ?? null;
  }
  return null;
}

export interface FloorPlanImageServiceOptions {
  venues: IndoorVenueService;
  /** Null when INDOORATLAS_MAPPING_API_KEY is not set on this service. */
  client: IndoorAtlasClient | null;
  /** Images archived by the sync; tried first. */
  archive?: FloorPlanImageArchive | null;
  fetchImage?: ImageFetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  warn?: (message: string) => void;
}

export class FloorPlanImageService {
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly cache = new Map<
    string,
    { expiresAt: number; image: FloorPlanImage | null }
  >();
  private readonly loading = new Map<string, Promise<FloorPlanImageResult>>();

  constructor(private readonly options: FloorPlanImageServiceOptions) {
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** The image of `floorPlanId`; never throws. */
  async get(floorPlanId: string): Promise<FloorPlanImageResult> {
    const id = floorPlanId.trim().toLowerCase();
    if (!uuidPattern.test(id)) return { status: "notFound" };
    const venueId = await this.venueOf(id);
    if (!venueId) return { status: "notFound" };
    if (!this.options.client && !this.options.archive)
      return { status: "notConfigured" };
    const cached = this.cache.get(id);
    if (cached && this.now() < cached.expiresAt)
      return cached.image
        ? { status: "ok", image: cached.image }
        : { status: "unavailable" };
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(venueId, id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** IndoorAtlas venue holding the floor plan, among enabled synced venues. */
  private async venueOf(floorPlanId: string): Promise<string | null> {
    const list = await this.options.venues.listEnabledVenues();
    const venue = list.venues.find(
      (entry) =>
        entry.syncedFrom === "indooratlas" &&
        entry.indoorAtlas?.floors.some(
          (floor) => floor.floorPlanId.toLowerCase() === floorPlanId,
        ),
    );
    return venue?.indoorAtlas?.venueId.toLowerCase() ?? null;
  }

  private remember(id: string, image: FloorPlanImage | null) {
    this.cache.delete(id);
    this.cache.set(id, {
      image,
      expiresAt:
        this.now() + (image ? floorPlanImageCacheMs : floorPlanImageRetryMs),
    });
    while (this.cache.size > maxCachedImages) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fromArchive(
    floorPlanId: string,
  ): Promise<FloorPlanImage | null> {
    if (!this.options.archive) return null;
    try {
      const stored =
        await this.options.archive.latestFloorPlanImage(floorPlanId);
      if (!stored) return null;
      const type = sniffImageType(stored.bytes);
      return type && type === stored.contentType
        ? imageFrom(stored.bytes, type)
        : null;
    } catch (error) {
      this.warn(
        `Archived floor plan image ${floorPlanId} unreadable: ${error instanceof Error ? error.message : "error"}`,
      );
      return null;
    }
  }

  private async load(
    venueId: string,
    floorPlanId: string,
  ): Promise<FloorPlanImageResult> {
    try {
      let image = await this.fromArchive(floorPlanId);
      if (!image) {
        if (!this.options.client) throw new Error("no archived image");
        const url = await freshFloorPlanImageUrl(
          this.options.client,
          venueId,
          floorPlanId,
        );
        if (!url) throw new Error("floor plan has no image");
        image = await downloadFloorPlanImage(url, this.options);
      }
      this.remember(floorPlanId, image);
      return { status: "ok", image };
    } catch (error) {
      // Messages never contain the key or the signed image URL.
      this.warn(
        `Floor plan image ${floorPlanId} unavailable: ${error instanceof JobError ? error.code : error instanceof Error ? error.message : "error"}`,
      );
      this.remember(floorPlanId, null);
      return { status: "unavailable" };
    }
  }
}
