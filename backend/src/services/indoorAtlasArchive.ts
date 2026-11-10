import { createHash } from "node:crypto";
import type { IndoorAtlasClient } from "./indoorAtlasClient.js";
import {
  downloadFloorPlanImage,
  imageExtension,
  sniffImageType,
  type FloorPlanImageArchive,
  type ImageFetch,
} from "./floorPlanImageService.js";

/**
 * Raw IndoorAtlas archive: a complete, read-only copy of what the Mapping API
 * key can read, kept separate from the app-facing `indoorVenues` documents so
 * floor-plan tooling (docs/floorplan-to-indooratlas.md) can build on it.
 * Never served by the public API.
 *
 * Storage (see docs/indoor-venues.md#raw-indooratlas-archive):
 * - Cloud Storage bucket (INDOORATLAS_ARCHIVE_BUCKET, private):
 *   - `raw/{venueId}/{contentHash}.json`: one snapshot (see {@link RawVenueSnapshot}).
 *     GeoJSON is stored verbatim; Firestore cannot hold nested arrays or
 *     documents over 1 MiB, so snapshots live in Cloud Storage.
 *   - `floorplans/{floorPlanId}/{imageHash}.{png|jpg|webp}`: floor plan images
 *     (the Mapping API's image URLs expire and are never stored).
 * - Firestore `indoorAtlasRaw/{venueId}`: {@link RawVenueMeta}: current hash,
 *   `fetchedAt`, snapshot path, counts, images and the last
 *   {@link rawHistoryLimit} snapshots (older snapshot objects are deleted).
 *
 * A snapshot is written only when its content hash changes; `fetchedAt` is the
 * time that content was first seen.
 */

/** Snapshots kept per venue (current one included). */
export const rawHistoryLimit = 10;
export const rawMetaCollection = "indoorAtlasRaw";

