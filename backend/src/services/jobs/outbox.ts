import { randomBytes } from "node:crypto";
import type { OutboxEntry } from "../../repositories/jobsRepository.js";
import type { JobsContext } from "./context.js";
import { invalidUpstream } from "./errors.js";
import { encodePayload } from "./payloadCodec.js";
import { decideWarningPush, warningPushMaxAgeMs } from "./warningPush.js";

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

/** Most messages sent per deliver call (the workflow calls every minute). */
export const maxSendsPerDelivery = 3;
/** Most fresh pending rows examined per call (skips do not count as sends). */
const maxExaminedPerDelivery = 20;
/** Most stale rows marked skipped per call (drains an old backlog quickly). */
const maxStaleSkipsPerDelivery = 400;
/** A claim older than this belongs to an abandoned attempt and may be retaken. */
export const deliveryClaimLeaseMs = 5 * 60 * 1000;

export interface DeliverySummary {
  deliveryEnabled: boolean;
  /** Pending rows left after this call. */
  pending: number;
  /** Send attempts made by this call (≤ maxSendsPerDelivery). */
  attempted: number;
  sent: number;
  /** Rows this call marked skipped (stale, cancelled, not relevant, …). */
  skipped: number;
  /** Send attempts that failed; those rows stay pending for a later call. */
  failed: number;
}

/**
 * Deliver pending warning handoffs to the FCM topic.
 *
 * Disabled (no sender): only counts the backlog, as before.
 * Enabled: rows created more than 30 minutes ago are marked `skipped:stale`;
 * then fresh rows are handled oldest first. Each row is claimed in a
 * Firestore transaction before anything is sent, so overlapping or retried
 * calls never send the same row twice (a crash between send and the final
 * write can resend once after the claim lease expires, still within the
 * 30-minute window). Rows that are not meaningful are marked `skipped` with a
 * reason; at most `maxSendsPerDelivery` messages are sent per call. A failed
 * send releases the claim and leaves the row pending.
 */
export async function deliverOutbox(
  context: JobsContext,
): Promise<DeliverySummary> {
  const { repository, delivery } = context;
  const summary: DeliverySummary = {
    deliveryEnabled: delivery.sender !== null,
    pending: 0,
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  const sender = delivery.sender;
  if (!sender) {
    summary.pending = await repository.countPendingOutbox();
    return summary;
  }
  const now = context.now();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - warningPushMaxAgeMs).toISOString();
  const liveClaimAfter = new Date(
    now.getTime() - deliveryClaimLeaseMs,
  ).toISOString();
  summary.skipped += await repository.skipStalePendingOutbox({
    createdBefore: cutoff,
    liveClaimAfter,
    acknowledgedAt: nowIso,
    limit: maxStaleSkipsPerDelivery,
  });
  const entries = await repository.listPendingOutbox({
    createdFrom: cutoff,
    limit: maxExaminedPerDelivery,
  });
  for (const entry of entries) {
    if (summary.attempted >= maxSendsPerDelivery) break;
    const decision = decideWarningPush(entry, now, delivery.topic);
    const claimId = randomBytes(8).toString("hex");
    const claimed = await repository.claimOutboxEntry({
      deliveryKey: entry.deliveryKey,
      claimId,
      claimedAt: nowIso,
      liveClaimAfter,
    });
    if (!claimed) continue;
    if (decision.action === "skip") {
      if (
        await repository.completeOutboxEntry({
          deliveryKey: entry.deliveryKey,
          claimId,
          deliveryStatus: "skipped",
          acknowledgedAt: nowIso,
          deliveryNote: `skipped:${decision.reason}`,
        })
      )
        summary.skipped += 1;
      continue;
    }
    summary.attempted += 1;
    let messageId: string;
    try {
      messageId = await sender.send(decision.message);
    } catch (error) {
      summary.failed += 1;
      console.warn("Warning push failed; entry stays pending", {
        deliveryKey: entry.deliveryKey,
        error: error instanceof Error ? error.message : "unknown",
      });
      await repository
        .releaseOutboxClaim({ deliveryKey: entry.deliveryKey, claimId })
        .catch((releaseError: unknown) =>
          console.error("Could not release outbox claim", releaseError),
        );
      continue;
    }
    summary.sent += 1;
    // Sent: never throw from here, or a workflow retry could not tell.
    try {
      const recorded = await repository.completeOutboxEntry({
        deliveryKey: entry.deliveryKey,
        claimId,
        deliveryStatus: "sent",
        acknowledgedAt: context.now().toISOString(),
        deliveryNote: `fcm:${messageId.slice(0, 200)}`,
      });
      if (!recorded)
        console.error("Sent warning push but lost the claim", {
          deliveryKey: entry.deliveryKey,
        });
    } catch (error) {
      console.error("Sent warning push but could not record it", {
        deliveryKey: entry.deliveryKey,
        error,
      });
    }
  }
  summary.pending = await repository.countPendingOutbox();
  return summary;
}
