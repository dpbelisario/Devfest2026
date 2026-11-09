import {
  isClaimable,
  type ConditionalWriteResult,
  type EqvolBulletinRecord,
  type JobsRepository,
  type NagoyaDatasetRecord,
  type NagoyaJobRun,
  type OutboxEntry,
  type WeatherBulletinRecord,
} from "./jobsRepository.js";

/**
 * Process-local repository for tests and local smoke runs. Not suitable for
 * Cloud Run: state disappears on restart and is not shared across instances.
 * `operations` records write order so tests can assert sequencing.
 */
export class MemoryJobsRepository implements JobsRepository {
  readonly nagoyaDatasets = new Map<string, NagoyaDatasetRecord>();
  readonly nagoyaRuns = new Map<string, NagoyaJobRun>();
  readonly weather = new Map<string, WeatherBulletinRecord>();
  readonly eqvol = new Map<string, EqvolBulletinRecord>();
  readonly outbox = new Map<string, OutboxEntry>();
  readonly operations: string[] = [];

  async getNagoyaDataset(recordKey: string) {
    return clone(this.nagoyaDatasets.get(recordKey) ?? null);
  }

  async saveNagoyaRun(run: NagoyaJobRun) {
    this.operations.push(`nagoyaRun:${run.runId}`);
    this.nagoyaRuns.set(run.runId, clone(run));
  }

  async getNagoyaRun(runId: string) {
    return clone(this.nagoyaRuns.get(runId) ?? null);
  }

  async updateNagoyaRun(
    runId: string,
    patch: Partial<Pick<NagoyaJobRun, "status" | "compare" | "published">>,
  ) {
    const run = this.nagoyaRuns.get(runId);
    if (!run) throw new Error(`Run ${runId} missing`);
    this.nagoyaRuns.set(runId, { ...run, ...clone(patch) });
  }

  async publishNagoyaDataset(input: {
    current: NagoyaDatasetRecord;
    snapshot: NagoyaDatasetRecord;
    expectedBaseVersion: string | null;
  }): Promise<ConditionalWriteResult> {
    const existing = this.nagoyaDatasets.get(input.current.recordKey);
    if ((existing?.datasetVersion ?? null) !== input.expectedBaseVersion)
      return "conflict";
    this.operations.push(`nagoyaDataset:${input.snapshot.recordKey}`);
    this.nagoyaDatasets.set(input.snapshot.recordKey, clone(input.snapshot));
    this.operations.push(`nagoyaDataset:${input.current.recordKey}`);
    this.nagoyaDatasets.set(input.current.recordKey, clone(input.current));
    return "written";
  }

  async recordNagoyaUnchanged(input: {
    recordKey: string;
    expectedVersion: string;
    lastCheckedAt: string;
  }): Promise<ConditionalWriteResult> {
    const existing = this.nagoyaDatasets.get(input.recordKey);
    if (!existing || existing.datasetVersion !== input.expectedVersion)
      return "conflict";
    this.nagoyaDatasets.set(input.recordKey, {
      ...existing,
      lastCheckedAt: input.lastCheckedAt,
      lastStatus: "unchanged",
    });
    return "written";
  }

  async getWeatherCurrent(recordKey: string) {
    return clone(this.weather.get(recordKey) ?? null);
  }

  async storeWeatherBulletin(input: {
    currentKey: string;
    record: WeatherBulletinRecord;
  }) {
    this.operations.push(`weather:${input.record.recordKey}`);
    this.weather.set(input.record.recordKey, clone(input.record));
    this.weather.set(input.currentKey, {
      ...clone(input.record),
      recordKey: input.currentKey,
    });
  }

  async findStoredEqvolKeys(recordKeys: string[]) {
    return new Set(recordKeys.filter((key) => this.eqvol.has(key)));
  }

  async storeEqvolBulletin(record: EqvolBulletinRecord) {
    this.operations.push(`eqvol:${record.sourceUrl}`);
    this.eqvol.set(record.recordKey, clone(record));
  }

  async listRecentEqvolBulletins(limit: number) {
    return [...this.eqvol.values()]
      .sort(
        (a, b) =>
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          b.recordKey.localeCompare(a.recordKey),
      )
      .slice(0, limit)
      .map((record) => clone(record));
  }

  async enqueueOutbox(entry: OutboxEntry) {
    if (this.outbox.has(entry.deliveryKey)) return false;
    this.operations.push(`outbox:${entry.deliveryKey}`);
    this.outbox.set(entry.deliveryKey, clone(entry));
    return true;
  }

  async countPendingOutbox() {
    return [...this.outbox.values()].filter(
      (entry) => entry.deliveryStatus === "pending",
    ).length;
  }

  async listPendingOutbox(input: { createdFrom: string; limit: number }) {
    return [...this.outbox.values()]
      .filter(
        (entry) =>
          entry.deliveryStatus === "pending" &&
          entry.createdAt >= input.createdFrom,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, input.limit)
      .map((entry) => clone(entry));
  }

  async skipStalePendingOutbox(input: {
    createdBefore: string;
    liveClaimAfter: string;
    acknowledgedAt: string;
    limit: number;
  }) {
    const stale = [...this.outbox.values()]
      .filter(
        (entry) =>
          entry.deliveryStatus === "pending" &&
          entry.createdAt < input.createdBefore,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, input.limit)
      .filter((entry) => isClaimable(entry, input.liveClaimAfter));
    for (const entry of stale) {
      this.operations.push(`outbox-skip:${entry.deliveryKey}`);
      this.outbox.set(entry.deliveryKey, {
        ...entry,
        deliveryStatus: "skipped",
        acknowledgedAt: input.acknowledgedAt,
        deliveryNote: "skipped:stale",
        claimId: "",
        claimedAt: "",
      });
    }
    return stale.length;
  }

  async claimOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    claimedAt: string;
    liveClaimAfter: string;
  }) {
    const entry = this.outbox.get(input.deliveryKey);
    if (!entry || !isClaimable(entry, input.liveClaimAfter)) return false;
    this.outbox.set(input.deliveryKey, {
      ...entry,
      claimId: input.claimId,
      claimedAt: input.claimedAt,
    });
    return true;
  }

  async completeOutboxEntry(input: {
    deliveryKey: string;
    claimId: string;
    deliveryStatus: "sent" | "skipped";
    acknowledgedAt: string;
    deliveryNote: string;
  }) {
    const entry = this.outbox.get(input.deliveryKey);
    if (
      !entry ||
      entry.deliveryStatus !== "pending" ||
      entry.claimId !== input.claimId
    )
      return false;
    this.operations.push(`outbox-${input.deliveryStatus}:${entry.deliveryKey}`);
    this.outbox.set(input.deliveryKey, {
      ...entry,
      deliveryStatus: input.deliveryStatus,
      acknowledgedAt: input.acknowledgedAt,
      deliveryNote: input.deliveryNote,
    });
    return true;
  }

  async releaseOutboxClaim(input: { deliveryKey: string; claimId: string }) {
    const entry = this.outbox.get(input.deliveryKey);
    if (!entry || entry.claimId !== input.claimId) return;
    this.outbox.set(input.deliveryKey, {
      ...entry,
      claimId: "",
      claimedAt: "",
    });
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
