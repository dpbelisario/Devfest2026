import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { MemoryIndoorVenuesRepository } from "../src/repositories/indoorVenuesRepository.js";
import {
  indoorVenueSchema,
  indoorVenuesResponseSchema,
  type IndoorVenue,
} from "../src/schemas/indoorVenue.js";
import { createIndoorVenueService } from "../src/services/createIndoorVenueService.js";
import {
  AdminInputError,
  parseVenueUpload,
  runIndoorVenuesCommand,
} from "../src/services/indoorVenueAdmin.js";
import {
  IndoorVenueService,
  loadSeedVenues,
} from "../src/services/indoorVenueService.js";

const seed = loadSeedVenues();
const engineering = seed[0]!;

// SYNTHETIC TEST VENUE: not a real building or IndoorAtlas venue.
const synthetic: IndoorVenue = {
  id: "synthetic-hall",
  name: { en: "Synthetic Hall", ja: "合成ホール" },
  enabled: true,
  indoorAtlas: {
    venueId: "11111111-2222-4333-8444-555555555555",
    floors: [
      {
        floorPlanId: "11111111-2222-4333-8444-666666666666",
        floorLevel: 1,
        name: "1F",
      },
    ],
  },
  location: { lat: 35.1, lng: 136.9, radiusM: 80 },
  exits: [
    {
      id: "west-door",
      name: { en: "West door", ja: "西口" },
      floorLevel: 1,
      lat: 35.1001,
      lng: 136.8999,
      kind: "exit",
      source: "event-map",
    },
  ],
  pois: [
    {
      id: "booth-a",
      name: { en: "Booth A", ja: "ブースA" },
      floorLevel: 1,
    },
  ],
  updatedAt: "2026-11-09T00:00:00.000Z",
  notes: "internal",
};

function makeService(
  repository: MemoryIndoorVenuesRepository,
  clock = { t: 0 },
  warnings: string[] = [],
) {
  return new IndoorVenueService({
    repository,
    seed,
    now: () => clock.t,
    warn: (message) => warnings.push(message),
  });
}

test("seed is the documented Engineering II venue and validates", () => {
  assert.equal(seed.length, 1);
  assert.equal(
    engineering.indoorAtlas.venueId,
    "0d3ece20-da98-11f1-95cb-e11cd22c6739",
  );
  assert.equal(
    engineering.pois.find((poi) => poi.id === "room-221")?.indoorAtlasPoiId,
    "e8679fc0-da9a-11f1-b91e-6591398611dd",
  );
  assert.deepEqual(
    engineering.indoorAtlas.floors.map((floor) => floor.floorLevel),
    [2, 3],
  );
  // No surveyed exits exist; none may be invented.
  assert.deepEqual(engineering.exits, []);
});

test("schema rejects bad venues and the template placeholders", () => {
  assert.equal(indoorVenueSchema.safeParse(synthetic).success, true);
  const bad = [
    { ...synthetic, extra: 1 },
    { ...synthetic, id: "Has Spaces" },
    { ...synthetic, indoorAtlas: { venueId: "nope", floors: [] } },
    {
      ...synthetic,
      exits: [{ ...synthetic.exits[0]!, source: "official" }],
    },
    {
      ...synthetic,
      indoorAtlas: {
        ...synthetic.indoorAtlas,
        floors: [
          synthetic.indoorAtlas.floors[0]!,
          synthetic.indoorAtlas.floors[0]!,
        ],
      },
    },
    { ...synthetic, pois: [{ ...synthetic.pois[0]!, lat: 35.1 }] },
    { ...synthetic, location: { lat: 0, lng: 0, radiusM: 50 } },
    { ...synthetic, updatedAt: "yesterday" },
  ];
  for (const venue of bad)
    assert.equal(indoorVenueSchema.safeParse(venue).success, false);
  const template: unknown = JSON.parse(
    readFileSync(
      new URL("../../docs/indoor-venue.template.json", import.meta.url),
      "utf8",
    ),
  );
  assert.throws(() => parseVenueUpload(template), AdminInputError);
});

test("seed is served when Firestore is empty, without notes", async () => {
  const service = makeService(new MemoryIndoorVenuesRepository());
  const result = await service.listEnabledVenues();
  assert.equal(result.source, "seed");
  assert.deepEqual(
    result.venues.map((venue) => [venue.id, venue.origin]),
    [["nu-engineering-2", "seed"]],
  );
  assert.equal("notes" in result.venues[0]!, false);
  assert.equal("enabled" in result.venues[0]!, false);
});

