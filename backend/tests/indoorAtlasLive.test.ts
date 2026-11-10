import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MemoryIndoorVenuesRepository } from "../src/repositories/indoorVenuesRepository.js";
import {
  indoorVenueSchema,
  publicIndoorVenueSchema,
} from "../src/schemas/indoorVenue.js";
import {
  FloorPlanImageService,
  floorPlanImageCacheMs,
  type ImageFetch,
} from "../src/services/floorPlanImageService.js";
import {
  archiveImageSource,
  MemoryIndoorAtlasArchiveStore,
  rawHistoryLimit,
  type RawVenueSnapshot,
} from "../src/services/indoorAtlasArchive.js";
import {
  createIndoorAtlasClient,
  indoorAtlasMappingApiBase,
  type FetchLike,
} from "../src/services/indoorAtlasClient.js";
import {
  maxAreaPoints,
  maxAreas,
  simplifyRing,
  syncIndoorAtlasVenues,
} from "../src/services/indoorAtlasSync.js";
import { runIndoorVenuesCommand } from "../src/services/indoorVenueAdmin.js";
import {
  defaultVenueCacheMs,
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
  floorplans: Record<string, unknown>[];
  geofences: { type: string; features: unknown[] };
  wayfinding: { type: string; features: unknown[] };
};
const venueId = "021d95b0-8177-11f0-8b4a-4db64e3e5bb4";
const floorPlanId = "fa622b60-8180-11f0-8e93-87f6b9a47be8";
const syncedId = `ia-${venueId}`;
const apiKey = "TEST-ONLY-mapping-key-0123456789";
const imageUrl = (spec.floorplans[0]!.image as { url: string }).url;
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
// SYNTHETIC radios and paths in the spec's documented shapes.
const radios = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [25.4401, 65.0605] },
      properties: {
        type: "ibeacon",
        uuid: "x",
        major: 100,
        minor: 200,
        level: 1,
      },
    },
  ],
};
const paths = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "77a6fb9c-befb-46fb-b648-0d73436d70a6",
      properties: { enabled: true },
      geometry: {
        type: "LineString",
        coordinates: [
          [25.44033, 65.06053],
          [25.44034, 65.06054],
        ],
      },
    },
  ],
};

type Route = { status: number; body?: unknown } | "throw";

function iaFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url.slice(indoorAtlasMappingApiBase.length)];
    if (route === "throw") throw new TypeError("network down");
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return { fetch, calls };
}

function routes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/venues": { status: 200, body: spec.venues },
    [`/venues/${venueId}/floorplans`]: { status: 200, body: spec.floorplans },
    [`/venues/${venueId}/geofences/geojson`]: {
      status: 200,
      body: spec.geofences,
    },
    [`/venues/${venueId}/wayfinding/geojson`]: {
      status: 200,
      body: spec.wayfinding,
    },
    [`/venues/${venueId}/radios/geojson`]: { status: 200, body: radios },
    [`/floorplans/${floorPlanId}/paths/geojson`]: { status: 200, body: paths },
    ...extra,
  };
}

function imageFetch(
  respond: () => Response = () =>
    new Response(png, { headers: { "content-type": "image/png" } }),
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: ImageFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return respond();
  };
  return { fetch, calls };
}

async function sync(
  repository: MemoryIndoorVenuesRepository,
  archive: MemoryIndoorAtlasArchiveStore | null,
  routeTable = routes(),
  images = imageFetch(),
  when = "2026-11-10T03:00:00.000Z",
) {
  const logs: string[] = [];
  const ia = iaFetch(routeTable);
  const summary = await syncIndoorAtlasVenues({
    client: createIndoorAtlasClient({ apiKey, fetch: ia.fetch }),
    repository,
    archive,
    fetchImage: images.fetch,
    now: () => new Date(when),
    log: (message) => logs.push(message),
  });
  return { summary, logs, iaCalls: ia.calls, imageCalls: images.calls };
}

