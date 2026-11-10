/**
 * Storage boundary for the ingestion jobs. Firestore backs production; the
 * in-memory implementation backs tests and local smoke runs. Payloads are
 * gzip-compressed JSON bytes (see services/jobs/payloadCodec.ts).
 */

/** Firestore collection names (also used as namespaces by the memory store). */
export const collections = {
  nagoyaDatasets: "nagoyaDatasets",
  nagoyaJobRuns: "nagoyaJobRuns",
  jmaWeatherSnapshots: "jmaWeatherSnapshots",
  jmaEqvolBulletins: "jmaEqvolBulletins",
  warningOutbox: "warningOutbox",
} as const;

/** Published dataset state stored at `nagoyaDatasets/current:<code>`. */
export interface NagoyaDatasetRecord {
  recordKey: string;
  municipalityCode: string;
  municipalityName: string;
  datasetVersion: string;
  recordCount: number;
  payloadSha256: string;
  payloadGzip: Uint8Array;
  sourceUrl: string;
  sourceAttribution: string;
  lastCheckedAt: string;
  lastChangedAt: string;
  lastStatus: "published" | "snapshot_saved" | "unchanged";
  entryType: "designation_only";
}

export interface NagoyaCompareResult {
  changed: boolean;
  /** datasetVersion of the current row at comparison time; null when absent. */
  baseVersion: string | null;
}

/** Staged candidate stored at `nagoyaJobRuns/<runId>`. */
export interface NagoyaJobRun {
  runId: string;
  municipalityCode: string;
  createdAt: string;
  /** Firestore TTL candidate: runs are only needed for the duration of a workflow. */
  expiresAt: Date;
  lastCheckedAt: string;
  valid: boolean;
  recordCount: number;
  errorCount: number;
  errors: string[];
  datasetVersion: string;
  payloadSha256: string | null;
  payloadGzip: Uint8Array | null;
  status: "fetched" | "invalid" | "compared" | "published" | "recorded";
  compare: NagoyaCompareResult | null;
  published: { datasetVersion: string; lastChangedAt: string } | null;
}

export type ConditionalWriteResult = "written" | "conflict";

/** Rows stored for the Aichi weather bulletin (`jmaWeatherSnapshots`). */
export interface WeatherBulletinRecord {
  recordKey: string;
  sourceUrl: string;
  publishedAt: string;
  reportDateTime: string;
  infoType: string;
  invalidated: boolean;
  storedAt: string;
  processedUrls: string[];
  payloadGzip: Uint8Array;
}

/** Earthquake / tsunami / volcano bulletin row (`jmaEqvolBulletins/eqvol:<file>`). */
export interface EqvolBulletinRecord {
  recordKey: string;
  sourceUrl: string;
  bulletinType: string;
  publishedAt: string;
  reportDateTime: string;
  infoType: string;
  invalidated: boolean;
  ignored: boolean;
  aichiMentioned: boolean | null;
  storedAt: string;
  payloadGzip: Uint8Array;
}

/**
 * Durable warning handoff (`warningOutbox`), keyed by `jma:<sourceUrl>`.
 * `pending` rows are delivered to FCM by `/jobs/outbox/deliver` and end as
 * `sent` or `skipped`; `excluded` (training/test) rows are never delivered.
 */
export interface OutboxEntry {
  deliveryKey: string;
  sourceUrl: string;
  publishedAt: string;
  bulletinType: string;
  deliveryStatus: OutboxStatus;
  /** When the row left `pending` (ISO), or "" while pending/excluded. */
  acknowledgedAt: string;
  createdAt: string;
  payloadGzip: Uint8Array;
  /** Delivery claim held by one deliver call; "" when unclaimed. */
  claimId?: string;
  /** When the claim was taken (ISO); "" when unclaimed. */
  claimedAt?: string;
  /** Short machine-readable outcome, e.g. `fcm:<message id>` or `skipped:stale`. */
  deliveryNote?: string;
}

export type OutboxStatus = "pending" | "excluded" | "sent" | "skipped";

