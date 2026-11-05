import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createJobsContext } from "../src/services/jobs/createJobsContext.js";
import { jmaEqvolFeeds } from "../src/services/jobs/jmaEqvol.js";
import { jmaWeatherFeeds } from "../src/services/jobs/jmaWeather.js";
import { nagoyaSource } from "../src/services/jobs/nagoyaDataset.js";
import { decodePayload } from "../src/services/jobs/payloadCodec.js";
import {
  eqvolFixtures,
  feedEntry,
  feedXml,
  testContext,
  toXml,
  weatherReport,
  weatherUrl,
} from "./jobsHelpers.js";

const header =
  "共通ID,施設・場所名,住所,洪水,崖崩れ、土石流及び地滑り,高潮,地震,津波,大規模な火事,内水氾濫,火山現象,指定避難所との住所同一,緯度,経度,備考";
const bom = String.fromCharCode(0xfeff);
const csvRows = (count: number, name = "避難場所") =>
  `${bom}${header}\n${Array.from(
    { length: count },
    (_, i) =>
      `23100${String(i).padStart(5, "0")},${name}${i},名古屋市,,,,1,,,,,,35.1,136.9,`,
  ).join("\n")}\n`;

test("/jobs routes are not mounted unless JOBS_ENABLED=true", async () => {
  const disabled = createJobsContext(parseConfig({}));
  assert.equal(disabled, undefined);
  const publicApp = createApp({ jobs: disabled });
  for (const path of ["/jobs/nagoya/fetch", "/jobs/outbox/deliver"]) {
    const response = await request(publicApp).post(path).send({});
    assert.equal(response.status, 404);
  }
  const enabled = createJobsContext(
    parseConfig({ JOBS_ENABLED: "true", JOBS_STORE: "memory" }),
  );
  assert.ok(enabled);
  const r = await request(createApp({ jobs: enabled }))
    .post("/jobs/outbox/deliver")
    .send({});
  assert.deepEqual(r.body, {
    deliveryEnabled: false,
    pending: 0,
    attempted: 0,
  });
  assert.throws(() => parseConfig({ JOBS_ENABLED: "yes" }));
});

test("Nagoya fetch → compare → publish, then an unchanged re-check", async () => {
  const { context, repository } = testContext({
    [nagoyaSource.sourceUrl]: csvRows(4),
  });
  const app = createApp({ jobs: context });
  const fetched = await request(app).post("/jobs/nagoya/fetch").send({});
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, {
    runId: "run-1",
    valid: true,
    recordCount: 4,
    errorCount: 0,
    errors: [],
  });
  // A missing current row is the initial state.
  const compared = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: "run-1" });
  assert.deepEqual(compared.body, {
    runId: "run-1",
    changed: true,
    status: "changed",
  });
  assert.equal(
    (
      await request(app)
        .post("/jobs/nagoya/record-unchanged")
        .send({ runId: "run-1" })
    ).body.error,
    "RUN_NOT_UNCHANGED",
  );
  const published = await request(app)
    .post("/jobs/nagoya/publish")
    .send({ runId: "run-1" });
  assert.equal(published.status, 200);
  assert.deepEqual(published.body, {
    datasetVersion: "nagoya-run-1",
    recordCount: 4,
    lastChangedAt: "2026-11-05T02:00:00.000Z",
  });
  // Publishing is idempotent for retries.
  const again = await request(app)
    .post("/jobs/nagoya/publish")
    .send({ runId: "run-1" });
  assert.deepEqual(again.body, published.body);
  const current = repository.nagoyaDatasets.get("current:23100");
  assert.equal(current?.lastStatus, "published");
  assert.ok(repository.nagoyaDatasets.has("snapshot:23100:run-1"));
  const sites = decodePayload(current!.payloadGzip) as {
    openingStatus: string;
  }[];
  assert.equal(sites.length, 4);
  assert.ok(sites.every((site) => site.openingStatus === "unknown"));

  await request(app).post("/jobs/nagoya/fetch").send({});
  const unchanged = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: "run-2" });
  assert.deepEqual(unchanged.body, {
    runId: "run-2",
    changed: false,
    status: "unchanged",
  });
  assert.equal(
    (await request(app).post("/jobs/nagoya/publish").send({ runId: "run-2" }))
      .body.error,
    "RUN_NOT_PUBLISHABLE",
  );
  const recorded = await request(app)
    .post("/jobs/nagoya/record-unchanged")
    .send({ runId: "run-2" });
  assert.deepEqual(recorded.body, {
    lastCheckedAt: "2026-11-05T02:00:00.000Z",
  });
  assert.equal(
    repository.nagoyaDatasets.get("current:23100")?.lastStatus,
    "unchanged",
  );
  assert.equal(
    repository.nagoyaDatasets.get("current:23100")?.datasetVersion,
    "nagoya-run-1",
  );
});

