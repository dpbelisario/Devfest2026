import { JobError } from "./jobs/errors.js";

/** Base URL of the IndoorAtlas Mapping REST API. */
export const indoorAtlasMappingApiBase =
  "https://mapping-api.indooratlas.com/public/v1";

/** The subset of the global `fetch` the client uses; tests pass a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;

/** `notFound` is a normal answer for venues without geofences or a wayfinding graph. */
export type IndoorAtlasGetResult =
  { status: "ok"; body: unknown } | { status: "notFound" };

/** Read-only IndoorAtlas Mapping API access. */
export interface IndoorAtlasClient {
  /** GET `path` (e.g. `/venues`). Throws JobError on auth, network or format failures. */
  get(path: string): Promise<IndoorAtlasGetResult>;
}

const maxResponseBytes = 10 * 1024 * 1024;

/**
 * Create a GET-only Mapping API client. The key travels in the `X-API-Key`
 * header, never in the URL, and never appears in errors or logs. Requests
 * time out after `timeoutMs` (default 10 s), redirects are refused and bodies
 * are capped at 10 MiB.
 *
 * Failures: HTTP 401/403 → JobError UPSTREAM_UNAVAILABLE ("key rejected"),
 * other non-2xx except 404 → UPSTREAM_UNAVAILABLE, non-JSON or oversized body →
 * INVALID_UPSTREAM_DATA. HTTP 404 resolves to `{ status: "notFound" }`.
 */
export function createIndoorAtlasClient(options: {
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}): IndoorAtlasClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl ?? indoorAtlasMappingApiBase;
  return {
    async get(path) {
      if (!path.startsWith("/") || path.includes(".."))
        throw new JobError("INVALID_REQUEST", 400, "Invalid IndoorAtlas path");
      let response: Response;
      try {
        response = await doFetch(base + path, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-api-key": options.apiKey,
            "user-agent": "contour-jobs/0.1 (evacuation demo)",
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new JobError(
          "UPSTREAM_UNAVAILABLE",
          502,
          `IndoorAtlas request failed for ${path}: ${error instanceof Error ? error.name : "error"}`,
        );
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: "notFound" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new JobError(
          "UPSTREAM_UNAVAILABLE",
          502,
          response.status === 401 || response.status === 403
            ? `IndoorAtlas rejected the Mapping API key (HTTP ${response.status}) for ${path}`
            : `Unexpected HTTP ${response.status} from IndoorAtlas for ${path}`,
        );
      }
      let text: string;
      try {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxResponseBytes)
          throw new JobError(
            "INVALID_UPSTREAM_DATA",
            502,
            `IndoorAtlas response too large for ${path}`,
          );
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch (error) {
        if (error instanceof JobError) throw error;
        throw new JobError(
          "UPSTREAM_UNAVAILABLE",
          502,
          `IndoorAtlas body read failed for ${path}`,
        );
      }
      try {
        return { status: "ok", body: JSON.parse(text) as unknown };
      } catch {
        throw new JobError(
          "INVALID_UPSTREAM_DATA",
          502,
          `IndoorAtlas returned invalid JSON for ${path}`,
        );
      }
    },
  };
}
