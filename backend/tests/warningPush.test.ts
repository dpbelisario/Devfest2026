import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import type { OutboxEntry } from "../src/repositories/jobsRepository.js";
import { toFcmMessage } from "../src/services/jobs/fcmSender.js";
import {
  normalizeEqvolReport,
  type EqvolBulletinType,
} from "../src/services/jobs/jmaEqvol.js";
import { normalizeWeatherReport } from "../src/services/jobs/jmaWeather.js";
import { deliverOutbox, prepareHandoff } from "../src/services/jobs/outbox.js";
import {
  decideWarningPush,
  type WarningPushMessage,
} from "../src/services/jobs/warningPush.js";
import { eqvolFixtures, testContext, weatherReport } from "./jobsHelpers.js";

/*
 * SYNTHETIC TEST DATA ONLY: bulletins below are fixtures and edited copies,
 * never official warnings. "now" in testContext is 2026-11-05T02:00:00Z.
 */

const fresh = "2026-11-05T01:55:00Z";
const freshCreated = "2026-11-05T01:56:00.000Z";

let fileCounter = 0;
const weatherFile = () =>
  `https://www.data.jma.go.jp/developer/xml/data/2026110501${String(++fileCounter).padStart(4, "0")}_0_VPWW53_230000.xml`;
const eqvolFile = (type: EqvolBulletinType) =>
  `https://www.data.jma.go.jp/developer/xml/data/2026110501${String(++fileCounter).padStart(4, "0")}_0_${type}_010000.xml`;

/** Synthetic Aichi weather bulletin; `nagoyaKinds` replaces Nagoya's Kind list. */
function weatherEntry(
  options: {
    nagoyaKinds?: { Code?: string; Name?: string; Status: string }[];
    infoType?: string;
    publishedAt?: string;
    createdAt?: string;
  } = {},
): OutboxEntry {
  const report = weatherReport();
  report.Report.Head.InfoType = options.infoType ?? "発表";
  const items = (
    report.Report.Body as { Warning: { Item: { Kind: unknown }[] } }
  ).Warning.Item;
  items[0]!.Kind = options.nagoyaKinds ?? [
    { Code: "14", Name: "雷注意報", Status: "発表" },
  ];
  const sourceUrl = weatherFile();
  const publishedAt = options.publishedAt ?? fresh;
  const createdAt = options.createdAt ?? freshCreated;
  const payload = normalizeWeatherReport(
    report,
    { sourceUrl, publishedAt, processedUrls: [] },
    createdAt,
  );
  assert.ok(payload);
  return prepareHandoff(
    { sourceUrl, publishedAt, bulletin: payload },
    createdAt,
  );
}

function eqvolEntry(
  type: EqvolBulletinType,
  options: {
    edit?: (report: Record<string, unknown>) => void;
    publishedAt?: string;
    createdAt?: string;
  } = {},
): OutboxEntry {
  const document = structuredClone(eqvolFixtures[type]);
  options.edit?.(document.Report);
  const sourceUrl = eqvolFile(type);
  const publishedAt = options.publishedAt ?? fresh;
  const createdAt = options.createdAt ?? freshCreated;
  const payload = normalizeEqvolReport(document, {
    sourceUrl,
    publishedAt,
    bulletinType: type,
  });
  return prepareHandoff(
    { sourceUrl, publishedAt, bulletin: payload },
    createdAt,
  );
}

/** Records messages; fails the listed delivery keys. */
function fakeSender(failKeys = new Set<string>()) {
  const sent: WarningPushMessage[] = [];
  return {
    sent,
    sender: {
      async send(message: WarningPushMessage) {
        if (failKeys.has(message.data.deliveryKey ?? ""))
          throw new Error("FCM unavailable (fake)");
        sent.push(message);
        return `projects/test/messages/${sent.length}`;
      },
    },
  };
}

