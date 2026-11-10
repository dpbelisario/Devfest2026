import { indoorAtlasMappingApiBase } from "../indoorAtlasClient.js";
import { JobError } from "../jobs/errors.js";

/** The subset of `fetch` the writer uses; tests pass a fake. */
export type PutFetch = (
  url: string,
  init: {
    method: "PUT";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;

/** Write access to the IndoorAtlas Mapping API (`PUT` only). */
export interface IndoorAtlasWriter {
  /** PUT a JSON body to `path`. Resolves on 2xx; throws JobError otherwise. */
  put(path: string, body: unknown): Promise<void>;
}

/**
 * Create a PUT-only Mapping API client. Same rules as the read client: the
 * key is sent in `X-API-Key` only and never appears in errors; redirects are
 * refused; requests time out after `timeoutMs` (default 20 s).
 *
 * Failures: 401/403 → UPSTREAM_UNAVAILABLE "key rejected or read-only";
 * other non-2xx → UPSTREAM_UNAVAILABLE with the status and up to 300
 * characters of the response text (IndoorAtlas validation messages).
 */
export function createIndoorAtlasWriter(options: {
  apiKey: string;
  fetch?: PutFetch;
  timeoutMs?: number;
  baseUrl?: string;
}): IndoorAtlasWriter {
  const doFetch: PutFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.baseUrl ?? indoorAtlasMappingApiBase;
  const timeoutMs = options.timeoutMs ?? 20_000;
  return {
    async put(path, body) {
      if (!path.startsWith("/") || path.includes(".."))
        throw new JobError("INVALID_REQUEST", 400, "Invalid IndoorAtlas path");
      let response: Response;
      try {
        response = await doFetch(base + path, {
          method: "PUT",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "user-agent": "contour-floorplan/0.1 (evacuation demo)",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new JobError(
          "UPSTREAM_UNAVAILABLE",
          502,
          `IndoorAtlas PUT failed for ${path}: ${error instanceof Error ? error.name : "error"}`,
        );
      }
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      let detail = "";
      try {
        detail = (await response.text())
          .split(options.apiKey)
          .join("[key]")
          .replace(/\s+/g, " ")
          .slice(0, 300);
      } catch {
        // keep the status only
      }
      throw new JobError(
        "UPSTREAM_UNAVAILABLE",
        502,
        response.status === 401 || response.status === 403
          ? `IndoorAtlas rejected the Mapping API key for writing (HTTP ${response.status}) on ${path}; the key may be read-only`
          : `IndoorAtlas answered HTTP ${response.status} to PUT ${path}${detail ? `: ${detail}` : ""}`,
      );
    },
  };
}