test("Nagoya compare detects changes and refuses >50% shrink", async () => {
  const { context, responses } = testContext({
    [nagoyaSource.sourceUrl]: csvRows(10),
  });
  const app = createApp({ jobs: context });
  await request(app).post("/jobs/nagoya/fetch").send({});
  await request(app).post("/jobs/nagoya/compare").send({ runId: "run-1" });
  await request(app).post("/jobs/nagoya/publish").send({ runId: "run-1" });

  responses[nagoyaSource.sourceUrl] = csvRows(10, "改名");
  await request(app).post("/jobs/nagoya/fetch").send({});
  const changed = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: "run-2" });
  assert.equal(changed.body.status, "changed");

  responses[nagoyaSource.sourceUrl] = csvRows(4);
  await request(app).post("/jobs/nagoya/fetch").send({});
  const shrank = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: "run-3" });
  assert.equal(shrank.status, 409);
  assert.deepEqual(shrank.body, { error: "DATASET_SHRANK" });

  // run-2 was compared against run-1; publishing still succeeds.
  const published = await request(app)
    .post("/jobs/nagoya/publish")
    .send({ runId: "run-2" });
  assert.equal(published.body.datasetVersion, "nagoya-run-2");
});

test("Nagoya invalid datasets are reported and never compared", async () => {
  const { context, repository } = testContext({
    [nagoyaSource.sourceUrl]: `${header}\n1,,addr,,,,,,,,,,x,y,\n`,
  });
  const app = createApp({ jobs: context });
  const fetched = await request(app).post("/jobs/nagoya/fetch").send({});
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.valid, false);
  assert.ok(fetched.body.errorCount >= 3);
  assert.ok(fetched.body.errors.length <= 20);
  const compared = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: fetched.body.runId });
  assert.deepEqual(compared.body, { error: "DATASET_INVALID" });
  assert.equal(repository.nagoyaDatasets.size, 0);
  const unknown = await request(app)
    .post("/jobs/nagoya/compare")
    .send({ runId: "missing" });
  assert.equal(unknown.status, 404);
  assert.equal(
    (await request(app).post("/jobs/nagoya/compare").send({ runId: "../x" }))
      .status,
    400,
  );
});

test("upstream failures return a code without internal details", async () => {
  const { context } = testContext();
  const app = createApp({ jobs: context });
  const r = await request(app).post("/jobs/nagoya/fetch").send({});
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: "UPSTREAM_UNAVAILABLE" });
});