function enabledContext(failKeys?: Set<string>) {
  const setup = testContext();
  const fake = fakeSender(failKeys);
  setup.context.delivery = {
    topic: "contour-test-warnings",
    sender: fake.sender,
  };
  return { ...setup, ...fake };
}

async function enqueue(
  repository: ReturnType<typeof testContext>["repository"],
  ...entries: OutboxEntry[]
) {
  for (const entry of entries) await repository.enqueueOutbox(entry);
}

test("disabled delivery only counts the backlog and changes nothing", async () => {
  const { context, repository } = testContext();
  const entry = weatherEntry();
  await enqueue(repository, entry);
  const before = structuredClone(repository.outbox.get(entry.deliveryKey));
  const response = await request(createApp({ jobs: context }))
    .post("/jobs/outbox/deliver")
    .send({});
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    deliveryEnabled: false,
    pending: 1,
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(repository.outbox.get(entry.deliveryKey), before);
});

test("enabled delivery sends meaningful Nagoya and Aichi bulletins", async () => {
  const { context, repository, sent } = enabledContext();
  const weather = weatherEntry({
    nagoyaKinds: [
      { Code: "03", Name: "大雨警報", Status: "発表" },
      { Code: "14", Name: "雷注意報", Status: "継続" },
    ],
  });
  const tsunami = eqvolEntry("VTSE41");
  await enqueue(repository, weather, tsunami);
  const response = await request(createApp({ jobs: context }))
    .post("/jobs/outbox/deliver")
    .send({});
  assert.deepEqual(response.body, {
    deliveryEnabled: true,
    pending: 0,
    attempted: 2,
    sent: 2,
    skipped: 0,
    failed: 0,
  });
  assert.equal(sent.length, 2);
  const [weatherMessage, tsunamiMessage] = sent;
  assert.ok(weatherMessage && tsunamiMessage);
  assert.equal(
    weatherMessage.title,
    "名古屋市: 大雨警報・雷注意報 / Nagoya: heavy rain warning, thunderstorm advisory",
  );
  assert.equal(
    weatherMessage.body,
    "気象庁 10:00 発表 / Source: JMA, 10:00 JST",
  );
  assert.equal(weatherMessage.topic, "contour-test-warnings");
  assert.equal(weatherMessage.collapseKey, "jma-VPWW53");
  assert.equal(weatherMessage.ttlSeconds, 3600);
  assert.deepEqual(
    {
      deliveryKey: weatherMessage.data.deliveryKey,
      bulletinType: weatherMessage.data.bulletinType,
      sourceUrl: weatherMessage.data.sourceUrl,
      publishedAt: weatherMessage.data.publishedAt,
      alertKind: weatherMessage.data.alertKind,
    },
    {
      deliveryKey: weather.deliveryKey,
      bulletinType: "VPWW53",
      sourceUrl: weather.sourceUrl,
      publishedAt: fresh,
      alertKind: "alert",
    },
  );
  assert.match(weatherMessage.data.source ?? "", /Japan Meteorological Agency/);
  // Most severe Aichi area of the (historical sample) tsunami bulletin.
  assert.equal(
    tsunamiMessage.title,
    "津波注意報: 愛知県外海 / Tsunami advisory: Aichi outer coast",
  );
  assert.equal(tsunamiMessage.data.alertKind, "tsunami");
  assert.equal(tsunamiMessage.collapseKey, "jma-VTSE41");
  for (const entry of [weather, tsunami]) {
    const row = repository.outbox.get(entry.deliveryKey);
    assert.equal(row?.deliveryStatus, "sent");
    assert.equal(row?.acknowledgedAt, "2026-11-05T02:00:00.000Z");
    assert.match(row?.deliveryNote ?? "", /^fcm:projects\/test\/messages\/\d$/);
  }
});

