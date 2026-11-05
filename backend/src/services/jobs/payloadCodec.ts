import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { JobError } from "./errors.js";

/**
 * Firestore documents are limited to 1 MiB. Payloads are stored gzip-compressed
 * as bytes and rejected above this bound so that the surrounding small fields
 * always fit.
 */
export const maxEncodedPayloadBytes = 900_000;

/** Compress a JSON-serialisable value. Throws PAYLOAD_TOO_LARGE above the bound. */
export function encodePayload(value: unknown): Uint8Array {
  const encoded = gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
  if (encoded.byteLength > maxEncodedPayloadBytes) {
    throw new JobError(
      "PAYLOAD_TOO_LARGE",
      500,
      `Encoded payload is ${encoded.byteLength} bytes`,
    );
  }
  return new Uint8Array(encoded);
}

/** Inverse of encodePayload; returns unvalidated JSON. */
export function decodePayload(bytes: Uint8Array): unknown {
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
