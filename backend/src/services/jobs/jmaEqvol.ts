import type { EqvolBulletinRecord } from "../../repositories/jobsRepository.js";
import type { JobsContext } from "./context.js";
import { invalidUpstream } from "./errors.js";
import { prepareHandoff } from "./outbox.js";
import { encodePayload } from "./payloadCodec.js";
import { attribute, get, list, parseXml, text } from "./xml.js";

export const jmaEqvolFeeds = {
  recent: "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
  recovery: "https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml",
} as const;

export const eqvolBulletinTypes = ["VXSE53", "VTSE41", "VFVO50"] as const;
export type EqvolBulletinType = (typeof eqvolBulletinTypes)[number];

/** Supported earthquake, tsunami and volcano bulletins on the official data path. */
export const eqvolSourcePattern =
  /^https:\/\/www\.data\.jma\.go\.jp\/developer\/xml\/data\/[A-Za-z0-9]+_[0-9]+_(VXSE53|VTSE41|VFVO50)_[0-9]{6}\.xml$/;

const perTypeLimit = 3;
const eqvolTimeoutMs = 20_000;
const selectionOrder: EqvolBulletinType[] = ["VTSE41", "VFVO50", "VXSE53"];
const expectedInfoKind: Record<EqvolBulletinType, string> = {
  VXSE53: "地震情報",
  VTSE41: "津波警報・注意報・予報",
  VFVO50: "噴火警報・予報",
};

export interface EqvolCandidate {
  sourceUrl: string;
  publishedAt: string;
  bulletinType: EqvolBulletinType;
  title: string;
}

/** Stored-row key, `eqvol:<file name>`. */
export function eqvolRecordKey(sourceUrl: string): string {
  return `eqvol:${sourceUrl.split("/").pop() ?? ""}`;
}

/** Bulletin type encoded in a URL accepted by eqvolSourcePattern. */
export function eqvolTypeOf(sourceUrl: string): EqvolBulletinType | null {
  const match = eqvolSourcePattern.exec(sourceUrl);
  return match ? (match[1] as EqvolBulletinType) : null;
}

/** Supported, de-duplicated feed entries (timestamps not yet validated). */
export function listEqvolEntries(feedDocument: Record<string, unknown>) {
  const feed = feedDocument.feed;
  if (!feed || !Number.isFinite(Date.parse(text(get(feed, "updated")))))
    throw invalidUpstream("Invalid JMA earthquake/volcano Atom feed");
  const unique = new Set<string>();
  const entries: { sourceUrl: string; updated: string; title: string }[] = [];
  for (const entry of list(get(feed, "entry"))) {
    const sourceUrl = list(get(entry, "link"))
      .map((link) => attribute(link, "href"))
      .find(
        (url): url is string =>
          typeof url === "string" && eqvolSourcePattern.test(url),
      );
    if (!sourceUrl || unique.has(sourceUrl)) continue;
    unique.add(sourceUrl);
    entries.push({
      sourceUrl,
      updated: text(get(entry, "updated")),
      title: text(get(entry, "title")),
    });
  }
  return entries;
}

/**
 * Port of "Select unseen earthquake tsunami volcano": unseen entries only, the
 * newest three per type, ordered VTSE41, VFVO50, VXSE53 (at most nine).
 */
export function selectEqvolCandidates(
  entries: { sourceUrl: string; updated: string; title: string }[],
  storedKeys: Set<string>,
): EqvolCandidate[] {
  const byType: Record<EqvolBulletinType, EqvolCandidate[]> = {
    VTSE41: [],
    VFVO50: [],
    VXSE53: [],
  };
  for (const entry of entries) {
    if (storedKeys.has(eqvolRecordKey(entry.sourceUrl))) continue;
    if (!Number.isFinite(Date.parse(entry.updated)))
      throw invalidUpstream("Invalid disaster bulletin timestamp");
    const bulletinType = eqvolTypeOf(entry.sourceUrl);
    if (!bulletinType) continue;
    byType[bulletinType].push({
      sourceUrl: entry.sourceUrl,
      publishedAt: entry.updated,
      bulletinType,
      title: entry.title,
    });
  }
  return selectionOrder.flatMap((type) =>
    byType[type]
      .sort(
        (a, b) =>
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          b.sourceUrl.localeCompare(a.sourceUrl),
      )
      .slice(0, perTypeLimit),
  );
}

