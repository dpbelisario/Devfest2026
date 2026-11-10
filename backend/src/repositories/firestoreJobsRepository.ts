import { Firestore, Timestamp } from "@google-cloud/firestore";
import { z } from "zod";
import { sha256Hex } from "../services/jobs/payloadCodec.js";
import {
  collections,
  isClaimable,
  type ConditionalWriteResult,
  type EqvolBulletinRecord,
  type JobsRepository,
  type NagoyaDatasetRecord,
  type NagoyaJobRun,
  type OutboxEntry,
  type WeatherBulletinRecord,
} from "./jobsRepository.js";

const bytes = z.instanceof(Uint8Array);

const datasetSchema = z.object({
  recordKey: z.string(),
  municipalityCode: z.string(),
  municipalityName: z.string(),
  datasetVersion: z.string(),
  recordCount: z.number().int().nonnegative(),
  payloadSha256: z.string(),
  payloadGzip: bytes,
  sourceUrl: z.string(),
  sourceAttribution: z.string(),
  lastCheckedAt: z.string(),
  lastChangedAt: z.string(),
  lastStatus: z.enum(["published", "snapshot_saved", "unchanged"]),
  entryType: z.literal("designation_only"),
});

const runSchema = z.object({
  runId: z.string(),
  municipalityCode: z.string(),
  createdAt: z.string(),
  expiresAt: z.instanceof(Timestamp).transform((value) => value.toDate()),
  lastCheckedAt: z.string(),
  valid: z.boolean(),
  recordCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  datasetVersion: z.string(),
  payloadSha256: z.string().nullable(),
  payloadGzip: bytes.nullable(),
  status: z.enum(["fetched", "invalid", "compared", "published", "recorded"]),
  compare: z
    .object({ changed: z.boolean(), baseVersion: z.string().nullable() })
    .nullable(),
  published: z
    .object({ datasetVersion: z.string(), lastChangedAt: z.string() })
    .nullable(),
});

const weatherSchema = z.object({
  recordKey: z.string(),
  sourceUrl: z.string(),
  publishedAt: z.string(),
  reportDateTime: z.string(),
  infoType: z.string(),
  invalidated: z.boolean(),
  storedAt: z.string(),
  processedUrls: z.array(z.string()),
  payloadGzip: bytes,
});

const eqvolSchema = z.object({
  recordKey: z.string(),
  sourceUrl: z.string(),
  bulletinType: z.string(),
  publishedAt: z.string(),
  reportDateTime: z.string(),
  infoType: z.string(),
  invalidated: z.boolean(),
  ignored: z.boolean(),
  aichiMentioned: z.boolean().nullable(),
  storedAt: z.string(),
  payloadGzip: bytes,
});

const outboxSchema = z.object({
  deliveryKey: z.string(),
  sourceUrl: z.string(),
  publishedAt: z.string(),
  bulletinType: z.string(),
  deliveryStatus: z.enum(["pending", "excluded", "sent", "skipped"]),
  acknowledgedAt: z.string(),
  createdAt: z.string(),
  payloadGzip: bytes,
  claimId: z.string().default(""),
  claimedAt: z.string().default(""),
  deliveryNote: z.string().optional(),
});

/** Firestore document IDs may not contain "/"; outbox keys contain URLs. */
function outboxDocumentId(deliveryKey: string): string {
  return sha256Hex(deliveryKey);
}

function assertDocumentId(id: string): string {
  if (!id || id.includes("/") || /^__.*__$/.test(id))
    throw new Error(`Invalid Firestore document id: ${id}`);
  return id;
}

/**
 * Firestore implementation. Uses Application Default Credentials; the service
 * account needs roles/datastore.user. Conditional writes run in transactions.
 */
export class FirestoreJobsRepository implements JobsRepository {
  constructor(private readonly db: Firestore) {}

