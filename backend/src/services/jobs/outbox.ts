import type { OutboxEntry } from "../../repositories/jobsRepository.js";
import type { JobsContext } from "./context.js";
import { invalidUpstream } from "./errors.js";
import { encodePayload } from "./payloadCodec.js";

/** Bulletin URLs accepted into the outbox (n8n "Prepare … handoff"). */
export const handoffSourcePattern =
  /^https:\/\/www\.data\.jma\.go\.jp\/developer\/xml\/data\/[A-Za-z0-9_]+_(?:VPWW53_230000|(?:VXSE53|VTSE41|VFVO50)_[0-9]+)\.xml$/;

/** Minimal shape of a normalised bulletin payload needed for a handoff. */
export interface HandoffBulletin {
  sourceUrl: string;
  bulletinType?: string;
  ignored?: boolean;
  control?: unknown;
  [key: string]: unknown;
}

/**
 * Build the durable outbox entry for a stored bulletin. Training/test reports
 * become `excluded` so they never reach the pending delivery query.
 * Throws INVALID_UPSTREAM_DATA on identity mismatch.
 */
export function prepareHandoff(
  row: { sourceUrl: string; publishedAt: string; bulletin: HandoffBulletin },
  createdAt: string,
): OutboxEntry {
  const { sourceUrl, publishedAt, bulletin } = row;
  if (!handoffSourcePattern.test(sourceUrl))
    throw invalidUpstream("Invalid official bulletin source");
  if (
    bulletin.sourceUrl !== sourceUrl ||
    !Number.isFinite(Date.parse(publishedAt))
  )
    throw invalidUpstream("Invalid bulletin identity");
  const deliveryKey = `jma:${sourceUrl}`;
  const controlStatus =
    typeof bulletin.control === "object" &&
    bulletin.control !== null &&
    "Status" in bulletin.control
      ? bulletin.control.Status
      : undefined;
  const excluded =
    bulletin.ignored === true ||
    (typeof controlStatus === "string" &&
      controlStatus !== "" &&
      controlStatus !== "通常");
  const bulletinType = bulletin.bulletinType ?? "VPWW53";
  const envelope = {
    schemaVersion: 1,
    deliveryKey,
    sourceUrl,
    publishedAt,
    bulletinType,
    purpose: "warning_ingestion",
    bulletin,
  };
  return {
    deliveryKey,
    sourceUrl,
    publishedAt,
    bulletinType,
    deliveryStatus: excluded ? "excluded" : "pending",
    acknowledgedAt: "",
    createdAt,
    payloadGzip: encodePayload(envelope),
  };
}

/**
 * Delivery is disabled until the FCM ingestion endpoint exists: this only
 * counts pending handoffs so the scheduler can observe the backlog.
 */
export async function deliverOutbox(context: JobsContext) {
  const pending = await context.repository.countPendingOutbox();
  return { deliveryEnabled: false as const, pending, attempted: 0 as const };
}