/** Where snapshot objects and images are kept, plus the Firestore metadata. */
export interface IndoorAtlasArchiveStore {
  readMeta(venueId: string): Promise<RawVenueMeta | null>;
  writeMeta(venueId: string, meta: RawVenueMeta): Promise<void>;
  listMeta(): Promise<RawVenueMeta[]>;
  putObject(path: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Null when the object does not exist. */
  getObject(path: string): Promise<Buffer | null>;
  deleteObject(path: string): Promise<void>;
  /** Object names under `prefix` with their last update time (ISO). */
  listObjects(prefix: string): Promise<{ name: string; updated: string }[]>;
}

/** One stored snapshot (`raw/{venueId}/{contentHash}.json`). */
export interface RawVenueSnapshot {
  format: "contour-indooratlas-raw/1";
  venueId: string;
  contentHash: string;
  fetchedAt: string;
  /** `GET /venues` entry, verbatim. */
  venue: unknown;
  /**
   * `GET /venues/{id}/floorplans`, verbatim except `image.url` (expires), plus
   * `storedImage: { path, contentType } | null` (archived copy of the image).
   */
  floorPlans: unknown[];
  /** `GET /venues/{id}/geofences/geojson` (polygons and POIs); null on 404. */
  geofences: unknown;
  /** `GET /venues/{id}/wayfinding/geojson`; null on 404. */
  wayfinding: unknown;
  /** `GET /venues/{id}/radios/geojson` (BLE beacons, Wi-Fi access points); null on 404. */
  radios: unknown;
  /** `GET /floorplans/{floorPlanId}/paths/geojson` (enabled paths) per floor plan; null on 404. */
  paths: Record<string, unknown>;
}

export interface RawVenueMeta {
  venueId: string;
  name: string;
  contentHash: string;
  fetchedAt: string;
  snapshotPath: string;
  counts: {
    floorPlans: number;
    geofenceFeatures: number;
    wayfindingFeatures: number;
    radios: number;
    pathFeatures: number;
    images: number;
  };
  images: {
    floorPlanId: string;
    path: string;
    /** Hash of the floor plan object without its URL when the image was stored. */
    planHash: string;
  }[];
  /** Newest first, current snapshot included. */
  history: { contentHash: string; fetchedAt: string; snapshotPath: string }[];
}

/** JSON with object keys sorted, for content hashes. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Copy of a floor plan object without its expiring image URL. */
export function withoutImageUrl(plan: unknown): unknown {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const copy: Record<string, unknown> = {
    ...(plan as Record<string, unknown>),
  };
  if (
    copy.image &&
    typeof copy.image === "object" &&
    !Array.isArray(copy.image)
  ) {
    const image = { ...(copy.image as Record<string, unknown>) };
    delete image.url;
    copy.image = image;
  }
  return copy;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function planId(plan: unknown): string | null {
  const id =
    plan && typeof plan === "object" && "id" in plan ? plan.id : undefined;
  return typeof id === "string" && uuidPattern.test(id.trim())
    ? id.trim().toLowerCase()
    : null;
}

function imageUrl(plan: unknown): string | null {
  if (!plan || typeof plan !== "object" || !("image" in plan)) return null;
  const image = plan.image;
  if (!image || typeof image !== "object" || !("url" in image)) return null;
  return typeof image.url === "string" ? image.url : null;
}

function featureCount(collection: unknown): number {
  if (!collection || typeof collection !== "object") return 0;
  const features = "features" in collection ? collection.features : undefined;
  return Array.isArray(features) ? features.length : 0;
}

function typeOfPath(path: string): string {
  const ext = path.split(".").pop();
  return ext === "png"
    ? "image/png"
    : ext === "jpg"
      ? "image/jpeg"
      : "image/webp";
}

async function getOrNull(
  client: IndoorAtlasClient,
  path: string,
): Promise<unknown> {
  const result = await client.get(path);
  return result.status === "ok" ? result.body : null;
}

export interface ArchiveVenueInput {
  client: IndoorAtlasClient;
  store: IndoorAtlasArchiveStore;
  venueId: string;
  name: string;
  /** Already fetched by the sync (verbatim responses). */
  venue: unknown;
  floorPlans: unknown[];
  geofences: unknown;
  wayfinding: unknown;
  now: () => Date;
  fetchImage?: ImageFetch;
  log: (message: string) => void;
}

/**
 * Archive one venue: fetch radios and per-floor-plan paths (GET only), store
 * floor plan images (re-downloaded only when the floor plan object changed),
 * and write a new snapshot when the content hash changed. Returns whether a
 * snapshot was written. Throws on IndoorAtlas/storage failures (the caller logs
 * and keeps the previous snapshot); a failed image download keeps the
 * previously stored image, if any.
 */
export async function archiveVenue(
  input: ArchiveVenueInput,
): Promise<"written" | "unchanged"> {
  const { client, store, log } = input;
  const venueId = input.venueId.toLowerCase();
  const previous = await store.readMeta(venueId);
  const radios = await getOrNull(client, `/venues/${venueId}/radios/geojson`);
  const paths: Record<string, unknown> = {};
  const images: RawVenueMeta["images"] = [];
  const floorPlans: unknown[] = [];
  for (const plan of input.floorPlans) {
    const id = planId(plan);
    const stripped = withoutImageUrl(plan);
    if (!id) {
      floorPlans.push(stripped);
      continue;
    }
    paths[id] = await getOrNull(client, `/floorplans/${id}/paths/geojson`);
    const planHash = sha256(stableStringify(stripped));
    const before = previous?.images.find((image) => image.floorPlanId === id);
    let entry = before && before.planHash === planHash ? before : null;
    const url = imageUrl(plan);
    if (!entry && url) {
      try {
        const image = await downloadFloorPlanImage(url, {
          ...(input.fetchImage ? { fetchImage: input.fetchImage } : {}),
        });
        const hash = sha256(image.bytes);
        const path = `floorplans/${id}/${hash.slice(0, 32)}.${imageExtension(image.contentType)}`;
        await store.putObject(path, image.bytes, image.contentType);
        entry = { floorPlanId: id, path, planHash };
      } catch (error) {
        log(
          `IndoorAtlas floor plan ${id}: image not archived (${error instanceof Error ? error.message : "error"})${before ? "; keeping the stored copy" : ""}`,
        );
        entry = before ?? null;
      }
    }
    if (entry) images.push(entry);
    floorPlans.push({
      ...(stripped as Record<string, unknown>),
      storedImage: entry
        ? { path: entry.path, contentType: typeOfPath(entry.path) }
        : null,
    });
  }
  const content = {
    venue: input.venue,
    floorPlans,
    geofences: input.geofences,
    wayfinding: input.wayfinding,
    radios,
    paths,
  };
  const contentHash = sha256(stableStringify(content));
  if (previous?.contentHash === contentHash) return "unchanged";
  const fetchedAt = input.now().toISOString();
  const snapshotPath = `raw/${venueId}/${contentHash}.json`;
  const snapshot: RawVenueSnapshot = {
    format: "contour-indooratlas-raw/1",
    venueId,
    contentHash,
    fetchedAt,
    ...content,
  };
  await store.putObject(
    snapshotPath,
    Buffer.from(JSON.stringify(snapshot, null, 2)),
    "application/json",
  );
  const history = [
    { contentHash, fetchedAt, snapshotPath },
    ...(previous?.history ?? []).filter(
      (entry) => entry.contentHash !== contentHash,
    ),
  ];
  const kept = history.slice(0, rawHistoryLimit);
  await store.writeMeta(venueId, {
    venueId,
    name: input.name,
    contentHash,
    fetchedAt,
    snapshotPath,
    counts: {
      floorPlans: floorPlans.length,
      geofenceFeatures: featureCount(input.geofences),
      wayfindingFeatures: featureCount(input.wayfinding),
      radios: featureCount(radios),
      pathFeatures: Object.values(paths).reduce<number>(
        (sum, collection) => sum + featureCount(collection),
        0,
      ),
      images: images.length,
    },
    images,
    history: kept,
  });
  for (const dropped of history.slice(rawHistoryLimit))
    await store.deleteObject(dropped.snapshotPath);
  return "written";
}

/** Read the current snapshot of a venue; null when none is stored. */
export async function readRawSnapshot(
  store: IndoorAtlasArchiveStore,
  venueId: string,
): Promise<{ meta: RawVenueMeta; snapshot: RawVenueSnapshot } | null> {
  const meta = await store.readMeta(venueId.toLowerCase());
  if (!meta) return null;
  const bytes = await store.getObject(meta.snapshotPath);
  if (!bytes) return null;
  return {
    meta,
    snapshot: JSON.parse(bytes.toString("utf8")) as RawVenueSnapshot,
  };
}

/** Floor plan images from the archive bucket, for the public image proxy. */
export function archiveImageSource(
  store: IndoorAtlasArchiveStore,
): FloorPlanImageArchive {
  return {
    async latestFloorPlanImage(floorPlanId) {
      if (!uuidPattern.test(floorPlanId)) return null;
      const objects = await store.listObjects(
        `floorplans/${floorPlanId.toLowerCase()}/`,
      );
      const newest = objects.sort((a, b) =>
        b.updated.localeCompare(a.updated),
      )[0];
      if (!newest) return null;
      const bytes = await store.getObject(newest.name);
      if (!bytes) return null;
      const contentType = sniffImageType(bytes);
      return contentType ? { bytes, contentType } : null;
    },
  };
}

/** In-memory store for tests and local runs. */
export class MemoryIndoorAtlasArchiveStore implements IndoorAtlasArchiveStore {
  readonly metas = new Map<string, RawVenueMeta>();
  readonly objects = new Map<
    string,
    { bytes: Buffer; contentType: string; updated: string }
  >();
  writes = 0;
  private tick = 0;

  async readMeta(venueId: string) {
    return structuredClone(this.metas.get(venueId) ?? null);
  }
  async writeMeta(venueId: string, meta: RawVenueMeta) {
    this.writes++;
    this.metas.set(venueId, structuredClone(meta));
  }
  async listMeta() {
    return [...this.metas.values()].map((meta) => structuredClone(meta));
  }
  async putObject(path: string, bytes: Buffer, contentType: string) {
    this.writes++;
    this.objects.set(path, {
      bytes: Buffer.from(bytes),
      contentType,
      updated: new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)).toISOString(),
    });
  }
  async getObject(path: string) {
    const object = this.objects.get(path);
    return object ? Buffer.from(object.bytes) : null;
  }
  async deleteObject(path: string) {
    this.objects.delete(path);
  }
  async listObjects(prefix: string) {
    return [...this.objects]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, object]) => ({ name, updated: object.updated }));
  }
}