  static create(options: {
    projectId?: string;
    databaseId?: string;
  }): FirestoreJobsRepository {
    return new FirestoreJobsRepository(
      new Firestore({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.databaseId ? { databaseId: options.databaseId } : {}),
        ignoreUndefinedProperties: true,
      }),
    );
  }

  private doc(collection: string, id: string) {
    return this.db.collection(collection).doc(assertDocumentId(id));
  }

  async getNagoyaDataset(recordKey: string) {
    const snapshot = await this.doc(
      collections.nagoyaDatasets,
      recordKey,
    ).get();
    return snapshot.exists ? datasetSchema.parse(snapshot.data()) : null;
  }

  async saveNagoyaRun(run: NagoyaJobRun) {
    await this.doc(collections.nagoyaJobRuns, run.runId).create({
      ...run,
      expiresAt: Timestamp.fromDate(run.expiresAt),
    });
  }

  async getNagoyaRun(runId: string) {
    const snapshot = await this.doc(collections.nagoyaJobRuns, runId).get();
    return snapshot.exists ? runSchema.parse(snapshot.data()) : null;
  }

  async updateNagoyaRun(
    runId: string,
    patch: Partial<Pick<NagoyaJobRun, "status" | "compare" | "published">>,
  ) {
    await this.doc(collections.nagoyaJobRuns, runId).update(patch);
  }

  async publishNagoyaDataset(input: {
    current: NagoyaDatasetRecord;
    snapshot: NagoyaDatasetRecord;
    expectedBaseVersion: string | null;
  }): Promise<ConditionalWriteResult> {
    const currentRef = this.doc(
      collections.nagoyaDatasets,
      input.current.recordKey,
    );
    const snapshotRef = this.doc(
      collections.nagoyaDatasets,
      input.snapshot.recordKey,
    );
    return this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(currentRef);
      const version: unknown = existing.get("datasetVersion");
      const existingVersion =
        existing.exists && typeof version === "string" ? version : null;
      if (existingVersion !== input.expectedBaseVersion) return "conflict";
      transaction.set(snapshotRef, input.snapshot);
      transaction.set(currentRef, input.current);
      return "written";
    });
  }

  async recordNagoyaUnchanged(input: {
    recordKey: string;
    expectedVersion: string;
    lastCheckedAt: string;
  }): Promise<ConditionalWriteResult> {
    const ref = this.doc(collections.nagoyaDatasets, input.recordKey);
    return this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (
        !existing.exists ||
        existing.get("datasetVersion") !== input.expectedVersion
      )
        return "conflict";
      transaction.update(ref, {
        lastCheckedAt: input.lastCheckedAt,
        lastStatus: "unchanged",
      });
      return "written";
    });
  }

  async getWeatherCurrent(recordKey: string) {
    const snapshot = await this.doc(
      collections.jmaWeatherSnapshots,
      recordKey,
    ).get();
    return snapshot.exists ? weatherSchema.parse(snapshot.data()) : null;
  }

  async storeWeatherBulletin(input: {
    currentKey: string;
    record: WeatherBulletinRecord;
  }) {
    const batch = this.db.batch();
    batch.set(
      this.doc(collections.jmaWeatherSnapshots, input.record.recordKey),
      input.record,
    );
    batch.set(this.doc(collections.jmaWeatherSnapshots, input.currentKey), {
      ...input.record,
      recordKey: input.currentKey,
    });
    await batch.commit();
  }

  async findStoredEqvolKeys(recordKeys: string[]) {
    if (recordKeys.length === 0) return new Set<string>();
    const snapshots = await this.db.getAll(
      ...recordKeys.map((key) => this.doc(collections.jmaEqvolBulletins, key)),
    );
    return new Set(
      snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => snapshot.id),
    );
  }

  async storeEqvolBulletin(record: EqvolBulletinRecord) {
    await this.doc(collections.jmaEqvolBulletins, record.recordKey).set(record);
  }

  async listRecentEqvolBulletins(limit: number) {
    const result = await this.db
      .collection(collections.jmaEqvolBulletins)
      .orderBy("publishedAt", "desc")
      .limit(limit)
      .get();
    return result.docs.map((doc) => eqvolSchema.parse(doc.data()));
  }

  async enqueueOutbox(entry: OutboxEntry) {
    try {
      await this.doc(
        collections.warningOutbox,
        outboxDocumentId(entry.deliveryKey),
      ).create(entry);
      return true;
    } catch (error) {
      // gRPC ALREADY_EXISTS: the handoff was queued by an earlier attempt.
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  async countPendingOutbox() {
    const result = await this.db
      .collection(collections.warningOutbox)
      .where("deliveryStatus", "==", "pending")
      .count()
      .get();
    return result.data().count;
  }

  /*
   * The two queries below filter on deliveryStatus and order by createdAt, so
   * they need the composite index (deliveryStatus ASC, createdAt ASC) that
   * infra/setup-cloud-jobs.sh creates. They only run with delivery enabled.
   */

  async listPendingOutbox(input: { createdFrom: string; limit: number }) {
    const result = await this.db
      .collection(collections.warningOutbox)
      .where("deliveryStatus", "==", "pending")
      .where("createdAt", ">=", input.createdFrom)
      .orderBy("createdAt", "asc")
      .limit(input.limit)
      .get();
    return result.docs.map((doc) => outboxSchema.parse(doc.data()));
  }

  async skipStalePendingOutbox(input: {
    createdBefore: string;
    liveClaimAfter: string;
    acknowledgedAt: string;
    limit: number;
  }) {
    const query = this.db
      .collection(collections.warningOutbox)
      .where("deliveryStatus", "==", "pending")
      .where("createdAt", "<", input.createdBefore)
      .orderBy("createdAt", "asc")
      .limit(input.limit);
    return this.db.runTransaction(async (transaction) => {
      const result = await transaction.get(query);
      let skipped = 0;
      for (const doc of result.docs) {
        const entry = outboxSchema.parse(doc.data());
        if (!isClaimable(entry, input.liveClaimAfter)) continue;
        transaction.update(doc.ref, {
          deliveryStatus: "skipped",
          acknowledgedAt: input.acknowledgedAt,
          deliveryNote: "skipped:stale",
          claimId: "",
          claimedAt: "",
        });
        skipped += 1;
      }
      return skipped;
    });
  }

  private outboxRef(deliveryKey: string) {
    return this.doc(collections.warningOutbox, outboxDocumentId(deliveryKey));
  }

  async claimOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    claimedAt: string;
    liveClaimAfter: string;
  }) {
    const ref = this.outboxRef(input.deliveryKey);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const entry = outboxSchema.parse(snapshot.data());
      if (!isClaimable(entry, input.liveClaimAfter)) return false;
      transaction.update(ref, {
        claimId: input.claimId,
        claimedAt: input.claimedAt,
      });
      return true;
    });
  }

  async completeOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    deliveryStatus: "sent" | "skipped";
    acknowledgedAt: string;
    deliveryNote: string;
  }) {
    const ref = this.outboxRef(input.deliveryKey);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get("deliveryStatus") !== "pending" ||
        snapshot.get("claimId") !== input.claimId
      )
        return false;
      transaction.update(ref, {
        deliveryStatus: input.deliveryStatus,
        acknowledgedAt: input.acknowledgedAt,
        deliveryNote: input.deliveryNote,
      });
      return true;
    });
  }

  async releaseOutboxClaim(input: { deliveryKey: string; claimId: string }) {
    const ref = this.outboxRef(input.deliveryKey);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("claimId") !== input.claimId) return;
      transaction.update(ref, { claimId: "", claimedAt: "" });
    });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 6
  );
}