test("weather check returns the latest unseen bulletin; process queues before storing", async () => {
  const { context, repository, fetched } = testContext({
    [jmaWeatherFeeds.recent]: feedXml([
      feedEntry(weatherUrl, "2026-11-05T01:00:00Z"),
      feedEntry(weatherUrl.replace("_0_", "_1_"), "2026-10-05T01:00:00Z"),
    ]),
    [weatherUrl]: toXml(weatherReport()),
  });
  const app = createApp({ jobs: context });
  const check = await request(app)
    .post("/jobs/jma/weather/check")
    .send({ mode: "recent" });
  assert.equal(check.status, 200);
  assert.deepEqual(check.body.candidate, {
    sourceUrl: weatherUrl,
    publishedAt: "2026-11-05T01:00:00Z",
    title: "気象特別警報・警報・注意報",
  });
  const processed = await request(app)
    .post("/jobs/jma/weather/process")
    .send({ candidate: check.body.candidate });
  assert.equal(processed.status, 200);
  assert.deepEqual(processed.body, {
    stored: true,
    infoType: "発表",
    invalidated: false,
    municipalityCount: 2,
    nagoyaKinds: [{ code: "", name: "", status: "発表警報・注意報はなし" }],
    queued: true,
  });
  assert.deepEqual(repository.operations, [
    `outbox:jma:${weatherUrl}`,
    "weather:bulletin:20261105010000_0_VPWW53_230000.xml",
  ]);
  assert.equal(repository.weather.get("current:230000")?.sourceUrl, weatherUrl);
  // Seen now: check returns null and a replayed process writes nothing.
  const recheck = await request(app)
    .post("/jobs/jma/weather/check")
    .send({ mode: "recent" });
  assert.equal(recheck.body.candidate, null);
  const replay = await request(app)
    .post("/jobs/jma/weather/process")
    .send({ candidate: check.body.candidate });
  assert.equal(replay.body.stored, false);
  assert.equal(replay.body.infoType, null);
  assert.equal(fetched.filter((url) => url === weatherUrl).length, 1);
  const outbox = await request(app).post("/jobs/outbox/deliver").send({});
  assert.deepEqual(outbox.body, {
    deliveryEnabled: false,
    pending: 1,
    attempted: 0,
  });
});

test("weather cancellation is stored as unknown status, training is not stored", async () => {
  const cancelled = weatherReport();
  cancelled.Report.Head.InfoType = "取消";
  delete cancelled.Report.Body;
  const training = weatherReport();
  training.Report.Control.Status = "訓練";
  const trainingUrl = weatherUrl.replace("010000_0", "020000_0");
  const { context, repository } = testContext({
    [weatherUrl]: toXml(cancelled),
    [trainingUrl]: toXml(training),
  });
  const app = createApp({ jobs: context });
  const r = await request(app)
    .post("/jobs/jma/weather/process")
    .send({
      candidate: {
        sourceUrl: weatherUrl,
        publishedAt: "2026-11-05T01:00:00Z",
        title: "x",
      },
    });
  assert.deepEqual(r.body, {
    stored: true,
    infoType: "取消",
    invalidated: true,
    municipalityCount: 0,
    nagoyaKinds: [],
    queued: true,
  });
  const stored = repository.weather.get("current:230000");
  const payload = decodePayload(stored!.payloadGzip) as Record<string, unknown>;
  assert.equal(payload.interpretation, "bulletin_cancelled_status_unknown");
  assert.equal(payload.nagoya, null);

  const t = await request(app)
    .post("/jobs/jma/weather/process")
    .send({
      candidate: {
        sourceUrl: trainingUrl,
        publishedAt: "2026-11-05T02:00:00Z",
        title: "x",
      },
    });
  assert.equal(t.body.stored, false);
  assert.equal(t.body.queued, false);
  assert.equal(repository.outbox.size, 1);
});

test("process endpoints refuse non-JMA URLs (no arbitrary fetches)", async () => {
  const { context, fetched } = testContext();
  const app = createApp({ jobs: context });
  for (const sourceUrl of [
    "https://example.com/20261105010000_0_VPWW53_230000.xml",
    "http://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_230000.xml",
    "https://www.data.jma.go.jp/developer/xml/data/../x_VPWW53_230000.xml",
    "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_130000.xml",
  ]) {
    const r = await request(app)
      .post("/jobs/jma/weather/process")
      .send({
        candidate: {
          sourceUrl,
          publishedAt: "2026-11-05T01:00:00Z",
          title: "",
        },
      });
    assert.equal(r.status, 400, sourceUrl);
  }
  const mismatch = await request(app)
    .post("/jobs/jma/eqvol/process")
    .send({
      candidate: {
        sourceUrl:
          "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VXSE53_010000.xml",
        publishedAt: "2026-11-05T01:00:00Z",
        bulletinType: "VTSE41",
        title: "",
      },
    });
  assert.equal(mismatch.status, 400);
  assert.equal(
    (await request(app).post("/jobs/jma/eqvol/check").send({ mode: "all" }))
      .status,
    400,
  );
  assert.deepEqual(fetched, []);
});