/** Normalised bulletin payload stored and handed off (n8n payloadJson shape). */
export interface EqvolPayload {
  source: "Japan Meteorological Agency";
  sourceUrl: string;
  bulletinType: EqvolBulletinType;
  scope: string;
  publishedAt: string;
  reportDateTime: string;
  eventId: string;
  serial: string;
  infoType: string;
  invalidated: boolean;
  ignored: boolean;
  controlStatus: string;
  interpretation:
    | "excluded_training_or_test"
    | "bulletin_cancelled_status_unknown"
    | "raw_official_bulletin";
  aichiMentioned: boolean | null;
  aichiMentionMeaning: string;
  headline: string;
  details: Record<string, unknown> | null;
  control: unknown;
  head: unknown;
  body: unknown;
  backendConnected: false;
  notificationsSent: false;
  [key: string]: unknown;
}

/**
 * Port of "Normalize earthquake tsunami volcano". Training/test reports are
 * kept but marked `ignored`; cancellations keep the event ID with no details
 * and `aichiMentioned: null` (unknown, never an all-clear). `aichiMentioned`
 * is an explicit area mention only, not a risk assessment.
 * Throws INVALID_UPSTREAM_DATA on malformed or mismatched reports.
 */
export function normalizeEqvolReport(
  document: Record<string, unknown>,
  candidate: {
    sourceUrl: string;
    publishedAt: string;
    bulletinType: EqvolBulletinType;
  },
): EqvolPayload {
  const report = document.Report;
  const control = get(report, "Control");
  const head = get(report, "Head");
  if (!control || !head)
    throw invalidUpstream("Missing disaster report headers");
  const type = candidate.bulletinType;
  if (text(get(head, "InfoKind")) !== expectedInfoKind[type])
    throw invalidUpstream("Disaster bulletin type mismatch");
  const reportDateTime = text(get(head, "ReportDateTime"));
  if (!Number.isFinite(Date.parse(reportDateTime)))
    throw invalidUpstream("Invalid disaster report date");
  const status = text(get(control, "Status"));
  if (!["通常", "訓練", "試験"].includes(status))
    throw invalidUpstream("Unknown disaster bulletin control status");
  const ignored = status !== "通常";
  const infoType = text(get(head, "InfoType"));
  if (!["発表", "訂正", "取消"].includes(infoType))
    throw invalidUpstream("Unsupported disaster InfoType");
  const invalidated = infoType === "取消";
  const eventId = text(get(head, "EventID"));
  if (!ignored && !eventId) throw invalidUpstream("Missing disaster event ID");
  const body = get(report, "Body");
  let details: Record<string, unknown> | null = null;
  let aichiMentioned: boolean | null = null;
  if (!ignored && !invalidated) {
    if (!body) throw invalidUpstream("Missing disaster body");
    if (type === "VXSE53") {
      const earthquake = get(body, "Earthquake");
      if (
        !get(earthquake, "Hypocenter", "Area") ||
        !text(get(earthquake, "OriginTime"))
      )
        throw invalidUpstream("Missing earthquake origin or hypocenter");
      const prefectures = list(get(body, "Intensity", "Observation", "Pref"));
      aichiMentioned = prefectures.some(
        (p) =>
          text(get(p, "Code")) === "23" || text(get(p, "Name")) === "愛知県",
      );
      details = {
        kind: "earthquake_information",
        earthquake,
        intensity: get(body, "Intensity") ?? null,
        observedPrefectures: prefectures,
        comments: get(body, "Comments") ?? null,
      };
    } else if (type === "VTSE41") {
      const areas = list(get(body, "Tsunami", "Forecast", "Item")).map(
        (item) => {
          const areaCode = text(get(item, "Area", "Code"));
          const areaName = text(get(item, "Area", "Name"));
          if (
            !areaCode ||
            !areaName ||
            !text(get(item, "Category", "Kind", "Code")) ||
            !text(get(item, "Category", "Kind", "Name"))
          )
            throw invalidUpstream("Incomplete tsunami area or category");
          return {
            areaCode,
            areaName,
            category: get(item, "Category"),
            firstHeight: get(item, "FirstHeight") ?? null,
            maxHeight: get(item, "MaxHeight") ?? null,
          };
        },
      );
      if (!areas.length)
        throw invalidUpstream("Missing tsunami forecast areas");
      aichiMentioned = areas.some((a) => ["390", "391"].includes(a.areaCode));
      details = {
        kind: "tsunami_warning_advisory_forecast",
        areas,
        earthquakes: list(get(body, "Earthquake")),
        comments: get(body, "Comments") ?? null,
      };
    } else {
      const sections = list(get(body, "VolcanoInfo")).map((section) => {
        const sectionType = attribute(section, "type");
        return {
          sectionType: typeof sectionType === "string" ? sectionType : "",
          items: list(get(section, "Item")).map((item) => {
            const areas = list(get(item, "Areas", "Area")).map((area) => ({
              code: text(get(area, "Code")),
              name: text(get(area, "Name")),
              raw: area,
            }));
            if (
              !text(get(item, "Kind", "Code")) ||
              !text(get(item, "Kind", "Name")) ||
              !areas.length ||
              areas.some((a) => !a.code || !a.name)
            )
              throw invalidUpstream("Incomplete volcano kind or area");
            const codeType = attribute(get(item, "Areas"), "codeType");
            return {
              kind: get(item, "Kind"),
              lastKind: get(item, "LastKind") ?? null,
              areaCodeType: typeof codeType === "string" ? codeType : "",
              areas,
            };
          }),
        };
      });
      if (!sections.length || sections.every((s) => !s.items.length))
        throw invalidUpstream("Missing volcano warning sections");
      aichiMentioned = sections.some((s) =>
        s.items.some(
          (i) =>
            i.areaCodeType === "気象・地震・火山情報／市町村等" &&
            i.areas.some((a) => /^23\d{5}$/.test(a.code)),
        ),
      );
      details = {
        kind: "volcano_warning_forecast",
        sections,
        content: get(body, "VolcanoInfoContent") ?? null,
      };
    }
  }
  return {
    source: "Japan Meteorological Agency",
    sourceUrl: candidate.sourceUrl,
    bulletinType: type,
    scope: "Japan-wide bulletin archive; user-location matching pending",
    publishedAt: candidate.publishedAt,
    reportDateTime,
    eventId,
    serial: text(get(head, "Serial")),
    infoType,
    invalidated,
    ignored,
    controlStatus: status,
    interpretation: ignored
      ? "excluded_training_or_test"
      : invalidated
        ? "bulletin_cancelled_status_unknown"
        : "raw_official_bulletin",
    aichiMentioned,
    aichiMentionMeaning:
      "Explicit area/observation mention only; not a risk or all-clear assessment",
    headline: text(get(head, "Headline", "Text")),
    details,
    control,
    head,
    body: body ?? null,
    backendConnected: false,
    notificationsSent: false,
  };
}

