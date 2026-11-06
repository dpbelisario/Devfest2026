import { z } from "zod";
import type {
  EqvolBulletinRecord,
  JobsRepository,
  NagoyaDatasetRecord,
} from "../repositories/jobsRepository.js";
import { decodePayload } from "./jobs/payloadCodec.js";

/**
 * Read side of the ingestion jobs for the public app: Nagoya designated
 * emergency evacuation sites (GSI) and the latest JMA bulletins, as written to
 * Firestore by the Cloud Workflows `nagoya-import` and `jma-warnings`.
 *
 * Nothing here infers opening status or an all-clear. Sites are official
 * designations only (`openingStatus: "unknown"`); weather statuses are the raw
 * official status strings.
 */

/** Hazard codes used by the GSI dataset (see services/jobs/nagoyaDataset.ts). */
export const siteDisasters = [
  "flood",
  "landslide",
  "stormSurge",
  "earthquake",
  "tsunami",
  "fire",
  "inlandFlood",
  "volcano",
] as const;
export type SiteDisaster = (typeof siteDisasters)[number];

const storedSiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  disasters: z.array(z.string()),
  remarks: z.string().default(""),
});
export type LiveSite = z.infer<typeof storedSiteSchema>;

export interface LiveSiteResult extends LiveSite {
  kind: "emergencySite";
  openingStatus: "unknown";
  distanceMeters: number;
  /** Initial great-circle bearing from the query point, 0–360 (north = 0). */
  bearingDegrees: number;
}

export interface DatasetInfo {
  municipalityName: string;
  datasetVersion: string;
  recordCount: number;
  lastCheckedAt: string;
  lastChangedAt: string;
  sourceUrl: string;
  sourceAttribution: string;
}

export interface WeatherKindSummary {
  code: string;
  name: string;
  status: string;
  /** Derived only from the JMA name: 特別警報 > 警報 > 注意報. */
  level: "emergency" | "warning" | "advisory" | "other";
  /** True when the official status is 発表 (issued) or 継続 (continued). */
  inEffect: boolean;
}

export interface WeatherSummary {
  headline: string;
  reportDateTime: string;
  publishedAt: string;
  infoType: string;
  invalidated: boolean;
  /** `null` when the bulletin was cancelled: status unknown, not an all-clear. */
  nagoya: { areaName: string; kinds: WeatherKindSummary[] } | null;
  sourceUrl: string;
}

export interface EqvolSummary {
  bulletinType: string;
  headline: string;
  reportDateTime: string;
  publishedAt: string;
  infoType: string;
  invalidated: boolean;
  aichiMentioned: boolean | null;
  sourceUrl: string;
}

export interface AlertsSummary {
  source: "Japan Meteorological Agency";
  weather: WeatherSummary | null;
  bulletins: EqvolSummary[];
  checkedAt: string;
}