test("stored venues merge with the seed; invalid docs are skipped with a warning", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  repository.documents.set(synthetic.id, synthetic);
  repository.documents.set("broken", { id: "broken", name: "x" });
  repository.documents.set("mismatch", { ...synthetic, id: "other-id" });
  const warnings: string[] = [];
  const result = await makeService(
    repository,
    { t: 0 },
    warnings,
  ).listEnabledVenues();
  assert.equal(result.source, "firestore");
  assert.deepEqual(
    result.venues.map((venue) => [venue.id, venue.origin]),
    [
      ["nu-engineering-2", "seed"],
      ["synthetic-hall", "firestore"],
    ],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /indoorVenues\/broken/);
  assert.match(warnings.join("\n"), /indoorVenues\/mismatch/);
  // Exit provenance is passed through, never upgraded.
  assert.equal(result.venues[1]!.exits[0]!.source, "event-map");
});

test("disabled venues are hidden, including a disabled seed override", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  repository.documents.set(synthetic.id, { ...synthetic, enabled: false });
  repository.documents.set(engineering.id, { ...engineering, enabled: false });
  const result = await makeService(repository).listEnabledVenues();
  assert.equal(result.source, "firestore");
  assert.deepEqual(result.venues, []);
});

test("cache is reused for 5 minutes; outages fall back to the last good list", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  repository.documents.set(synthetic.id, synthetic);
  const clock = { t: 0 };
  const warnings: string[] = [];
  const service = makeService(repository, clock, warnings);
  await service.listEnabledVenues();
  repository.documents.delete(synthetic.id);
  clock.t = 4 * 60_000;
  assert.equal((await service.listEnabledVenues()).venues.length, 2);
  assert.equal(repository.reads, 1);
  clock.t = 5 * 60_000 + 1;
  repository.failReads = true;
  const stale = await service.listEnabledVenues();
  assert.equal(stale.venues.length, 2);
  assert.match(warnings.at(-1)!, /last good list/);
  repository.failReads = false;
  clock.t += 31_000;
  assert.equal((await service.listEnabledVenues()).venues.length, 1);
  assert.equal(repository.reads, 3);
});

test("an outage before any good read serves the seed", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  repository.failReads = true;
  const result = await makeService(repository).listEnabledVenues();
  assert.equal(result.source, "seed");
  assert.equal(result.venues[0]?.id, "nu-engineering-2");
});

test("GET /api/indoor/venues returns the validated public shape", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  repository.documents.set(synthetic.id, synthetic);
  const app = createApp({ indoorVenues: makeService(repository) });
  const response = await request(app).get("/api/indoor/venues");
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["cache-control"], "public, max-age=60");
  const body = indoorVenuesResponseSchema.parse(response.body);
  assert.equal(body.venues.length, 2);
  // Existing indoor routes are unaffected by the venues mount.
  const catalog = await request(app).get("/api/indoor/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers["cache-control"], "no-store");
});

test("default app and LIVE_DATA_STORE=off/memory serve the seed", async () => {
  for (const store of ["off", "memory"]) {
    const service = createIndoorVenueService(
      parseConfig({ LIVE_DATA_STORE: store }),
    );
    const result = await service.listEnabledVenues();
    assert.equal(result.source, "seed");
  }
  const response = await request(createApp()).get("/api/indoor/venues");
  assert.equal(response.status, 200);
  assert.equal(response.body.venues[0].id, "nu-engineering-2");
});

test("admin commands validate, upsert and toggle venues", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const now = () => new Date("2026-11-09T01:02:03.000Z");
  const files: Record<string, unknown> = {
    "one.json": { ...synthetic, updatedAt: undefined },
    "bad.json": { ...synthetic, exits: [{ id: "x" }] },
  };
  const run = (...args: string[]) =>
    runIndoorVenuesCommand(args, {
      repository,
      seed,
      now,
      readJson: async (path) => structuredClone(files[path]),
    });
  await run("upsert", "one.json");
  const saved = indoorVenueSchema.parse(
    repository.documents.get("synthetic-hall"),
  );
  assert.equal(saved.updatedAt, "2026-11-09T01:02:03.000Z");
  await assert.rejects(run("upsert", "bad.json"), AdminInputError);
  await run("disable", "nu-engineering-2");
  assert.equal(
    indoorVenueSchema.parse(repository.documents.get("nu-engineering-2"))
      .enabled,
    false,
  );
  const listing = await run("list");
  assert.match(listing.join("\n"), /disabled +nu-engineering-2 +\(firestore\)/);
  assert.match(listing.join("\n"), /enabled +synthetic-hall/);
  await assert.rejects(run("enable", "unknown-venue"), AdminInputError);
  await assert.rejects(run("bogus"), AdminInputError);
});
