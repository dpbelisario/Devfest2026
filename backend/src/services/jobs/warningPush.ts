import { z } from "zod";
import type { OutboxEntry } from "../../repositories/jobsRepository.js";
import { decodePayload } from "./payloadCodec.js";
import { get, list, text } from "./xml.js";

/**
 * Turns a pending outbox entry into a short, bilingual FCM topic message, or
 * decides to skip it. Everything shown is derived from the stored official
 * JMA bulletin; nothing is invented. Pure logic, unit tested without FCM.
 */

/** Entries whose bulletin is older than this are skipped (no backfill blasts). */
export const warningPushMaxAgeMs = 30 * 60 * 1000;
/** FCM keeps undelivered messages for one hour. */
export const warningPushTtlSeconds = 60 * 60;

const nagoyaAreaCode = "2310000";
const maxKindsShown = 3;

/** Message handed to the sender (FCM implementation: fcmSender.ts). */
export interface WarningPushMessage {
  topic: string;
  title: string;
  body: string;
  /** FCM data payload; all values are strings. */
  data: Record<string, string>;
  /** One per bulletin type, so a newer bulletin replaces an undelivered one. */
  collapseKey: string;
  ttlSeconds: number;
}

/** Sends one message; resolves to the provider message ID, rejects on failure. */
export interface WarningSender {
  send(message: WarningPushMessage): Promise<string>;
}

export type WarningSkipReason =
  | "training_or_test"
  | "cancelled"
  | "stale"
  | "not_relevant"
  | "invalid_payload";

/**
 * Which in-app alert screen a tap opens (Android AlertKind ids), or "" to
 * just open the app. Advisories (注意報) never open the emergency screen.
 */
export type WarningAlertKind = "tsunami" | "special" | "alert" | "";

export interface WarningContent {
  title: string;
  body: string;
  alertKind: WarningAlertKind;
}

export type WarningPushDecision =
  | { action: "send"; message: WarningPushMessage }
  | { action: "skip"; reason: WarningSkipReason };

const envelopeSchema = z.object({
  deliveryKey: z.string(),
  sourceUrl: z.string(),
  publishedAt: z.string(),
  bulletinType: z.string(),
  bulletin: z.record(z.string(), z.unknown()),
});

const commonBulletinSchema = z.object({
  infoType: z.string(),
  invalidated: z.boolean(),
  reportDateTime: z.string(),
  ignored: z.boolean().optional(),
  control: z.unknown(),
});

const weatherBulletinSchema = commonBulletinSchema.extend({
  nagoya: z
    .object({
      areaCode: z.string(),
      areaName: z.string(),
      kinds: z.array(
        z.object({ code: z.string(), name: z.string(), status: z.string() }),
      ),
    })
    .nullable(),
});