test("geofence rings are simplified and capped", async () => {
  const ring = Array.from({ length: 200 }, (_, i) => [
    25.44 + Math.cos(i / 32) / 1000,
    65.06 + Math.sin(i / 32) / 1000,
  ]);
  const simplified = simplifyRing([...ring, ring[0]!])!;
  assert.equal(simplified.length, maxAreaPoints);
  assert.deepEqual(simplified[0], { lat: ring[0]![1], lng: ring[0]![0] });
  assert.equal(
    simplifyRing([
      [1, 1],
      [2, 2],
      [1, 1],
    ]),
    null,
  );
  const polygon = (i: number) => ({
    type: "Feature",
    id: `b${String(i).padStart(7, "0")}-8309-11f0-8a1f-7f0e3a839157`,
    properties: { floor: 1, name: `Zone ${i}` },
    geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
  });
  const repository = new MemoryIndoorVenuesRepository();
  const { summary, logs } = await sync(
    repository,
    null,
    routes({
      [`/venues/${venueId}/geofences/geojson`]: {
        status: 200,
        body: {
          type: "FeatureCollection",
          features: [
            ...Array.from({ length: maxAreas + 3 }, (_, i) => polygon(i)),
            // Malformed polygon (too few points) and a non-polygon geometry.
            {
              ...polygon(999),
              geometry: { type: "Polygon", coordinates: [[[1, 1]]] },
            },
            {
              ...polygon(998),
              geometry: { type: "LineString", coordinates: [] },
            },
          ],
        },
      },
    }),
  );
  const venue = indoorVenueSchema.parse(repository.documents.get(syncedId));
  assert.equal(venue.areas!.length, maxAreas);
  assert.equal(summary.areas, maxAreas);
  assert.ok(venue.areas!.every((area) => area.ring.length === maxAreaPoints));
  assert.ok(logs.some((line) => /over 100 areas/.test(line)));
  assert.ok(logs.some((line) => /geofence #\d+ malformed/.test(line)));
  // Polygons never become POIs or exits.
  assert.equal(venue.pois.length, 0);
});

test("venues without IndoorAtlas validate; public schema keeps address and areas", () => {
  const library = loadSeedVenues().find((venue) => venue.id === "nu-library")!;
  assert.equal(indoorVenueSchema.safeParse(library).success, true);
  const { notes: _notes, enabled: _enabled, ...listed } = library;
  void _notes;
  void _enabled;
  assert.equal(
    publicIndoorVenueSchema.safeParse({
      ...listed,
      address: "Furo-cho, Chikusa-ku",
      origin: "seed",
      rank: 2,
      primary: false,
    }).success,
    true,
  );
  // Nested arrays (Firestore cannot store them) are not accepted in areas.
  assert.equal(
    indoorVenueSchema.safeParse({
      ...library,
      areas: [{ id: "a", floorLevel: 1, ring: [[1, 2]] }],
    }).success,
    false,
  );
  assert.equal(defaultVenueCacheMs, 60_000);
});

test("sync schedule is every 5 minutes in the setup script", () => {
  const script = readFileSync(
    new URL("../../infra/setup-cloud-jobs.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /ensure_schedule indooratlas-sync-every-15-minutes indooratlas-sync "\*\/5 \* \* \* \*"/,
  );
});

async function imageSetup(options: {
  routeTable?: Record<string, Route>;
  images?: ReturnType<typeof imageFetch>;
  withKey?: boolean;
  archive?: MemoryIndoorAtlasArchiveStore;
}) {
  const repository = new MemoryIndoorVenuesRepository();
  await sync(repository, null);
  const clock = { t: 0 };
  const venues = new IndoorVenueService({
    repository,
    seed: loadSeedVenues(),
    now: () => clock.t,
  });
  const ia = iaFetch(options.routeTable ?? routes());
  const images = options.images ?? imageFetch();
  const warnings: string[] = [];
  const service = new FloorPlanImageService({
    venues,
    client:
      options.withKey === false
        ? null
        : createIndoorAtlasClient({ apiKey, fetch: ia.fetch }),
    archive: options.archive ? archiveImageSource(options.archive) : null,
    fetchImage: images.fetch,
    now: () => clock.t,
    maxBytes: 64,
    warn: (message) => warnings.push(message),
  });
  return {
    app: createApp({ indoorVenues: venues, floorPlanImages: service }),
    ia,
    images,
    clock,
    warnings,
  };
}

test("image proxy serves known floor plans only, with caching and ETag", async () => {
  const { app, ia, images, clock, warnings } = await imageSetup({});
  const url = `/api/indoor/floorplans/${floorPlanId}/image`;
  const first = await request(app).get(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-type"], "image/png");
  assert.equal(first.headers["cache-control"], "public, max-age=300");
  assert.ok(first.headers.etag);
  assert.deepEqual(Buffer.from(first.body as Buffer), png);
  // The key goes to the Mapping API only; the image host gets no credentials.
  assert.ok(ia.calls.every((call) => call.headers["x-api-key"] === apiKey));
  assert.deepEqual(
    images.calls.map((call) => call.url),
    [imageUrl],
  );
  assert.ok(
    images.calls.every((call) => !JSON.stringify(call).includes(apiKey)),
  );
  // Cached: no new upstream calls; If-None-Match → 304.
  const again = await request(app)
    .get(url)
    .set("If-None-Match", first.headers.etag!);
  assert.equal(again.status, 304);
  assert.equal(images.calls.length, 1);
  clock.t = floorPlanImageCacheMs + 1;
  await request(app).get(url);
  assert.equal(images.calls.length, 2);
  // Unknown or malformed IDs never reach IndoorAtlas: not an open proxy.
  const before = ia.calls.length;
  for (const id of [
    "11111111-2222-4333-8444-555555555555",
    "not-a-uuid",
    "..%2F..%2Fvenues",
  ]) {
    const response = await request(app).get(
      `/api/indoor/floorplans/${id}/image`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(ia.calls.length, before);
  assert.ok(
    warnings.every(
      (line) => !line.includes(apiKey) && !line.includes(imageUrl),
    ),
  );
});

test("image proxy rejects oversized and non-image responses; no key → 503", async () => {
  const url = `/api/indoor/floorplans/${floorPlanId}/image`;
  const big = await imageSetup({
    images: imageFetch(
      () =>
        new Response(Buffer.concat([png, Buffer.alloc(100)]), {
          headers: { "content-type": "image/png" },
        }),
    ),
  });
  const tooBig = await request(big.app).get(url);
  assert.equal(tooBig.status, 502);
  assert.deepEqual(tooBig.body, { error: "UPSTREAM_UNAVAILABLE" });
  assert.match(big.warnings.join("\n"), /too large/);
  const html = await imageSetup({
    images: imageFetch(
      () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
    ),
  });
  assert.equal((await request(html.app).get(url)).status, 502);
  // Declared PNG but HTML bytes.
  const lying = await imageSetup({
    images: imageFetch(
      () =>
        new Response("<html></html>", {
          headers: { "content-type": "image/png" },
        }),
    ),
  });
  assert.equal((await request(lying.app).get(url)).status, 502);
  const noKey = await imageSetup({ withKey: false });
  const response = await request(noKey.app).get(url);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: "NOT_CONFIGURED" });
  // Default app (no key, seed only): unknown floor plan → 404.
  assert.equal((await request(createApp()).get(url)).status, 404);
});

test("image proxy serves the archived copy first", async () => {
  const archive = new MemoryIndoorAtlasArchiveStore();
  await archive.putObject(
    `floorplans/${floorPlanId}/abc.png`,
    png,
    "image/png",
  );
  const { app, ia, images } = await imageSetup({ archive, withKey: false });
  const response = await request(app).get(
    `/api/indoor/floorplans/${floorPlanId}/image`,
  );
  assert.equal(response.status, 200);
  assert.equal(ia.calls.length, 0);
  assert.equal(images.calls.length, 0);
});

test("raw archive: complete snapshot, image stored by hash, no URL or key", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const archive = new MemoryIndoorAtlasArchiveStore();
  const { summary, iaCalls } = await sync(repository, archive);
  assert.equal(summary.archived, 1);
  const meta = archive.metas.get(venueId)!;
  assert.equal(meta.history.length, 1);
  assert.equal(meta.fetchedAt, "2026-11-10T03:00:00.000Z");
  assert.match(meta.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(meta.counts, {
    floorPlans: 1,
    geofenceFeatures: 2,
    wayfindingFeatures: spec.wayfinding.features.length,
    radios: 1,
    pathFeatures: 1,
    images: 1,
  });
  const snapshot = JSON.parse(
    archive.objects.get(meta.snapshotPath)!.bytes.toString("utf8"),
  ) as RawVenueSnapshot;
  assert.deepEqual(snapshot.venue, spec.venues[0]);
  assert.deepEqual(snapshot.geofences, spec.geofences);
  assert.deepEqual(snapshot.wayfinding, spec.wayfinding);
  assert.deepEqual(snapshot.radios, radios);
  assert.deepEqual(snapshot.paths, { [floorPlanId]: paths });
  const plan = snapshot.floorPlans[0] as {
    image: Record<string, unknown>;
    storedImage: { path: string };
  };
  // Every floor plan field except the expiring URL.
  assert.equal(plan.image.url, undefined);
  assert.equal(plan.image.metersToPixels, 10);
  assert.equal(plan.image.pixelsToMeters, 0.1);
  assert.deepEqual(plan.image.topLeft, { lat: 65.0608881, lon: 25.4396979 });
  assert.match(
    plan.storedImage.path,
    new RegExp(`^floorplans/${floorPlanId}/[0-9a-f]{32}\\.png$`),
  );
  assert.deepEqual(archive.objects.get(plan.storedImage.path)!.bytes, png);
  // Every documented read endpoint was called, GET only.
  for (const path of [
    "/venues",
    `/venues/${venueId}/floorplans`,
    `/venues/${venueId}/geofences/geojson`,
    `/venues/${venueId}/wayfinding/geojson`,
    `/venues/${venueId}/radios/geojson`,
    `/floorplans/${floorPlanId}/paths/geojson`,
  ])
    assert.ok(
      iaCalls.some((call) => call.url === indoorAtlasMappingApiBase + path),
      path,
    );
  const stored = [...archive.objects.values()]
    .map((o) => o.bytes.toString("latin1"))
    .join("");
  assert.ok(!stored.includes(apiKey));
  assert.ok(!stored.includes(imageUrl));
  assert.ok(!JSON.stringify([...archive.metas.values()]).includes(apiKey));
});

test("raw archive: unchanged content is not rewritten; history keeps the last 10", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const archive = new MemoryIndoorAtlasArchiveStore();
  const images = imageFetch();
  await sync(repository, archive, routes(), images);
  const writes = archive.writes;
  const again = await sync(
    repository,
    archive,
    routes(),
    images,
    "2026-11-10T03:05:00.000Z",
  );
  assert.equal(again.summary.archived, 0);
  assert.equal(archive.writes, writes);
  // Unchanged floor plan: the image is not downloaded again.
  assert.equal(images.calls.length, 1);
  for (let i = 0; i < rawHistoryLimit + 3; i++) {
    const renamed = [{ ...spec.venues[0], name: `Office ${i}` }];
    const { summary } = await sync(
      repository,
      archive,
      routes({ "/venues": { status: 200, body: renamed } }),
      images,
      new Date(Date.UTC(2026, 10, 11, 0, i)).toISOString(),
    );
    assert.equal(summary.archived, 1);
  }
  const meta = archive.metas.get(venueId)!;
  assert.equal(meta.history.length, rawHistoryLimit);
  assert.equal(meta.history[0]!.contentHash, meta.contentHash);
  const snapshots = [...archive.objects.keys()].filter((key) =>
    key.startsWith("raw/"),
  );
  assert.deepEqual(
    snapshots.sort(),
    meta.history.map((entry) => entry.snapshotPath).sort(),
  );
  // The app document follows the rename too.
  assert.equal(
    indoorVenueSchema.parse(repository.documents.get(syncedId)).name.en,
    `Office ${rawHistoryLimit + 2}`,
  );
});

test("raw archive: radios and paths 404 are null; archive failures never fail the sync", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const archive = new MemoryIndoorAtlasArchiveStore();
  const table = routes();
  delete table[`/venues/${venueId}/radios/geojson`];
  delete table[`/floorplans/${floorPlanId}/paths/geojson`];
  const failingImage = imageFetch(() => new Response("nope", { status: 403 }));
  const { logs } = await sync(repository, archive, table, failingImage);
  const meta = archive.metas.get(venueId)!;
  const snapshot = JSON.parse(
    archive.objects.get(meta.snapshotPath)!.bytes.toString("utf8"),
  ) as RawVenueSnapshot;
  assert.equal(snapshot.radios, null);
  assert.deepEqual(snapshot.paths, { [floorPlanId]: null });
  assert.equal(
    (snapshot.floorPlans[0] as { storedImage: unknown }).storedImage,
    null,
  );
  assert.ok(
    logs.some((line) =>
      /image not archived \(image host answered HTTP 403\)/.test(line),
    ),
  );
  // Storage outage: the venue document is still synced.
  const broken = new MemoryIndoorAtlasArchiveStore();
  broken.putObject = async () => {
    throw new Error("bucket missing");
  };
  const fresh = new MemoryIndoorVenuesRepository();
  const result = await sync(fresh, broken);
  assert.equal(result.summary.updated, 1);
  assert.ok(
    result.logs.some((line) =>
      /raw archive failed \(bucket missing\)/.test(line),
    ),
  );
});

test("export command and private raw route", async () => {
  const repository = new MemoryIndoorVenuesRepository();
  const archive = new MemoryIndoorAtlasArchiveStore();
  await sync(repository, archive);
  const files = new Map<string, string | Buffer>();
  const lines = await runIndoorVenuesCommand(["export", "all", "out"], {
    repository,
    seed: loadSeedVenues(),
    readJson: async () => ({}),
    archive,
    writeFile: async (path, data) => {
      files.set(path, data);
    },
  });
  assert.match(lines.join("\n"), /Exported 021d95b0/);
  const base = `out/${venueId}`;
  assert.deepEqual([...files.keys()].sort(), [
    `${base}/floorplans.json`,
    `${base}/geofences.geojson`,
    `${base}/images/${floorPlanId}.png`,
    `${base}/meta.json`,
    `${base}/paths/${floorPlanId}.geojson`,
    `${base}/radios.geojson`,
    `${base}/snapshot.json`,
    `${base}/venue.json`,
    `${base}/wayfinding.geojson`,
  ]);
  assert.deepEqual(files.get(`${base}/images/${floorPlanId}.png`), png);
  assert.ok(
    [...files.values()].every((data) => !data.toString().includes(apiKey)),
  );
  // Not configured.
  await assert.rejects(
    runIndoorVenuesCommand(["export", "all", "out"], {
      repository,
      seed: loadSeedVenues(),
      readJson: async () => ({}),
    }),
    /INDOORATLAS_ARCHIVE_BUCKET/,
  );
  // Private route on the jobs service; the public app has no such route.
  const { context } = testContext();
  const jobsApp = createApp({
    jobs: {
      ...context,
      indoorAtlas: { client: null, venues: repository, archive },
    },
  });
  const raw = await request(jobsApp).get(`/jobs/indooratlas/raw/${venueId}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.snapshot.venueId, venueId);
  assert.equal(
    (await request(jobsApp).get("/jobs/indooratlas/raw/nope")).status,
    404,
  );
  assert.equal(
    (await request(createApp()).get(`/jobs/indooratlas/raw/${venueId}`)).status,
    404,
  );
  assert.equal(
    (await request(createApp()).get(`/api/indoor/raw/${venueId}`)).status,
    404,
  );
});
