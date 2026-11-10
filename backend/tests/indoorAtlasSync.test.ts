import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MemoryIndoorVenuesRepository } from "../src/repositories/indoorVenuesRepository.js";
import { indoorAtlasSyncSummarySchema } from "../src/schemas/indoorAtlas.js";
import {
  indoorVenueSchema,
  type IndoorVenue,
} from "../src/schemas/indoorVenue.js";
import {
  createIndoorAtlasClient,
  indoorAtlasMappingApiBase,
  type FetchLike,
} from "../src/services/indoorAtlasClient.js";
import {
  classifyExit,
  defaultVenueRadiusM,
  splitName,
  syncIndoorAtlasVenues,
} from "../src/services/indoorAtlasSync.js";
import { runIndoorVenuesCommand } from "../src/services/indoorVenueAdmin.js";
import {
  IndoorVenueService,
  loadSeedVenues,
} from "../src/services/indoorVenueService.js";
import { testContext } from "./jobsHelpers.js";

/** Example responses from the IndoorAtlas Mapping API OpenAPI spec (sample data, Oulu). */
const spec = JSON.parse(
  readFileSync(
    new URL("./fixtures/indooratlas-mapping-api.json", import.meta.url),
    "utf8",
  ),
) as {
  venues: Record<string, unknown>[];
  floorplans: unknown[];
  geofences: { type: string; features: unknown[] };
  wayfinding: { type: string; features: unknown[] };
};
const specVenueId = "021d95b0-8177-11f0-8b4a-4db64e3e5bb4";
const apiKey = "TEST-ONLY-mapping-key-0123456789";

// SYNTHETIC exit POIs (not a real building): one per keyword family, en and ja.
function poi(id: string, floor: number, name: string, description = "") {
  return {
    type: "Feature",
    id,
    properties: { floor, name, description },
    geometry: { type: "Point", coordinates: [25.4402, 65.0604] },
  };
}
const syntheticPois = [
  poi("a0000001-8309-11f0-8a1f-7f0e3a839158", 1, "Main Exit / 正面出口"),
  poi("a0000002-8309-11f0-8a1f-7f0e3a839158", 1, "非常口"),
  poi("a0000003-8309-11f0-8a1f-7f0e3a839158", 2, "East stairs"),
  poi("a0000004-8309-11f0-8a1f-7f0e3a839158", 2, "北階段"),
  poi("a0000005-8309-11f0-8a1f-7f0e3a839158", 1, "Lobby", "West ENTRANCE"),
  poi("a0000006-8309-11f0-8a1f-7f0e3a839158", 1, "入口"),
  poi("a0000007-8309-11f0-8a1f-7f0e3a839158", 2, "Kitchen"),
  // Malformed: not a UUID, missing floor, bad coordinates.
  { ...poi("not-a-uuid", 1, "Exit"), id: "not-a-uuid" },
  {
    type: "Feature",
    id: "a0000008-8309-11f0-8a1f-7f0e3a839158",
    properties: { name: "Exit" },
    geometry: { type: "Point", coordinates: [25.44, 65.06] },
  },
  {
    ...poi("a0000009-8309-11f0-8a1f-7f0e3a839158", 1, "Exit"),
    geometry: { type: "Point", coordinates: ["x", 65] },
  },
];

type Routes = Record<string, { status: number; body?: unknown } | "throw">;

/** Fake fetch serving `routes` by path; records every request. */
function fakeFetch(routes: Routes) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    assert.ok(url.startsWith(indoorAtlasMappingApiBase));
    const route = routes[url.slice(indoorAtlasMappingApiBase.length)];
    if (route === "throw") throw new TypeError("network down");
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return { fetch, calls };
}

function specRoutes(
  extra: Partial<Routes> = {},
  venues: unknown[] = spec.venues,
): Routes {
  return {
    "/venues": { status: 200, body: venues },
    [`/venues/${specVenueId}/floorplans`]: {
      status: 200,
      body: [...spec.floorplans, { id: "broken" }],
    },
    [`/venues/${specVenueId}/geofences/geojson`]: {
      status: 200,
      body: {
        ...spec.geofences,
        features: [...spec.geofences.features, ...syntheticPois],
      },
    },
    [`/venues/${specVenueId}/wayfinding/geojson`]: {
      status: 200,
      body: spec.wayfinding,
    },
    ...extra,
  } as Routes;
}

async function runSync(
  repository: MemoryIndoorVenuesRepository,
  routes: Routes,
  logs: string[] = [],
) {
  const { fetch, calls } = fakeFetch(routes);
  const summary = await syncIndoorAtlasVenues({
    client: createIndoorAtlasClient({ apiKey, fetch }),
    repository,
    now: () => new Date("2026-11-09T03:00:00.000Z"),
    log: (message) => logs.push(message),
  });
  return { summary, calls, logs };
}