test("advisories only, continuing status and earthquake intensity wording", () => {
  const now = new Date("2026-11-05T02:00:00Z");
  const advisory = decideWarningPush(
    weatherEntry({
      nagoyaKinds: [{ Code: "14", Name: "雷注意報", Status: "継続" }],
    }),
    now,
    "t",
  );
  assert.equal(advisory.action, "send");
  if (advisory.action === "send") {
    assert.equal(
      advisory.message.title,
      "名古屋市: 雷注意報（継続） / Nagoya: thunderstorm advisory (continuing)",
    );
    // Advisories open the app, not the emergency alert screen.
    assert.equal(advisory.message.data.alertKind, "");
  }
  const quake = decideWarningPush(
    eqvolEntry("VXSE53", {
      edit: (report) => {
        const observation = (
          report.Body as { Intensity: { Observation: { Pref: unknown } } }
        ).Intensity.Observation;
        observation.Pref = [{ Name: "愛知県", Code: "23", MaxInt: "5-" }];
      },
    }),
    now,
    "t",
  );
  assert.equal(quake.action, "send");
  if (quake.action === "send") {
    assert.equal(
      quake.message.title,
      "地震情報: 愛知県で震度5弱 / Earthquake: intensity 5 lower in Aichi",
    );
    assert.match(quake.message.body, /^震源 千葉県南東沖 M3\.4\. 気象庁 /);
  }
});

test("excluded, cancelled, stale and unrelated entries are never sent", async () => {
  const { context, repository, sent } = enabledContext();
  const training = eqvolEntry("VTSE41", {
    edit: (report) => {
      (report.Control as Record<string, unknown>).Status = "訓練";
    },
  });
  assert.equal(training.deliveryStatus, "excluded");
  const cancelled = weatherEntry({ infoType: "取消" });
  const quiet = weatherEntry({
    nagoyaKinds: [{ Status: "発表警報・注意報はなし" }],
  });
  const lifted = weatherEntry({
    nagoyaKinds: [{ Code: "14", Name: "雷注意報", Status: "解除" }],
  });
  const elsewhere = eqvolEntry("VXSE53"); // Tokyo only: aichiMentioned false
  const recoveredOld = weatherEntry({ publishedAt: "2026-11-05T01:20:00Z" });
  const backlog = weatherEntry({
    publishedAt: "2026-11-04T09:00:00Z",
    createdAt: "2026-11-04T09:01:00.000Z",
  });
  await enqueue(
    repository,
    training,
    cancelled,
    quiet,
    lifted,
    elsewhere,
    recoveredOld,
    backlog,
  );
  const summary = await deliverOutbox(context);
  assert.deepEqual(summary, {
    deliveryEnabled: true,
    pending: 0,
    attempted: 0,
    sent: 0,
    skipped: 6,
    failed: 0,
  });
  assert.equal(sent.length, 0);
  const note = (entry: OutboxEntry) =>
    repository.outbox.get(entry.deliveryKey)?.deliveryNote;
  assert.equal(
    repository.outbox.get(training.deliveryKey)?.deliveryStatus,
    "excluded",
  );
  assert.equal(note(training), undefined);
  assert.equal(note(cancelled), "skipped:cancelled");
  assert.equal(note(quiet), "skipped:not_relevant");
  assert.equal(note(lifted), "skipped:not_relevant");
  assert.equal(note(elsewhere), "skipped:not_relevant");
  assert.equal(note(recoveredOld), "skipped:stale");
  assert.equal(note(backlog), "skipped:stale");
});

test("retries and overlapping calls never send an entry twice", async () => {
  const { context, repository, sent } = enabledContext();
  await enqueue(repository, weatherEntry(), weatherEntry());
  const [first, second] = await Promise.all([
    deliverOutbox(context),
    deliverOutbox(context),
  ]);
  assert.equal(first.sent + second.sent, 2);
  const again = await deliverOutbox(context);
  assert.equal(again.attempted, 0);
  assert.equal(sent.length, 2);
  assert.equal(
    new Set(sent.map((message) => message.data.deliveryKey)).size,
    2,
  );
});