const earthRadius = 6_371_000;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Haversine distance in metres. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees, 0–360. */
export function bearingDegrees(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function kindLevel(name: string): WeatherKindSummary["level"] {
  if (name.includes("特別警報")) return "emergency";
  if (name.includes("警報")) return "warning";
  if (name.includes("注意報")) return "advisory";
  return "other";
}

const weatherPayloadSchema = z.object({
  headline: z.string().default(""),
  reportDateTime: z.string(),
  publishedAt: z.string(),
  infoType: z.string(),
  invalidated: z.boolean(),
  sourceUrl: z.string(),
  nagoya: z
    .object({
      areaName: z.string(),
      kinds: z.array(
        z.object({
          code: z.string().default(""),
          name: z.string().default(""),
          status: z.string().default(""),
        }),
      ),
    })
    .nullable(),
});

const eqvolPayloadSchema = z.object({ headline: z.string().default("") });

export interface LiveDataOptions {
  repository: Pick<
    JobsRepository,
    "getNagoyaDataset" | "getWeatherCurrent" | "listRecentEqvolBulletins"
  >;
  now?: () => number;
  /** How long a decoded dataset is reused before Firestore is checked again. */
  datasetTtlMs?: number;
  alertsTtlMs?: number;
}

/** Cached read access to the job outputs. One instance per process. */
export class LiveDataService {
  private readonly now: () => number;
  private readonly datasetTtlMs: number;
  private readonly alertsTtlMs: number;
  private dataset: {
    loadedAt: number;
    info: DatasetInfo;
    sites: LiveSite[];
  } | null = null;
  private datasetLoading: Promise<void> | null = null;
  private alerts: { loadedAt: number; value: AlertsSummary } | null = null;

  constructor(private readonly options: LiveDataOptions) {
    this.now = options.now ?? Date.now;
    this.datasetTtlMs = options.datasetTtlMs ?? 5 * 60_000;
    this.alertsTtlMs = options.alertsTtlMs ?? 30_000;
  }

  private async loadDataset(): Promise<void> {
    const record =
      await this.options.repository.getNagoyaDataset("current:23100");
    if (!record) {
      this.dataset = null;
      return;
    }
    if (this.dataset?.info.datasetVersion !== record.datasetVersion)
      this.dataset = {
        loadedAt: this.now(),
        info: datasetInfo(record),
        sites: decodeSites(record),
      };
    else {
      this.dataset.loadedAt = this.now();
      this.dataset.info = datasetInfo(record);
    }
  }

  /** Current dataset, or null when no import has been published yet. */
  async getDataset(): Promise<{ info: DatasetInfo; sites: LiveSite[] } | null> {
    if (
      !this.dataset ||
      this.now() - this.dataset.loadedAt > this.datasetTtlMs
    ) {
      this.datasetLoading ??= this.loadDataset().finally(() => {
        this.datasetLoading = null;
      });
      // Serve a stale copy while refreshing, unless there is none yet.
      if (this.dataset) this.datasetLoading.catch(() => undefined);
      else await this.datasetLoading;
    }
    return this.dataset
      ? { info: this.dataset.info, sites: this.dataset.sites }
      : null;
  }

  /**
   * Nearest designated sites to a point, optionally only those designated for
   * one hazard. `radiusMeters` bounds the search; results are sorted by
   * straight-line distance (not walking distance).
   */
  async findSites(query: {
    lat: number;
    lng: number;
    limit: number;
    radiusMeters: number;
    disaster?: SiteDisaster;
  }): Promise<{ info: DatasetInfo; sites: LiveSiteResult[] } | null> {
    const dataset = await this.getDataset();
    if (!dataset) return null;
    const origin = { lat: query.lat, lng: query.lng };
    const sites = dataset.sites
      .filter(
        (site) => !query.disaster || site.disasters.includes(query.disaster),
      )
      .map((site) => {
        const point = { lat: site.latitude, lng: site.longitude };
        return {
          ...site,
          kind: "emergencySite" as const,
          openingStatus: "unknown" as const,
          distanceMeters: Math.round(distanceMeters(origin, point)),
          bearingDegrees: Math.round(bearingDegrees(origin, point)),
        };
      })
      .filter((site) => site.distanceMeters <= query.radiusMeters)
      .sort(
        (a, b) =>
          a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id),
      )
      .slice(0, query.limit);
    return { info: dataset.info, sites };
  }

  async getSite(id: string): Promise<LiveSite | null> {
    const dataset = await this.getDataset();
    return dataset?.sites.find((site) => site.id === id) ?? null;
  }

  /** Latest Aichi weather bulletin plus recent earthquake/tsunami/volcano bulletins. */
  async getAlerts(): Promise<AlertsSummary> {
    if (this.alerts && this.now() - this.alerts.loadedAt <= this.alertsTtlMs)
      return this.alerts.value;
    const [weatherRecord, eqvolRecords] = await Promise.all([
      this.options.repository.getWeatherCurrent("current:230000"),
      this.options.repository.listRecentEqvolBulletins(10),
    ]);
    const value: AlertsSummary = {
      source: "Japan Meteorological Agency",
      weather: weatherRecord
        ? summarizeWeather(weatherRecord.payloadGzip)
        : null,
      bulletins: eqvolRecords
        .filter((record) => !record.ignored)
        .slice(0, 5)
        .map(summarizeEqvol),
      checkedAt: new Date(this.now()).toISOString(),
    };
    this.alerts = { loadedAt: this.now(), value };
    return value;
  }
}

function datasetInfo(record: NagoyaDatasetRecord): DatasetInfo {
  return {
    municipalityName: record.municipalityName,
    datasetVersion: record.datasetVersion,
    recordCount: record.recordCount,
    lastCheckedAt: record.lastCheckedAt,
    lastChangedAt: record.lastChangedAt,
    sourceUrl: record.sourceUrl,
    sourceAttribution: record.sourceAttribution,
  };
}

function decodeSites(record: NagoyaDatasetRecord): LiveSite[] {
  const payload = decodePayload(record.payloadGzip);
  const list = Array.isArray(payload)
    ? payload
    : z.object({ sites: z.array(z.unknown()) }).parse(payload).sites;
  return list.map((item) => storedSiteSchema.parse(item));
}

function summarizeWeather(bytes: Uint8Array): WeatherSummary | null {
  const parsed = weatherPayloadSchema.safeParse(decodePayload(bytes));
  if (!parsed.success) return null;
  const payload = parsed.data;
  return {
    headline: payload.headline,
    reportDateTime: payload.reportDateTime,
    publishedAt: payload.publishedAt,
    infoType: payload.infoType,
    invalidated: payload.invalidated,
    sourceUrl: payload.sourceUrl,
    nagoya: payload.nagoya
      ? {
          areaName: payload.nagoya.areaName,
          kinds: payload.nagoya.kinds
            .filter((kind) => kind.name || kind.status)
            .map((kind) => ({
              ...kind,
              level: kindLevel(kind.name),
              inEffect: kind.status === "発表" || kind.status === "継続",
            })),
        }
      : null,
  };
}

function summarizeEqvol(record: EqvolBulletinRecord): EqvolSummary {
  const payload = eqvolPayloadSchema.safeParse(
    decodePayload(record.payloadGzip),
  );
  return {
    bulletinType: record.bulletinType,
    headline: payload.success ? payload.data.headline : "",
    reportDateTime: record.reportDateTime,
    publishedAt: record.publishedAt,
    infoType: record.infoType,
    invalidated: record.invalidated,
    aichiMentioned: record.aichiMentioned,
    sourceUrl: record.sourceUrl,
  };
}