const eqvolUrl = (type: string, index: number) =>
  `https://www.data.jma.go.jp/developer/xml/data/2026110501000${index}_0_${type}_010000.xml`;

test("eqvol check runs on an empty store, bounds per type and skips stored bulletins", async () => {
  const entries = ["VTSE41", "VFVO50", "VXSE53", "VXSE43"].flatMap((type) =>
    [0, 1, 2, 3, 4].map((index) =>
      feedEntry(eqvolUrl(type, index), `2026-11-05T01:00:0${index}Z`, "気象庁"),
    ),
  );
  const { context, repository } = testContext({
    [jmaEqvolFeeds.recovery]: feedXml(entries),
    [eqvolUrl("VTSE41", 4)]: toXml(eqvolFixtures.VTSE41),
  });
  const app = createApp({ jobs: context });
  const first = await request(app)
    .post("/jobs/jma/eqvol/check")
    .send({ mode: "recovery" });
  assert.equal(first.status, 200);
  assert.equal(first.body.candidates.length, 9);
  assert.equal(first.body.candidates[0].sourceUrl, eqvolUrl("VTSE41", 4));
  assert.equal(first.body.candidates[0].bulletinType, "VTSE41");

  const processed = await request(app)
    .post("/jobs/jma/eqvol/process")
    .send({ candidate: first.body.candidates[0] });
  assert.deepEqual(processed.body, {
    stored: true,
    bulletinType: "VTSE41",
    ignored: false,
    invalidated: false,
    aichiMentioned: true,
    queued: true,
  });
  assert.deepEqual(repository.operations, [
    `outbox:jma:${eqvolUrl("VTSE41", 4)}`,
    `eqvol:${eqvolUrl("VTSE41", 4)}`,
  ]);
  const second = await request(app)
    .post("/jobs/jma/eqvol/check")
    .send({ mode: "recovery" });
  const urls = second.body.candidates.map(
    (c: { sourceUrl: string }) => c.sourceUrl,
  );
  assert.equal(urls.length, 9);
  assert.ok(!urls.includes(eqvolUrl("VTSE41", 4)));
  assert.ok(urls.includes(eqvolUrl("VTSE41", 1)));
  const replay = await request(app)
    .post("/jobs/jma/eqvol/process")
    .send({ candidate: first.body.candidates[0] });
  assert.equal(replay.body.stored, false);
});

test("eqvol training bulletins are stored as ignored with an excluded handoff", async () => {
  const training = structuredClone(eqvolFixtures.VXSE53);
  (training.Report.Control as Record<string, unknown>).Status = "訓練";
  const url = eqvolUrl("VXSE53", 0);
  const { context, repository } = testContext({ [url]: toXml(training) });
  const app = createApp({ jobs: context });
  const r = await request(app)
    .post("/jobs/jma/eqvol/process")
    .send({
      candidate: {
        sourceUrl: url,
        publishedAt: "2026-11-05T01:00:00Z",
        bulletinType: "VXSE53",
        title: "震源・震度情報",
      },
    });
  assert.deepEqual(r.body, {
    stored: true,
    bulletinType: "VXSE53",
    ignored: true,
    invalidated: false,
    aichiMentioned: null,
    queued: false,
  });
  assert.equal(repository.outbox.get(`jma:${url}`)?.deliveryStatus, "excluded");
  assert.equal(await repository.countPendingOutbox(), 0);
});

test("malformed bulletins fail without writes", async () => {
  const url = eqvolUrl("VXSE53", 0);
  const { context, repository } = testContext({
    [url]: toXml(eqvolFixtures.VFVO50),
  });
  const app = createApp({ jobs: context });
  const r = await request(app)
    .post("/jobs/jma/eqvol/process")
    .send({
      candidate: {
        sourceUrl: url,
        publishedAt: "2026-11-05T01:00:00Z",
        bulletinType: "VXSE53",
        title: "",
      },
    });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: "INVALID_UPSTREAM_DATA" });
  assert.deepEqual(repository.operations, []);
});
