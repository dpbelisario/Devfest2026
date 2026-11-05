import type { WeatherBulletinRecord } from "../../repositories/jobsRepository.js";
import type { JobsContext } from "./context.js";
import { invalidUpstream } from "./errors.js";
import { prepareHandoff } from "./outbox.js";
import { encodePayload } from "./payloadCodec.js";
import { attribute, get, list, parseXml, text } from "./xml.js";

export const jmaWeatherFeeds = {
  recent: "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
  recovery: "https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml",
} as const;

/** Only Aichi (230000) VPWW53 bulletins on the official JMA data path. */
export const weatherSourcePattern =
  /^https:\/\/www\.data\.jma\.go\.jp\/developer\/xml\/data\/[A-Za-z0-9_]+_VPWW53_230000\.xml$/;

const weatherCurrentKey = "current:230000";
const nagoyaAreaCode = "2310000";
const weatherTimeoutMs = 30_000;

export interface WeatherCandidate {
  sourceUrl: string;
  publishedAt: string;
  title: string;
}

/** Previously stored state used for deduplication (null before the first bulletin). */
export interface WeatherSeenState {
  sourceUrl: string;
  publishedAt: string;
  processedUrls: string[];
}

/** Port of "Select Aichi bulletins": official Aichi links, newest first. */
export function selectAichiBulletins(feedDocument: Record<string, unknown>): {
  feedUpdatedAt: string;
  candidates: WeatherCandidate[];
} {
  const feed = feedDocument.feed;
  if (!feed || !Number.isFinite(Date.parse(text(get(feed, "updated")))))
    throw invalidUpstream("Invalid JMA Atom feed");
  const candidates = list(get(feed, "entry"))
    .flatMap((entry) => {
      const sourceUrl = list(get(entry, "link"))
        .map((link) => attribute(link, "href"))
        .find(
          (url): url is string =>
            typeof url === "string" && weatherSourcePattern.test(url),
        );
      if (
        !sourceUrl ||
        text(get(entry, "author", "name")) !== "名古屋地方気象台"
      )
        return [];
      const publishedAt = text(get(entry, "updated"));
      if (!Number.isFinite(Date.parse(publishedAt)))
        throw invalidUpstream("Invalid bulletin timestamp");
      return [{ sourceUrl, publishedAt, title: text(get(entry, "title")) }];
    })
    .sort(
      (a, b) =>
        Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
        b.sourceUrl.localeCompare(a.sourceUrl),
    );
  return { feedUpdatedAt: text(get(feed, "updated")), candidates };
}

/**
 * Port of "Skip seen or older bulletin": only the latest candidate is
 * considered, and only when unseen and not older than the stored bulletin.
 * A missing state means nothing has been stored yet.
 */
export function selectUnseenWeather(
  current: WeatherSeenState | null,
  candidates: WeatherCandidate[],
): (WeatherCandidate & { processedUrls: string[] }) | null {
  const seen = new Set(current?.processedUrls ?? []);
  if (current?.sourceUrl) seen.add(current.sourceUrl);
  const candidate = candidates[0];
  if (!candidate || seen.has(candidate.sourceUrl)) return null;
  if (
    current?.publishedAt &&
    Date.parse(candidate.publishedAt) < Date.parse(current.publishedAt)
  )
    return null;
  return { ...candidate, processedUrls: [...seen].slice(-199) };
}

export interface WeatherKind {
  code: string;
  name: string;
  status: string;
  details: unknown;
}

export interface WeatherMunicipality {
  areaCode: string;
  areaName: string;
  kinds: WeatherKind[];
}

/** Normalised bulletin payload stored and handed off (n8n payloadJson shape). */
export interface WeatherPayload {
  source: "Japan Meteorological Agency";
  sourceUrl: string;
  publishedAt: string;
  reportDateTime: string;
  receivedAt: string;
  infoType: string;
  invalidated: boolean;
  interpretation: "bulletin_cancelled_status_unknown" | "raw_official_statuses";
  headline: string;
  municipalities: WeatherMunicipality[];
  nagoya: WeatherMunicipality | null;
  processedUrls: string[];
  control: unknown;
  head: unknown;
  body: unknown;
  backendConnected: false;
  notificationsSent: false;
  isDemo: false;
  [key: string]: unknown;
}

/**
 * Port of "Validate municipality statuses". Returns null for training/test
 * reports (control status other than 通常), which are not stored. A
 * cancellation (取消) yields no municipalities and `nagoya: null`: status is
 * unknown, never an all-clear. Throws INVALID_UPSTREAM_DATA on malformed data.
 */