test("a live claim from another call is respected; an abandoned one is retaken", async () => {
  const { context, repository, sent } = enabledContext();
  const entry = weatherEntry();
  await enqueue(repository, entry);
  await repository.claimOutboxEntry({
    deliveryKey: entry.deliveryKey,
    claimId: "other-call",
    claimedAt: "2026-11-05T01:59:00.000Z",
    liveClaimAfter: "2026-11-05T01:55:00.000Z",
  });
  assert.equal((await deliverOutbox(context)).sent, 0);
  context.now = () => new Date("2026-11-05T02:05:00.000Z");
  assert.equal((await deliverOutbox(context)).sent, 1);
  assert.equal(sent.length, 1);
});

test("at most three messages per call, oldest first", async () => {
  const { context, repository, sent } = enabledContext();
  const entries = [5, 1, 4, 2, 3].map((minute) =>
    weatherEntry({ createdAt: `2026-11-05T01:5${minute}:00.000Z` }),
  );
  await enqueue(repository, ...entries);
  const first = await deliverOutbox(context);
  assert.deepEqual(
    { attempted: first.attempted, sent: first.sent, pending: first.pending },
    { attempted: 3, sent: 3, pending: 2 },
  );
  assert.deepEqual(
    sent.map((message) => message.data.deliveryKey),
    [entries[1], entries[3], entries[4]].map((entry) => entry?.deliveryKey),
  );
  const second = await deliverOutbox(context);
  assert.equal(second.sent, 2);
  assert.equal(second.pending, 0);
});

test("a failed send leaves the entry pending for the next call", async () => {
  const failing = weatherEntry();
  const failKeys = new Set([failing.deliveryKey]);
  const { context, repository, sent } = enabledContext(failKeys);
  const ok = weatherEntry();
  await enqueue(repository, failing, ok);
  const first = await deliverOutbox(context);
  assert.deepEqual(
    { attempted: first.attempted, sent: first.sent, failed: first.failed },
    { attempted: 2, sent: 1, failed: 1 },
  );
  const row = repository.outbox.get(failing.deliveryKey);
  assert.equal(row?.deliveryStatus, "pending");
  assert.equal(row?.claimId, "");
  failKeys.clear();
  const second = await deliverOutbox(context);
  assert.equal(second.sent, 1);
  assert.equal(sent.length, 2);
  assert.equal(
    repository.outbox.get(failing.deliveryKey)?.deliveryStatus,
    "sent",
  );
});

test("FCM message uses the topic, high priority, a one-hour TTL and the warnings channel", () => {
  const decision = decideWarningPush(
    weatherEntry(),
    new Date("2026-11-05T02:00:00Z"),
    "contour-aichi-warnings",
  );
  assert.equal(decision.action, "send");
  if (decision.action !== "send") return;
  const message = toFcmMessage(decision.message);
  assert.equal(
    "topic" in message ? message.topic : "",
    "contour-aichi-warnings",
  );
  assert.deepEqual(message.android, {
    priority: "high",
    ttl: 3_600_000,
    collapseKey: "jma-VPWW53",
    notification: { channelId: "disaster_warnings", tag: "jma-VPWW53" },
  });
  assert.equal(message.data?.deliveryKey, decision.message.data.deliveryKey);
});

test("FCM settings are validated strictly and off by default", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.FCM_DELIVERY_ENABLED, false);
  assert.equal(defaults.FCM_TOPIC, "contour-aichi-warnings");
  assert.equal(
    parseConfig({ FCM_DELIVERY_ENABLED: "true" }).FCM_DELIVERY_ENABLED,
    true,
  );
  assert.throws(() => parseConfig({ FCM_DELIVERY_ENABLED: "yes" }));
  assert.throws(() => parseConfig({ FCM_DELIVERY_ENABLED: "TRUE" }));
  assert.throws(() => parseConfig({ FCM_TOPIC: "/topics/x y" }));
});
