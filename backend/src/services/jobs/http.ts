import { JobError } from "./errors.js";

/** Downloads a UTF-8 text resource. Implementations must enforce the timeout. */
export type FetchText = (
  url: string,
  options: { timeoutMs: number },
) => Promise<string>;

const maxResponseBytes = 20 * 1024 * 1024;

/**
 * Fetch an allow-listed official URL as UTF-8 text using the global fetch.
 * Redirects are refused, the body is capped at 20 MiB, and invalid UTF-8 is
 * rejected. Failures throw JobError UPSTREAM_UNAVAILABLE or INVALID_UPSTREAM_DATA.
 */
export const fetchTextWithTimeout: FetchText = async (url, { timeoutMs }) => {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "contour-jobs/0.1 (evacuation demo)" },
    });
  } catch (error) {
    throw new JobError("UPSTREAM_UNAVAILABLE", 502, `Fetch failed for ${url}`, {
      cause: error,
    });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new JobError(
      "UPSTREAM_UNAVAILABLE",
      502,
      `Unexpected HTTP ${response.status} for ${url}`,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxResponseBytes) {
        await response.body.cancel();
        throw new JobError(
          "INVALID_UPSTREAM_DATA",
          502,
          `Response too large for ${url}`,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError(
      "UPSTREAM_UNAVAILABLE",
      502,
      `Body read failed for ${url}`,
      { cause: error },
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch (error) {
    throw new JobError(
      "INVALID_UPSTREAM_DATA",
      502,
      `Invalid UTF-8 from ${url}`,
      { cause: error },
    );
  }
};