/**
 * Return unseen supported bulletins from the recent or recovery feed (≤ 3 per
 * type). An empty store simply means every entry is unseen.
 */
export async function checkEqvol(
  context: JobsContext,
  mode: keyof typeof jmaEqvolFeeds,
): Promise<{ candidates: EqvolCandidate[] }> {
  const entries = listEqvolEntries(
    parseXml(
      await context.fetchText(jmaEqvolFeeds[mode], {
        timeoutMs: eqvolTimeoutMs,
      }),
    ),
  );
  const storedKeys = await context.repository.findStoredEqvolKeys(
    entries.map((entry) => eqvolRecordKey(entry.sourceUrl)),
  );
  return { candidates: selectEqvolCandidates(entries, storedKeys) };
}

/**
 * Download, validate and store one bulletin; the outbox handoff is queued
 * before the bulletin is stored. Already-stored bulletins return
 * `stored: false` without writes.
 */
export async function processEqvol(
  context: JobsContext,
  candidate: Omit<EqvolCandidate, "title"> & { title?: string },
) {
  const recordKey = eqvolRecordKey(candidate.sourceUrl);
  const stored = await context.repository.findStoredEqvolKeys([recordKey]);
  if (stored.has(recordKey))
    return {
      stored: false,
      bulletinType: candidate.bulletinType,
      ignored: false,
      invalidated: false,
      aichiMentioned: null,
      queued: false,
    };
  const document = parseXml(
    await context.fetchText(candidate.sourceUrl, { timeoutMs: eqvolTimeoutMs }),
  );
  const payload = normalizeEqvolReport(document, candidate);
  const storedAt = context.now().toISOString();
  const handoff = prepareHandoff(
    {
      sourceUrl: candidate.sourceUrl,
      publishedAt: candidate.publishedAt,
      bulletin: payload,
    },
    storedAt,
  );
  // Create-if-absent: a retried request finds the entry from its first attempt.
  await context.repository.enqueueOutbox(handoff);
  const record: EqvolBulletinRecord = {
    recordKey,
    sourceUrl: candidate.sourceUrl,
    bulletinType: candidate.bulletinType,
    publishedAt: candidate.publishedAt,
    reportDateTime: payload.reportDateTime,
    infoType: payload.infoType,
    invalidated: payload.invalidated,
    ignored: payload.ignored,
    aichiMentioned: payload.aichiMentioned,
    storedAt,
    payloadGzip: encodePayload(payload),
  };
  await context.repository.storeEqvolBulletin(record);
  return {
    stored: true,
    bulletinType: candidate.bulletinType,
    ignored: payload.ignored,
    invalidated: payload.invalidated,
    aichiMentioned: payload.aichiMentioned,
    queued: handoff.deliveryStatus === "pending",
  };
}