/**
 * True when a deliver call may claim the entry: still pending and not held by
 * a claim taken at or after `liveClaimAfter` (ISO timestamps compare as text).
 */
export function isClaimable(
  entry: Pick<OutboxEntry, "deliveryStatus" | "claimId" | "claimedAt">,
  liveClaimAfter: string,
): boolean {
  return (
    entry.deliveryStatus === "pending" &&
    (!entry.claimId || !entry.claimedAt || entry.claimedAt < liveClaimAfter)
  );
}

export interface JobsRepository {
  getNagoyaDataset(recordKey: string): Promise<NagoyaDatasetRecord | null>;
  saveNagoyaRun(run: NagoyaJobRun): Promise<void>;
  getNagoyaRun(runId: string): Promise<NagoyaJobRun | null>;
  updateNagoyaRun(
    runId: string,
    patch: Partial<Pick<NagoyaJobRun, "status" | "compare" | "published">>,
  ): Promise<void>;
  /**
   * Atomically save `snapshot` and replace `current` when the current row's
   * datasetVersion still equals `expectedBaseVersion` (null = no row).
   */
  publishNagoyaDataset(input: {
    current: NagoyaDatasetRecord;
    snapshot: NagoyaDatasetRecord;
    expectedBaseVersion: string | null;
  }): Promise<ConditionalWriteResult>;
  /** Atomically update lastCheckedAt/lastStatus if the version is unchanged. */
  recordNagoyaUnchanged(input: {
    recordKey: string;
    expectedVersion: string;
    lastCheckedAt: string;
  }): Promise<ConditionalWriteResult>;

  getWeatherCurrent(recordKey: string): Promise<WeatherBulletinRecord | null>;
  /** Save the bulletin snapshot and replace the current row in one batch. */
  storeWeatherBulletin(input: {
    currentKey: string;
    record: WeatherBulletinRecord;
  }): Promise<void>;

  /** Return which of the given `eqvol:<file>` keys are already stored. */
  findStoredEqvolKeys(recordKeys: string[]): Promise<Set<string>>;
  storeEqvolBulletin(record: EqvolBulletinRecord): Promise<void>;
  /** Newest stored bulletins first (by publishedAt), for the public alerts view. */
  listRecentEqvolBulletins(limit: number): Promise<EqvolBulletinRecord[]>;

  /** Create the entry unless its deliveryKey exists. Returns true when created. */
  enqueueOutbox(entry: OutboxEntry): Promise<boolean>;
  countPendingOutbox(): Promise<number>;
  /** Pending entries created at or after `createdFrom`, oldest `createdAt` first. */
  listPendingOutbox(input: {
    createdFrom: string;
    limit: number;
  }): Promise<OutboxEntry[]>;
  /**
   * Atomically mark up to `limit` pending entries created before
   * `createdBefore` as `skipped` (note `skipped:stale`), leaving entries with
   * a live claim (claimedAt ≥ `liveClaimAfter`) alone. Returns the count.
   */
  skipStalePendingOutbox(input: {
    createdBefore: string;
    liveClaimAfter: string;
    acknowledgedAt: string;
    limit: number;
  }): Promise<number>;
  /**
   * Atomically claim a pending entry for delivery. Succeeds only when the row
   * is still pending and unclaimed, or its claim is older than
   * `liveClaimAfter` (an abandoned attempt). Returns true when claimed.
   */
  claimOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    claimedAt: string;
    liveClaimAfter: string;
  }): Promise<boolean>;
  /**
   * Atomically finish a claimed entry (`sent` or `skipped`). Returns false
   * when the row is no longer pending or the claim was taken over.
   */
  completeOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    deliveryStatus: "sent" | "skipped";
    acknowledgedAt: string;
    deliveryNote: string;
  }): Promise<boolean>;
  /** Drop our claim so a later run can retry; the row stays pending. */
  releaseOutboxClaim(input: {
    deliveryKey: string;
    claimId: string;
  }): Promise<void>;
}
