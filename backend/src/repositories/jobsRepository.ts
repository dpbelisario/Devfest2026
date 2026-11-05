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

/** Durable warning handoff (`warningOutbox`), keyed by `jma:<sourceUrl>`. */
export interface OutboxEntry {
  deliveryKey: string;
  sourceUrl: string;
  publishedAt: string;
  bulletinType: string;
  deliveryStatus: "pending" | "excluded" | "acknowledged";
  acknowledgedAt: string;
  createdAt: string;
  payloadGzip: Uint8Array;
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

  /** Create the entry unless its deliveryKey exists. Returns true when created. */
  enqueueOutbox(entry: OutboxEntry): Promise<boolean>;
  countPendingOutbox(): Promise<number>;
}