const syncedId = `ia-${specVenueId}`;

test("maps the spec example venue, floor plans, POIs and wayfinding", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const { summary, calls, logs } = await runSync(repository, specRoutes());
  indoorAtlasSyncSummarySchema.parse(summary);
  const venue = indoorVenueSchema.parse(repository.documents.get(syncedId));
  assert.equal(venue.syncedFrom, "indooratlas");
  assert.equal(venue.syncOrder, 0);
  assert.equal(venue.enabled, true);
  assert.deepEqual(venue.name, {
    en: "IndoorAtlas office building",
    ja: "IndoorAtlas office building",
  });
  assert.equal(venue.indoorAtlas!.venueId, specVenueId);
  assert.equal(venue.indoorAtlas!.hasWayfinding, true);
  assert.deepEqual(venue.indoorAtlas!.floors, [
    {
      floorPlanId: "fa622b60-8180-11f0-8e93-87f6b9a47be8",
      floorLevel: 1,
      name: "1F",
      // Placement only: the expiring image URL is never stored.
      plan: {
        topLeft: { lat: 65.0608881, lng: 25.4396979 },
        topRight: { lat: 65.0608881, lng: 25.4406979 },
        bottomLeft: { lat: 65.0599881, lng: 25.4396979 },
        bottomRight: { lat: 65.0599881, lng: 25.4406979 },
        center: { lat: 65.0603881, lng: 25.4401979 },
        widthPx: 1000,
        heightPx: 1000,
        widthM: 100,
        heightM: 100,
      },
    },
  ]);
  assert.ok(!JSON.stringify(venue).includes("cdn.indooratlas.com"));
  assert.equal(venue.address, "10-N Electronic Avenue, 90590-OULU, Finland");
  assert.equal(venue.description, "IndoorAtlas offices in Oulu, Finland");
  // The spec's geofence polygon becomes a display-only area (closing point dropped).
  assert.deepEqual(venue.areas, [
    {
      id: "ia-c48b8e70-8309-11f0-8a1f-7f0e3a839157",
      name: { en: "Test Rectangle", ja: "Test Rectangle" },
      description: "This is a test.",
      floorLevel: 3,
      indoorAtlasGeofenceId: "c48b8e70-8309-11f0-8a1f-7f0e3a839157",
      ring: [
        { lat: 65.0605, lng: 25.4401 },
        { lat: 65.0605, lng: 25.44031 },
        { lat: 65.06059, lng: 25.44031 },
        { lat: 65.06059, lng: 25.4401 },
      ],
    },
  ]);
  assert.equal(venue.location.lat, 65.0605);
  assert.equal(venue.location.lng, 25.4401);
  // Farthest corner (~60 m) + 20 m margin, not the 120 m default.
  assert.ok(venue.location.radiusM > 70 && venue.location.radiusM < 95);
  // Polygons are geofences, not POIs; 8 valid points (spec + 7 synthetic).
  assert.equal(venue.pois.length, 8);
  const nearby = venue.pois.find(
    (p) => p.indoorAtlasPoiId === "c5425b50-8309-11f0-8a1f-7f0e3a839158",
  )!;
  assert.deepEqual(nearby, {
    id: "ia-c5425b50-8309-11f0-8a1f-7f0e3a839158",
    name: { en: "Nearby Point", ja: "Nearby Point" },
    floorLevel: 3,
    indoorAtlasPoiId: "c5425b50-8309-11f0-8a1f-7f0e3a839158",
    lat: 65.06055,
    lng: 25.44005,
  });
  assert.deepEqual(
    venue.exits.map((exit) => [exit.name.en, exit.kind, exit.source]),
    [
      ["Main Exit", "exit", "indooratlas"],
      ["非常口", "exit", "indooratlas"],
      ["East stairs", "stairs", "indooratlas"],
      ["北階段", "stairs", "indooratlas"],
      ["Lobby", "entrance", "indooratlas"],
      ["入口", "entrance", "indooratlas"],
    ],
  );
  assert.deepEqual(venue.exits[0]!.name, { en: "Main Exit", ja: "正面出口" });
  // Never upgraded to verified.
  assert.ok(venue.exits.every((exit) => exit.source !== "verified"));
  assert.deepEqual(summary, {
    configured: true,
    venues: 1,
    floors: 1,
    pois: 8,
    exits: 6,
    areas: 1,
    archived: 0,
    updated: 1,
    disabled: 0,
    skipped: 0,
  });
  // Malformed items were skipped and logged.
  assert.ok(logs.some((line) => /floor plan #1 malformed/.test(line)));
  assert.equal(
    logs.filter((line) => /feature #\d+ malformed/.test(line)).length,
    3,
  );
  // GET only, key in the header, never in the URL.
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.every((call) => call.headers["x-api-key"] === apiKey));
  assert.ok(calls.every((call) => !call.url.includes(apiKey)));
  assert.ok(logs.every((line) => !line.includes(apiKey)));
});

test("exit keyword detection (en/ja, case-insensitive)", () => {
  const cases: [string, ReturnType<typeof classifyExit>][] = [
    ["EXIT", "exit"],
    ["Emergency exit B", "exit"],
    ["exits", "exit"],
    ["非常口", "exit"],
    ["出口 2", "exit"],
    ["避難口", "exit"],
    ["South entrance", "entrance"],
    ["入口", "entrance"],
    ["Stairs", "stairs"],
    ["staircase", "stairs"],
    ["階段", "stairs"],
    ["Exit stairs", "exit"],
    ["Exhibition hall", null],
    ["Existing kitchen", null],
    ["Room 221", null],
  ];
  for (const [text, kind] of cases)
    assert.equal(classifyExit(text), kind, text);
  assert.deepEqual(splitName("SAI Dining / SAIダイニング"), {
    en: "SAI Dining",
    ja: "SAIダイニング",
  });
  assert.deepEqual(splitName("  SAI   Dining "), {
    en: "SAI Dining",
    ja: "SAI Dining",
  });
  assert.equal(splitName("   "), null);
});

test("sync is idempotent and keeps a manual disable", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  await runSync(repository, specRoutes());
  const again = await runSync(repository, specRoutes());
  assert.equal(again.summary.updated, 0);
  assert.equal(again.summary.venues, 1);
  // Disabled by an admin: the sync updates content but keeps it disabled.
  const stored = indoorVenueSchema.parse(repository.documents.get(syncedId));
  repository.documents.set(syncedId, { ...stored, enabled: false });
  await runSync(repository, specRoutes());
  assert.equal(
    indoorVenueSchema.parse(repository.documents.get(syncedId)).enabled,
    false,
  );
});

