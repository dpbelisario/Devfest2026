import assert from "node:assert/strict";
import { test } from "node:test";
import type { Content } from "@google/genai";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MemoryJobsRepository } from "../src/repositories/memoryJobsRepository.js";
import type { LiveContext } from "../src/routes/live.js";
import {
  AssistantService,
  type GenerateTurn,
} from "../src/services/assistantService.js";
import { encodePayload } from "../src/services/jobs/payloadCodec.js";
import { LiveDataService } from "../src/services/liveDataService.js";
import { RateLimiter } from "../src/services/rateLimiter.js";

// SYNTHETIC TEST DATA ONLY: not real sites, warnings or bulletins.
const origin = { lat: 35.17, lng: 136.88 };
const syntheticSites = [
  { id: "A", lat: 35.171, lng: 136.88, disasters: ["earthquake", "fire"] },
  { id: "B", lat: 35.18, lng: 136.88, disasters: ["flood"] },
  { id: "C", lat: 35.3, lng: 136.88, disasters: ["earthquake"] },
].map((site) => ({
  id: site.id,
  name: `Synthetic site ${site.id}`,
  address: "Synthetic address",
  latitude: site.lat,
  longitude: site.lng,
  disasters: site.disasters,
  kind: "emergencySite",
  source: "synthetic",
  verifiedAt: null,
  isDemo: false,
  openingStatus: "unknown",
  remarks: "",
}));

async function seededRepository() {
  const repository = new MemoryJobsRepository();
  const now = "2026-11-05T00:00:00.000Z";
  await repository.publishNagoyaDataset({
    current: {
      recordKey: "current:23100",
      municipalityCode: "23100",
      municipalityName: "Nagoya City, Aichi",
      datasetVersion: "v1",
      recordCount: syntheticSites.length,
      payloadSha256: "x",
      payloadGzip: encodePayload(syntheticSites),
      sourceUrl: "https://example.invalid/sites.csv",
      sourceAttribution: "synthetic",
      lastCheckedAt: now,
      lastChangedAt: now,
      lastStatus: "published",
      entryType: "designation_only",
    },
    snapshot: {
      recordKey: "snapshot:v1",
      municipalityCode: "23100",
      municipalityName: "Nagoya City, Aichi",
      datasetVersion: "v1",
      recordCount: syntheticSites.length,
      payloadSha256: "x",
      payloadGzip: encodePayload(syntheticSites),
      sourceUrl: "https://example.invalid/sites.csv",
      sourceAttribution: "synthetic",
      lastCheckedAt: now,
      lastChangedAt: now,
      lastStatus: "snapshot_saved",
      entryType: "designation_only",
    },
    expectedBaseVersion: null,
  });
  await repository.storeWeatherBulletin({
    currentKey: "current:230000",
    record: {
      recordKey: "bulletin:x.xml",
      sourceUrl: "https://example.invalid/x.xml",
      publishedAt: now,
      reportDateTime: now,
      infoType: "発表",
      invalidated: false,
      storedAt: now,
      processedUrls: [],
      payloadGzip: encodePayload({
        headline: "SYNTHETIC",
        reportDateTime: now,
        publishedAt: now,
        infoType: "発表",
        invalidated: false,
        sourceUrl: "https://example.invalid/x.xml",
        nagoya: {
          areaName: "名古屋市",
          kinds: [
            { code: "14", name: "雷注意報", status: "継続" },
            { code: "03", name: "大雨警報", status: "解除" },
          ],
        },
      }),
    },
  });
  for (const [file, ignored] of [
    ["old.xml", false],
    ["new.xml", false],
    ["skip.xml", true],
  ] as const)
    await repository.storeEqvolBulletin({
      recordKey: `eqvol:${file}`,
      sourceUrl: `https://example.invalid/${file}`,
      bulletinType: "VXSE53",
      publishedAt:
        file === "old.xml" ? "2026-11-01T00:00:00Z" : "2026-11-04T00:00:00Z",
      reportDateTime: now,
      infoType: "発表",
      invalidated: false,
      ignored,
      aichiMentioned: false,
      storedAt: now,
      payloadGzip: encodePayload({ headline: `SYNTHETIC ${file}` }),
    });
  return repository;
}

function liveContext(
  live: LiveDataService,
  generate?: GenerateTurn,
  limiter = new RateLimiter({
    windowMs: 60_000,
    perKeyLimit: 5,
    totalLimit: 50,
  }),
): LiveContext {
  return {
    live,
    assistant: generate
      ? new AssistantService({ live, generate, model: "fake" })
      : undefined,
    assistantLimiter: limiter,
  };
}

test("/api is not mounted without live data", async () => {
  const response = await request(createApp()).get("/api/alerts");
  assert.equal(response.status, 404);
});

test("GET /api/sites returns nearest designated sites with unknown status", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  const app = createApp({ live: liveContext(live) });
  const response = await request(app)
    .get("/api/sites")
    .query({ ...origin, radiusMeters: 5000 });
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sites.map((site: { id: string }) => site.id),
    ["A", "B"],
  );
  assert.equal(response.body.sites[0].openingStatus, "unknown");
  assert.equal(response.body.sites[0].bearingDegrees, 0);
  assert.ok(response.body.sites[0].distanceMeters > 100);
  assert.equal(response.body.dataset.datasetVersion, "v1");
  assert.match(String(response.headers["cache-control"]), /max-age=300/);

  const flood = await request(app)
    .get("/api/sites")
    .query({ ...origin, disaster: "flood" });
  assert.deepEqual(
    flood.body.sites.map((site: { id: string }) => site.id),
    ["B"],
  );
  const invalid = await request(app).get("/api/sites").query({ lat: 99 });
  assert.equal(invalid.status, 400);
});