export function normalizeWeatherReport(
  document: Record<string, unknown>,
  candidate: {
    sourceUrl: string;
    publishedAt: string;
    processedUrls: string[];
  },
  storedAt: string,
): WeatherPayload | null {
  const report = document.Report;
  const control = get(report, "Control");
  const head = get(report, "Head");
  if (!control || !head) throw invalidUpstream("Missing JMA report headers");
  if (text(get(control, "Status")) !== "通常") return null;
  if (
    text(get(control, "PublishingOffice")) !== "名古屋地方気象台" ||
    text(get(head, "Title")) !== "愛知県気象警報・注意報"
  )
    throw invalidUpstream("Unexpected warning region or publisher");
  const reportDateTime = text(get(head, "ReportDateTime"));
  if (!Number.isFinite(Date.parse(reportDateTime)))
    throw invalidUpstream("Invalid report date");
  const infoType = text(get(head, "InfoType"));
  if (!["発表", "訂正", "取消"].includes(infoType))
    throw invalidUpstream(`Unsupported bulletin InfoType: ${infoType}`);
  const invalidated = infoType === "取消";
  const body = get(report, "Body");
  const municipal = list(get(body, "Warning")).find(
    (warning) => attribute(warning, "type") === "気象警報・注意報（市町村等）",
  );
  if (!invalidated && !municipal)
    throw invalidUpstream("Missing municipality warning section");
  const municipalities: WeatherMunicipality[] = invalidated
    ? []
    : list(get(municipal, "Item")).map((item) => {
        const areaCode = text(get(item, "Area", "Code"));
        const areaName = text(get(item, "Area", "Name"));
        if (!/^23\d{5}$/.test(areaCode) || !areaName)
          throw invalidUpstream("Invalid Aichi municipality");
        const kinds = list(get(item, "Kind")).map((kind) => {
          const status = text(get(kind, "Status"));
          const code = text(get(kind, "Code"));
          const name = text(get(kind, "Name"));
          if (!status) throw invalidUpstream("Missing warning status");
          if (status !== "発表警報・注意報はなし" && (!code || !name))
            throw invalidUpstream("Missing warning kind");
          return { code, name, status, details: kind };
        });
        if (!kinds.length)
          throw invalidUpstream("Empty municipality warning status");
        return { areaCode, areaName, kinds };
      });
  if (
    !invalidated &&
    !municipalities.some(
      (m) => m.areaCode === nagoyaAreaCode && m.areaName === "名古屋市",
    )
  )
    throw invalidUpstream("Nagoya status missing");
  if (
    new Set(municipalities.map((m) => m.areaCode)).size !==
    municipalities.length
  )
    throw invalidUpstream("Duplicate municipality");
  return {
    source: "Japan Meteorological Agency",
    sourceUrl: candidate.sourceUrl,
    publishedAt: candidate.publishedAt,
    reportDateTime,
    receivedAt: storedAt,
    infoType,
    invalidated,
    interpretation: invalidated
      ? "bulletin_cancelled_status_unknown"
      : "raw_official_statuses",
    headline: text(get(head, "Headline", "Text")),
    municipalities,
    nagoya: municipalities.find((m) => m.areaCode === nagoyaAreaCode) ?? null,
    processedUrls: [...candidate.processedUrls, candidate.sourceUrl].slice(
      -200,
    ),
    control,
    head,
    body: body ?? null,
    backendConnected: false,
    notificationsSent: false,
    isDemo: false,
  };
}

async function readSeenState(context: JobsContext) {
  return context.repository.getWeatherCurrent(weatherCurrentKey);
}

/** Return the latest unseen Aichi bulletin from the recent or recovery feed. */
export async function checkWeather(
  context: JobsContext,
  mode: keyof typeof jmaWeatherFeeds,
): Promise<{ candidate: WeatherCandidate | null }> {
  const feed = parseXml(
    await context.fetchText(jmaWeatherFeeds[mode], {
      timeoutMs: weatherTimeoutMs,
    }),
  );
  const { candidates } = selectAichiBulletins(feed);
  const selected = selectUnseenWeather(
    await readSeenState(context),
    candidates,
  );
  if (!selected) return { candidate: null };
  return {
    candidate: {
      sourceUrl: selected.sourceUrl,
      publishedAt: selected.publishedAt,
      title: selected.title,
    },
  };
}

/**
 * Download, validate and store one candidate. The outbox handoff is queued
 * before the bulletin is marked stored. Already-seen or older candidates and
 * training/test reports return `stored: false` without writes.
 */
export async function processWeather(
  context: JobsContext,
  candidate: WeatherCandidate,
) {
  const notStored = (infoType: string | null) => ({
    stored: false,
    infoType,
    invalidated: false,
    municipalityCount: 0,
    nagoyaKinds: [],
    queued: false,
  });
  const selected = selectUnseenWeather(await readSeenState(context), [
    candidate,
  ]);
  if (!selected) return notStored(null);
  const document = parseXml(
    await context.fetchText(selected.sourceUrl, {
      timeoutMs: weatherTimeoutMs,
    }),
  );
  const storedAt = context.now().toISOString();
  const payload = normalizeWeatherReport(document, selected, storedAt);
  if (!payload) {
    console.info("Weather bulletin excluded (training/test)", {
      sourceUrl: selected.sourceUrl,
    });
    return notStored(text(get(document, "Report", "Head", "InfoType")) || null);
  }
  const handoff = prepareHandoff(
    {
      sourceUrl: selected.sourceUrl,
      publishedAt: selected.publishedAt,
      bulletin: payload,
    },
    storedAt,
  );
  // Create-if-absent: a retried request finds the entry from its first attempt.
  await context.repository.enqueueOutbox(handoff);
  const queued = handoff.deliveryStatus === "pending";
  const record: WeatherBulletinRecord = {
    recordKey: `bulletin:${selected.sourceUrl.split("/").pop() ?? ""}`,
    sourceUrl: selected.sourceUrl,
    publishedAt: selected.publishedAt,
    reportDateTime: payload.reportDateTime,
    infoType: payload.infoType,
    invalidated: payload.invalidated,
    storedAt,
    processedUrls: payload.processedUrls,
    payloadGzip: encodePayload(payload),
  };
  await context.repository.storeWeatherBulletin({
    currentKey: weatherCurrentKey,
    record,
  });
  return {
    stored: true,
    infoType: payload.infoType,
    invalidated: payload.invalidated,
    municipalityCount: payload.municipalities.length,
    nagoyaKinds: (payload.nagoya?.kinds ?? []).map(
      ({ code, name, status }) => ({ code, name, status }),
    ),
    queued,
  };
}
