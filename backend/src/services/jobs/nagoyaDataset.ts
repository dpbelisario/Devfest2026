import { parse } from "csv-parse/sync";
import type {
  NagoyaDatasetRecord,
  NagoyaJobRun,
} from "../../repositories/jobsRepository.js";
import type { JobsContext } from "./context.js";
import { JobError } from "./errors.js";
import { encodePayload, sha256Hex } from "./payloadCodec.js";

/** Fixed import configuration (n8n "Import configuration" node). */
export const nagoyaSource = {
  municipalityCode: "23100",
  municipalityName: "Nagoya City, Aichi",
  sourceUrl:
    "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/23100_2.csv",
  sourceAttribution: "国土地理院 指定緊急避難場所データ（名古屋市登録情報）",
  currentKey: "current:23100",
  timeoutMs: 30_000,
} as const;

const runRetentionMs = 7 * 24 * 60 * 60 * 1000;

const hazards: Record<string, string> = {
  洪水: "flood",
  "崖崩れ、土石流及び地滑り": "landslide",
  高潮: "stormSurge",
  地震: "earthquake",
  津波: "tsunami",
  大規模な火事: "fire",
  内水氾濫: "inlandFlood",
  火山現象: "volcano",
};
const requiredColumns = [
  "共通ID",
  "施設・場所名",
  "住所",
  "緯度",
  "経度",
  ...Object.keys(hazards),
];

/** Normalised designated emergency site. Opening status is never inferred. */
export interface NagoyaSite {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  disasters: string[];
  kind: "emergencySite";
  source: string;
  verifiedAt: null;
  isDemo: false;
  openingStatus: "unknown";
  remarks: string;
}

export interface NagoyaValidation {
  valid: boolean;
  /** First 20 messages. */
  errors: string[];
  errorCount: number;
  recordCount: number;
  /** JSON of sorted sites; empty string when invalid (as in n8n). */
  payloadJson: string;
}

/** Parse the GSI CSV (UTF-8, optional BOM, header row) into row objects. */
export function parseNagoyaCsv(csv: string): Record<string, string>[] {
  const rows: unknown = parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is Record<string, string> =>
      typeof row === "object" && row !== null && Object.keys(row).length > 0,
  );
}

/**
 * Port of the n8n "Validate complete dataset" node: the whole dataset is
 * rejected when any row has a missing column, missing/duplicate ID, missing
 * name, invalid coordinates, unknown hazard flag or no designated hazard.
 */
export function validateNagoyaRows(
  rows: Record<string, string>[],
): NagoyaValidation {
  const errors: string[] = [];
  const sites: NagoyaSite[] = [];
  const ids = new Set<string>();
  if (rows.length === 0 || rows.length > 10000)
    errors.push("Unexpected record count; expected 1–10000.");
  rows.forEach((row, index) => {
    const label = `Row ${index + 1}`;
    for (const key of requiredColumns)
      if (!(key in row)) errors.push(`${label}: missing column ${key}`);
    const field = (key: string) => String(row[key] ?? "").trim();
    const id = field("共通ID");
    const name = field("施設・場所名");
    const latitudeText = field("緯度");
    const longitudeText = field("経度");
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!id || ids.has(id))
      errors.push(`${label}: missing or duplicate common ID.`);
    ids.add(id);
    if (!name) errors.push(`${label}: missing name.`);
    if (
      !latitudeText ||
      !longitudeText ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    )
      errors.push(`${label}: invalid coordinates.`);
    const disasters: string[] = [];
    for (const [column, code] of Object.entries(hazards)) {
      const flag = field(column);
      if (flag === "1") disasters.push(code);
      else if (flag !== "")
        errors.push(`${label}: unknown hazard flag in ${column}`);
    }
    if (!disasters.length) errors.push(`${label}: no designated hazard.`);
    sites.push({
      id,
      name,
      address: field("住所"),
      latitude,
      longitude,
      disasters,
      kind: "emergencySite",
      source: "GSI / Nagoya City designated emergency evacuation sites",
      verifiedAt: null,
      isDemo: false,
      openingStatus: "unknown",
      remarks: field("備考"),
    });
  });
  sites.sort((a, b) => a.id.localeCompare(b.id));
  const valid = errors.length === 0;
  return {
    valid,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    recordCount: rows.length,
    payloadJson: valid ? JSON.stringify(sites) : "",
  };
}

/** Download, validate and stage a candidate. Invalid data is staged without payload. */
export async function fetchNagoyaDataset(context: JobsContext) {
  const startedAt = context.now();
  const runId = context.newRunId();
  const csv = await context.fetchText(nagoyaSource.sourceUrl, {
    timeoutMs: nagoyaSource.timeoutMs,
  });
  let validation: NagoyaValidation;
  try {
    validation = validateNagoyaRows(parseNagoyaCsv(csv));
  } catch (error) {
    console.warn("Nagoya CSV could not be parsed", error);
    validation = {
      valid: false,
      errors: ["CSV could not be parsed."],
      errorCount: 1,
      recordCount: 0,
      payloadJson: "",
    };
  }
  const run: NagoyaJobRun = {
    runId,
    municipalityCode: nagoyaSource.municipalityCode,
    createdAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + runRetentionMs),
    lastCheckedAt: startedAt.toISOString(),
    valid: validation.valid,
    recordCount: validation.recordCount,
    errorCount: validation.errorCount,
    errors: validation.errors,
    datasetVersion: `nagoya-${runId}`,
    payloadSha256: validation.valid ? sha256Hex(validation.payloadJson) : null,
    payloadGzip: validation.valid
      ? encodePayload(JSON.parse(validation.payloadJson))
      : null,
    status: validation.valid ? "fetched" : "invalid",
    compare: null,
    published: null,
  };
  await context.repository.saveNagoyaRun(run);
  if (!validation.valid)
    console.warn("Nagoya dataset rejected; previous snapshot preserved", {
      runId,
      errorCount: validation.errorCount,
      errors: validation.errors,
    });
  return {
    runId,
    valid: validation.valid,
    recordCount: validation.recordCount,
    errorCount: validation.errorCount,
    errors: validation.errors,
  };
}