test("/api allows cross-origin use from the bundled UI", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  const app = createApp({ live: liveContext(live) });
  const preflight = await request(app)
    .options("/api/assistant")
    .set("Origin", "https://appassets.androidplatform.net")
    .set("Access-Control-Request-Method", "POST");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(
    String(preflight.headers["access-control-allow-headers"]),
    /Content-Type/,
  );
  const alerts = await request(app).get("/api/alerts");
  assert.equal(alerts.headers["access-control-allow-origin"], "*");
});

test("GET /api/sites answers 503 before the first import", async () => {
  const live = new LiveDataService({ repository: new MemoryJobsRepository() });
  const response = await request(createApp({ live: liveContext(live) }))
    .get("/api/sites")
    .query(origin);
  assert.equal(response.status, 503);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("GET /api/alerts summarises JMA data without inventing an all-clear", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  const response = await request(createApp({ live: liveContext(live) })).get(
    "/api/alerts",
  );
  assert.equal(response.status, 200);
  const kinds = response.body.weather.nagoya.kinds;
  assert.deepEqual(
    kinds.map((kind: { level: string; inEffect: boolean }) => [
      kind.level,
      kind.inEffect,
    ]),
    [
      ["advisory", true],
      ["warning", false],
    ],
  );
  assert.deepEqual(
    response.body.bulletins.map((b: { headline: string }) => b.headline),
    ["SYNTHETIC new.xml", "SYNTHETIC old.xml"],
  );

  const empty = new LiveDataService({ repository: new MemoryJobsRepository() });
  const none = await request(createApp({ live: liveContext(empty) })).get(
    "/api/alerts",
  );
  assert.equal(none.body.weather, null);
  assert.deepEqual(none.body.bulletins, []);
});

test("POST /api/assistant runs tools and returns app actions", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  const seen: Content[][] = [];
  const script: Content[] = [
    {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "find_evacuation_sites",
            args: { disaster: "earthquake", limit: 3 },
          },
        },
        { functionCall: { name: "get_current_alerts", args: {} } },
      ],
    },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "show_sites_on_map",
            args: { site_ids: ["A", "ZZZ"] },
          },
        },
        {
          functionCall: { name: "start_ar_navigation", args: { site_id: "A" } },
        },
      ],
    },
    { role: "model", parts: [{ text: "Go to Synthetic site A." }] },
  ];
  const generate: GenerateTurn = async ({ contents }) => {
    seen.push(structuredClone(contents));
    const next = script.shift();
    assert.ok(next, "model called too often");
    return next;
  };
  const response = await request(
    createApp({ live: liveContext(live, generate) }),
  )
    .post("/api/assistant")
    .send({
      message: "Earthquake! Where do I go?",
      language: "en",
      location: { ...origin, source: "gps" },
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Go to Synthetic site A.");
  assert.deepEqual(response.body.toolCalls, [
    "find_evacuation_sites",
    "get_current_alerts",
    "show_sites_on_map",
    "start_ar_navigation",
  ]);
  assert.deepEqual(response.body.actions, [
    { type: "showSites", siteIds: ["A"] },
    { type: "startAr", siteId: "A" },
  ]);
  // The earthquake filter excluded B; C is outside the default radius.
  assert.deepEqual(
    response.body.sites.map((site: { id: string }) => site.id),
    ["A"],
  );
  // Second model call saw the tool results.
  const toolTurn = seen[1]?.at(-1)?.parts ?? [];
  const sitesResult = toolTurn[0]?.functionResponse?.response as {
    sites: { id: string; openingStatus: string }[];
  };
  assert.equal(sitesResult.sites[0]?.openingStatus, "unknown");
});

test("POST /api/assistant validates, rate limits and can be disabled", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  const disabled = await request(createApp({ live: liveContext(live) }))
    .post("/api/assistant")
    .send({ message: "hi" });
  assert.equal(disabled.status, 503);

  const generate: GenerateTurn = async () => ({
    role: "model",
    parts: [{ text: "ok" }],
  });
  const app = createApp({
    live: liveContext(
      live,
      generate,
      new RateLimiter({ windowMs: 60_000, perKeyLimit: 1, totalLimit: 10 }),
    ),
  });
  const bad = await request(app).post("/api/assistant").send({ message: "" });
  assert.equal(bad.status, 400);
  const first = await request(app)
    .post("/api/assistant")
    .send({ message: "hi" });
  assert.equal(first.status, 200);
  const second = await request(app)
    .post("/api/assistant")
    .send({ message: "hi" });
  assert.equal(second.status, 429);
});

test("assistant tool without a location asks for one", async () => {
  const live = new LiveDataService({ repository: await seededRepository() });
  let toolResult: unknown;
  const script: Content[] = [
    {
      role: "model",
      parts: [{ functionCall: { name: "find_evacuation_sites", args: {} } }],
    },
    { role: "model", parts: [{ text: "Please enable location." }] },
  ];
  const service = new AssistantService({
    live,
    model: "fake",
    generate: async ({ contents }) => {
      toolResult = contents.at(-1)?.parts?.[0]?.functionResponse?.response;
      return script.shift() ?? { role: "model", parts: [{ text: "" }] };
    },
  });
  const reply = await service.reply({
    message: "where?",
    language: "ja",
    location: null,
    history: [],
  });
  assert.equal(reply.reply, "Please enable location.");
  assert.deepEqual(toolResult, {
    error: "Location unknown. Ask the user to enable location.",
  });
});