test("venues deleted in IndoorAtlas are disabled; manual docs are never touched", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  await runSync(repository, specRoutes());
  const manual: IndoorVenue = {
    ...loadSeedVenues()[0]!,
    id: "manual-hall",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  repository.documents.set(manual.id, structuredClone(manual));
  const { summary } = await runSync(repository, specRoutes({}, []));
  assert.equal(summary.disabled, 1);
  assert.equal(
    indoorVenueSchema.parse(repository.documents.get(syncedId)).enabled,
    false,
  );
  assert.deepEqual(repository.documents.get(manual.id), manual);
  // Running again does not count it twice.
  assert.equal(
    (await runSync(repository, specRoutes({}, []))).summary.disabled,
    0,
  );
});

test("a manual document covering the same IndoorAtlas venue wins", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const manual: IndoorVenue = {
    ...loadSeedVenues()[0]!,
    id: "curated-office",
    indoorAtlas: { venueId: specVenueId, floors: [] },
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  repository.documents.set(manual.id, structuredClone(manual));
  const { summary } = await runSync(repository, specRoutes());
  assert.equal(summary.skipped, 1);
  assert.equal(repository.documents.has(syncedId), false);
  assert.deepEqual(repository.documents.get(manual.id), manual);
});

test("upstream failures: list failure throws, per-venue failure keeps the stored copy", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  await runSync(repository, specRoutes());
  const before = structuredClone(repository.documents.get(syncedId));
  await assert.rejects(
    runSync(repository, specRoutes({ "/venues": "throw" })),
    (error: Error) => !error.message.includes(apiKey),
  );
  await assert.rejects(
    runSync(repository, specRoutes({ "/venues": { status: 401, body: {} } })),
    /rejected the Mapping API key/,
  );
  const { summary } = await runSync(
    repository,
    specRoutes({
      [`/venues/${specVenueId}/geofences/geojson`]: { status: 500, body: {} },
    }),
  );
  assert.equal(summary.skipped, 1);
  assert.equal(summary.disabled, 0);
  assert.deepEqual(repository.documents.get(syncedId), before);
});

test("missing geofences and wayfinding (404) are empty, with the default radius", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const { summary } = await runSync(repository, {
    "/venues": {
      status: 200,
      body: [...spec.venues, { id: "bad" }, { name: "no id" }],
    },
  });
  assert.equal(summary.venues, 1);
  const venue = indoorVenueSchema.parse(repository.documents.get(syncedId));
  assert.equal(venue.indoorAtlas!.hasWayfinding, false);
  assert.deepEqual(venue.pois, []);
  assert.deepEqual(venue.indoorAtlas!.floors, []);
  assert.equal(venue.location.radiusM, defaultVenueRadiusM);
});

