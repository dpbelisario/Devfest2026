/** Error codes the private jobs API may return in `{ error: code }` bodies. */
export type JobErrorCode =
  | "INVALID_REQUEST"
  | "RUN_NOT_FOUND"
  | "DATASET_INVALID"
  | "DATASET_SHRANK"
  | "RUN_NOT_PUBLISHABLE"
  | "RUN_NOT_UNCHANGED"
  | "CONCURRENT_UPDATE"
  | "PAYLOAD_TOO_LARGE"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_UPSTREAM_DATA";

/**
 * Expected job failure. `code` and `status` are safe to return to the caller;
 * `message` carries internal detail and is only logged.
 */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JobError";
  }
}

/** Official data failed validation; nothing has been persisted for it. */
export function invalidUpstream(message: string): JobError {
  return new JobError("INVALID_UPSTREAM_DATA", 502, message);
}