const eqvolBulletinSchema = commonBulletinSchema.extend({
  bulletinType: z.enum(["VXSE53", "VTSE41", "VFVO50"]),
  ignored: z.boolean(),
  aichiMentioned: z.boolean().nullable(),
  headline: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Decide what to do with a pending entry at `now`. Order: invalid payload,
 * training/test, cancellation (取消: status unknown, never an all-clear),
 * stale (published more than 30 minutes ago), not relevant to Nagoya/Aichi.
 */
export function decideWarningPush(
  entry: OutboxEntry,
  now: Date,
  topic: string,
): WarningPushDecision {
  const skip = (reason: WarningSkipReason): WarningPushDecision => ({
    action: "skip",
    reason,
  });
  let envelope: z.infer<typeof envelopeSchema>;
  try {
    envelope = envelopeSchema.parse(decodePayload(entry.payloadGzip));
  } catch {
    return skip("invalid_payload");
  }
  if (
    envelope.deliveryKey !== entry.deliveryKey ||
    envelope.sourceUrl !== entry.sourceUrl
  )
    return skip("invalid_payload");
  const common = commonBulletinSchema.safeParse(envelope.bulletin);
  if (!common.success) return skip("invalid_payload");
  const controlStatus = text(get(common.data.control, "Status"));
  if (common.data.ignored === true || controlStatus !== "通常")
    return skip("training_or_test");
  if (common.data.invalidated || common.data.infoType === "取消")
    return skip("cancelled");
  const publishedMs = Date.parse(entry.publishedAt);
  if (!Number.isFinite(publishedMs)) return skip("invalid_payload");
  if (now.getTime() - publishedMs > warningPushMaxAgeMs) return skip("stale");

  let content: WarningContent | null;
  if (entry.bulletinType === "VPWW53") {
    const weather = weatherBulletinSchema.safeParse(envelope.bulletin);
    if (!weather.success) return skip("invalid_payload");
    content = weatherContent(weather.data);
  } else {
    const eqvol = eqvolBulletinSchema.safeParse(envelope.bulletin);
    if (!eqvol.success || eqvol.data.bulletinType !== entry.bulletinType)
      return skip("invalid_payload");
    content =
      eqvol.data.aichiMentioned === true ? eqvolContent(eqvol.data) : null;
  }
  if (!content) return skip("not_relevant");
  return {
    action: "send",
    message: {
      topic,
      title: content.title,
      body: content.body,
      data: {
        deliveryKey: entry.deliveryKey,
        bulletinType: entry.bulletinType,
        sourceUrl: entry.sourceUrl,
        publishedAt: entry.publishedAt,
        source: "Japan Meteorological Agency (気象庁)",
        alertKind: content.alertKind,
        title: content.title,
        body: content.body,
      },
      collapseKey: `jma-${entry.bulletinType}`,
      ttlSeconds: warningPushTtlSeconds,
    },
  };
}

/** JMA weather warning/advisory names (VPWW53 Kind/Name) in English. */
const weatherKindEnglish: Record<string, string> = {
  大雨特別警報: "heavy rain emergency warning",
  大雨警報: "heavy rain warning",
  大雨注意報: "heavy rain advisory",
  洪水警報: "flood warning",
  洪水注意報: "flood advisory",
  暴風特別警報: "storm emergency warning",
  暴風警報: "storm warning",
  強風注意報: "strong wind advisory",
  暴風雪特別警報: "snowstorm emergency warning",
  暴風雪警報: "snowstorm warning",
  風雪注意報: "wind and snow advisory",
  大雪特別警報: "heavy snow emergency warning",
  大雪警報: "heavy snow warning",
  大雪注意報: "heavy snow advisory",
  波浪特別警報: "high wave emergency warning",
  波浪警報: "high wave warning",
  波浪注意報: "high wave advisory",
  高潮特別警報: "storm surge emergency warning",
  高潮警報: "storm surge warning",
  高潮注意報: "storm surge advisory",
  雷注意報: "thunderstorm advisory",
  融雪注意報: "snowmelt advisory",
  濃霧注意報: "dense fog advisory",
  乾燥注意報: "dry air advisory",
  なだれ注意報: "avalanche advisory",
  低温注意報: "low temperature advisory",
  霜注意報: "frost advisory",
  着氷注意報: "icing advisory",
  着雪注意報: "snow accretion advisory",
};

/** Statuses that mean "nothing in effect" for that kind. */
const inactiveWeatherStatuses = new Set(["発表警報・注意報はなし", "解除"]);

/**
 * Nagoya (2310000) kinds that are issued, continuing or changed level; null
 * when Nagoya has no warning or advisory in effect.
 */
export function weatherContent(
  bulletin: z.infer<typeof weatherBulletinSchema>,
): WarningContent | null {
  const nagoya = bulletin.nagoya;
  if (!nagoya || nagoya.areaCode !== nagoyaAreaCode) return null;
  const active = nagoya.kinds.filter(
    (kind) => kind.name && !inactiveWeatherStatuses.has(kind.status),
  );
  if (!active.length) return null;
  const names = active.map((kind) => kind.name);
  const shown = names.slice(0, maxKindsShown);
  const more = names.length - shown.length;
  const allContinuing = active.every((kind) => kind.status === "継続");
  const ja = `${shown.join("・")}${more ? `ほか${more}件` : ""}${allContinuing ? "（継続）" : ""}`;
  const en = `${shown.map((name) => weatherKindEnglish[name] ?? name).join(", ")}${more ? ` +${more} more` : ""}${allContinuing ? " (continuing)" : ""}`;
  const alertKind: WarningAlertKind = names.some((name) =>
    name.includes("特別警報"),
  )
    ? "special"
    : names.some((name) => name.includes("警報"))
      ? "alert"
      : "";
  return {
    title: `名古屋市: ${ja} / Nagoya: ${en}`,
    body: issuedLine(bulletin.reportDateTime),
    alertKind,
  };
}

/** Content for an Aichi-mentioning earthquake, tsunami or volcano bulletin. */
export function eqvolContent(
  bulletin: z.infer<typeof eqvolBulletinSchema>,
): WarningContent {
  const issued = issuedLine(bulletin.reportDateTime);
  const details = bulletin.details;
  if (bulletin.bulletinType === "VXSE53") {
    const aichi = list(get(details, "observedPrefectures")).find(
      (pref) => text(get(pref, "Code")) === "23",
    );
    const intensity = intensityLabel(text(get(aichi, "MaxInt")));
    const epicenter = text(
      get(details, "earthquake", "Hypocenter", "Area", "Name"),
    );
    const magnitude = text(get(details, "earthquake", "jmx_eb:Magnitude"));
    const where = [
      epicenter && `震源 ${epicenter}`,
      /^\d+(\.\d+)?$/.test(magnitude) && `M${magnitude}`,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      title: intensity
        ? `地震情報: 愛知県で震度${intensity.ja} / Earthquake: intensity ${intensity.en} in Aichi`
        : "地震情報: 愛知県で観測 / Earthquake observed in Aichi",
      body: where ? `${where}. ${issued}` : issued,
      alertKind: "alert",
    };
  }
  if (bulletin.bulletinType === "VTSE41") {
    // Aichi forecast areas (愛知県外海, 伊勢・三河湾); show the most severe one.
    const first = list(get(details, "areas"))
      .filter((area) => ["390", "391"].includes(text(get(area, "areaCode"))))
      .sort(
        (a, b) =>
          tsunamiRank(text(get(b, "category", "Kind", "Name"))) -
          tsunamiRank(text(get(a, "category", "Kind", "Name"))),
      )[0];
    const kind = text(get(first, "category", "Kind", "Name"));
    const area = text(get(first, "areaName"));
    const areaEnglish =
      text(get(first, "areaCode")) === "391"
        ? "Ise Bay and Mikawa Bay"
        : "Aichi outer coast";
    return {
      title:
        kind && area
          ? `${kind}: ${area} / ${tsunamiKindEnglish(kind)}: ${areaEnglish}`
          : "津波情報: 愛知県 / Tsunami information: Aichi",
      body: issued,
      alertKind: "tsunami",
    };
  }
  const headline = bulletin.headline.trim().slice(0, 80);
  return {
    title: "噴火警報・予報: 愛知県を含む / Volcano bulletin mentioning Aichi",
    body: headline ? `${headline} ${issued}` : issued,
    alertKind: "alert",
  };
}

/** JMA seismic intensity (震度) codes, e.g. "5-" → 5弱 / 5 lower. */
function intensityLabel(code: string): { ja: string; en: string } | null {
  const match = /^([1-7])([+-]?)$/.exec(code);
  if (!match) return null;
  const level = match[1] ?? "";
  const sign = match[2] ?? "";
  if (sign === "-") return { ja: `${level}弱`, en: `${level} lower` };
  if (sign === "+") return { ja: `${level}強`, en: `${level} upper` };
  return { ja: level, en: level };
}

function tsunamiRank(kind: string): number {
  if (kind.includes("解除")) return 0;
  if (kind.includes("大津波警報")) return 4;
  if (kind.includes("津波警報")) return 3;
  if (kind.includes("津波注意報")) return 2;
  return 1;
}

function tsunamiKindEnglish(kind: string): string {
  if (kind.includes("解除")) return "Tsunami warning/advisory lifted";
  if (kind.includes("大津波警報")) return "Major tsunami warning";
  if (kind.includes("津波警報")) return "Tsunami warning";
  if (kind.includes("津波注意報")) return "Tsunami advisory";
  if (kind.includes("若干の海面変動"))
    return "Tsunami forecast (slight sea level change)";
  return "Tsunami information";
}

const tokyoTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "気象庁 10:05 発表 / Source: JMA, 10:05 JST" from the report time. */
function issuedLine(reportDateTime: string): string {
  const ms = Date.parse(reportDateTime);
  if (!Number.isFinite(ms)) return "出典: 気象庁 / Source: JMA";
  const time = tokyoTime.format(new Date(ms));
  return `気象庁 ${time} 発表 / Source: JMA, ${time} JST`;
}