test("not configured: nothing fetched, nothing written", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const summary = await syncIndoorAtlasVenues({
    client: null,
    repository,
    now: () => new Date(),
  });
  assert.deepEqual(summary, {
    configured: false,
    venues: 0,
    floors: 0,
    pois: 0,
    exits: 0,
    areas: 0,
    archived: 0,
    updated: 0,
    disabled: 0,
    skipped: 0,
  });
  assert.equal(repository.reads, 0);
  const lines = await runIndoorVenuesCommand(["sync"], {
    repository,
    seed: loadSeedVenues(),
    readJson: async () => ({}),
    indoorAtlasClient: null,
  });
  assert.match(lines.join("\n"), /not configured/);
});

test("POST /jobs/indooratlas/sync returns the summary and never the key", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const { fetch } = fakeFetch(specRoutes());
  const { context } = testContext();
  const app = createApp({
    jobs: {
      ...context,
      indoorAtlas: {
        client: createIndoorAtlasClient({ apiKey, fetch }),
        venues: repository,
      },
    },
  });
  const response = await request(app).post("/jobs/indooratlas/sync").send({});
  assert.equal(response.status, 200);
  assert.equal(response.body.configured, true);
  assert.equal(response.body.exits, 6);
  assert.ok(!JSON.stringify(response.body).includes(apiKey));
  // Unconfigured jobs context.
  const plain = await request(createApp({ jobs: testContext().context }))
    .post("/jobs/indooratlas/sync")
    .send({});
  assert.equal(plain.status, 200);
  assert.equal(plain.body.configured, false);
  // Upstream auth failure maps to a code, without details or the key.
  const { fetch: denied } = fakeFetch({ "/venues": { status: 401, body: {} } });
  const failing = await request(
    createApp({
      jobs: {
        ...context,
        indoorAtlas: {
          client: createIndoorAtlasClient({ apiKey, fetch: denied }),
          venues: repository,
        },
      },
    }),
  )
    .post("/jobs/indooratlas/sync")
    .send({});
  assert.equal(failing.status, 502);
  assert.deepEqual(failing.body, { error: "UPSTREAM_UNAVAILABLE" });
});

test("listing: synced venues first as 01, then manual, then seed (02, 03…)", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const seed = loadSeedVenues();
  const manual: IndoorVenue = {
    ...seed[0]!,
    id: "manual-hall",
    name: { en: "Manual Hall", ja: "手動ホール" },
    indoorAtlas: {
      venueId: "11111111-2222-4333-8444-555555555555",
      floors: [],
    },
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  repository.documents.set(manual.id, manual);
  await runSync(repository, specRoutes());
  const list = await new IndoorVenueService({
    repository,
    seed,
  }).listEnabledVenues();
  assert.deepEqual(
    list.venues.map((venue) => [venue.id, venue.rank, venue.primary]),
    [
      [syncedId, 1, true],
      ["manual-hall", 2, false],
      ["nu-library", 3, false],
      ["nu-engineering-2", 4, false],
    ],
  );
  assert.equal(list.venues[0]!.syncedFrom, "indooratlas");
  assert.equal("syncOrder" in list.venues[0]!, false);
  // A Firestore doc can still disable a seed venue; ranks stay continuous.
  const library = seed.find((venue) => venue.id === "nu-library")!;
  repository.documents.set(library.id, { ...library, enabled: false });
  const withoutLibrary = await new IndoorVenueService({
    repository,
    seed,
  }).listEnabledVenues();
  assert.deepEqual(
    withoutLibrary.venues.map((venue) => [venue.id, venue.rank]),
    [
      [syncedId, 1],
      ["manual-hall", 2],
      ["nu-engineering-2", 3],
    ],
  );
  // With the synced venue disabled, the manual venue becomes 01.
  repository.documents.delete(library.id);
  const synced = indoorVenueSchema.parse(repository.documents.get(syncedId));
  repository.documents.set(syncedId, { ...synced, enabled: false });
  const noSynced = await new IndoorVenueService({
    repository,
    seed,
  }).listEnabledVenues();
  assert.deepEqual(
    noSynced.venues.map((venue) => [venue.id, venue.origin, venue.primary]),
    [
      ["manual-hall", "firestore", true],
      ["nu-library", "seed", false],
      ["nu-engineering-2", "seed", false],
    ],
  );
});