async function requireRun(context: JobsContext, runId: string) {
  const run = await context.repository.getNagoyaRun(runId);
  if (!run) throw new JobError("RUN_NOT_FOUND", 404, `Unknown run ${runId}`);
  return run;
}

/**
 * Compare a staged candidate with the current dataset. A missing current row
 * is treated as the initial state (changed). Throws DATASET_SHRANK when the
 * candidate has fewer than half of the current records. Idempotent per run.
 */
export async function compareNagoyaDataset(
  context: JobsContext,
  runId: string,
) {
  const run = await requireRun(context, runId);
  if (!run.valid || !run.payloadSha256)
    throw new JobError("DATASET_INVALID", 409, `Run ${runId} is invalid`);
  if (run.compare) return compareResponse(runId, run.compare.changed);
  const current = await context.repository.getNagoyaDataset(
    nagoyaSource.currentKey,
  );
  if (
    current &&
    current.recordCount > 0 &&
    run.recordCount < current.recordCount * 0.5
  )
    throw new JobError(
      "DATASET_SHRANK",
      409,
      `Dataset shrank from ${current.recordCount} to ${run.recordCount}`,
    );
  const changed = !current || run.payloadSha256 !== current.payloadSha256;
  await context.repository.updateNagoyaRun(runId, {
    status: "compared",
    compare: { changed, baseVersion: current?.datasetVersion ?? null },
  });
  return compareResponse(runId, changed);
}

function compareResponse(runId: string, changed: boolean) {
  return {
    runId,
    changed,
    status: changed ? ("changed" as const) : ("unchanged" as const),
  };
}

/** Save a versioned snapshot and make it current. Idempotent per run. */
export async function publishNagoyaDataset(
  context: JobsContext,
  runId: string,
) {
  const run = await requireRun(context, runId);
  if (run.published) return { ...run.published, recordCount: run.recordCount };
  if (
    !run.compare?.changed ||
    run.status !== "compared" ||
    !run.payloadGzip ||
    !run.payloadSha256
  )
    throw new JobError(
      "RUN_NOT_PUBLISHABLE",
      409,
      `Run ${runId} has not been compared as changed`,
    );
  const base: Omit<NagoyaDatasetRecord, "recordKey" | "lastStatus"> = {
    municipalityCode: run.municipalityCode,
    municipalityName: nagoyaSource.municipalityName,
    datasetVersion: run.datasetVersion,
    recordCount: run.recordCount,
    payloadSha256: run.payloadSha256,
    payloadGzip: run.payloadGzip,
    sourceUrl: nagoyaSource.sourceUrl,
    sourceAttribution: nagoyaSource.sourceAttribution,
    lastCheckedAt: run.lastCheckedAt,
    lastChangedAt: run.lastCheckedAt,
    entryType: "designation_only",
  };
  const result = await context.repository.publishNagoyaDataset({
    expectedBaseVersion: run.compare.baseVersion,
    snapshot: {
      ...base,
      recordKey: `snapshot:${run.municipalityCode}:${run.runId}`,
      lastStatus: "snapshot_saved",
    },
    current: {
      ...base,
      recordKey: nagoyaSource.currentKey,
      lastStatus: "published",
    },
  });
  if (result === "conflict")
    throw new JobError(
      "CONCURRENT_UPDATE",
      409,
      `Current dataset changed since run ${runId} was compared`,
    );
  const published = {
    datasetVersion: run.datasetVersion,
    lastChangedAt: run.lastCheckedAt,
  };
  await context.repository.updateNagoyaRun(runId, {
    status: "published",
    published,
  });
  return { ...published, recordCount: run.recordCount };
}

/** Record a successful check that found identical content. Idempotent. */
export async function recordNagoyaUnchanged(
  context: JobsContext,
  runId: string,
) {
  const run = await requireRun(context, runId);
  if (!run.compare || run.compare.changed || !run.compare.baseVersion)
    throw new JobError(
      "RUN_NOT_UNCHANGED",
      409,
      `Run ${runId} was not compared as unchanged`,
    );
  const result = await context.repository.recordNagoyaUnchanged({
    recordKey: nagoyaSource.currentKey,
    expectedVersion: run.compare.baseVersion,
    lastCheckedAt: run.lastCheckedAt,
  });
  if (result === "conflict")
    throw new JobError(
      "CONCURRENT_UPDATE",
      409,
      `Current dataset changed since run ${runId} was compared`,
    );
  if (run.status !== "recorded")
    await context.repository.updateNagoyaRun(runId, { status: "recorded" });
  return { lastCheckedAt: run.lastCheckedAt };
}
