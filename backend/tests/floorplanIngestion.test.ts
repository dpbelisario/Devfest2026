import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { IndoorAtlasClient } from "../src/services/indoorAtlasClient.js";
import { mapIndoorAtlasVenue } from "../src/services/indoorAtlasSync.js";
import {
  buildGeofenceFeatures,
  buildWayfindingFeatures,
  checkProposal,
  createIndoorAtlasWriter,
  floorPlanProposalSchema,
  imageToLngLat,
  labelsToProposal,
  parseLabels,
  planGeofences,
  planWayfinding,
  publishFloorPlanProposal,
  PublishError,
  restoreFloorPlanBackup,
  uuidV1,
  type FloorPlanBackup,
  type FloorPlanProposal,
  type IndoorAtlasWriter,
  type PlanCorners,
} from "../src/services/floorplanIngestion/index.js";

const sai = floorPlanProposalSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../data/floorplans/sai-dining-2f.json", import.meta.url),
      "utf8",
    ),
  ),
);
const venueId = "4402be90-dbff-11f1-95cb-e11cd22c6739";
const planId = "20d4186e-18ea-4ede-a8d2-1eef231a3134";
/** SAI Dining 2F placement as returned by GET /venues/{id}/floorplans. */
const floorPlan = {
  id: planId,
  venueId,
  name: "2F",
  floorNumber: 2,
  image: {
    url: "https://example.invalid/plan.png",
    width: 1273,
    height: 1800,
    topLeft: { lat: 35.15370107155422, lon: 136.96256506488285 },
    topRight: { lat: 35.15349206281189, lon: 136.96309621733133 },
    bottomLeft: { lat: 35.15308424446702, lon: 136.96220522921433 },
    bottomRight: { lat: 35.15287523572469, lon: 136.9627363816628 },
  },
};
const corners: PlanCorners = floorPlan.image;

const foreignPoi = {
  type: "Feature",
  id: "11111111-1111-11f1-8111-111111111111",
  properties: { floor: 2, name: "Cash desk / レジ", description: "by hand" },
  geometry: { type: "Point", coordinates: [136.9626, 35.1533] },
};

/** Fake read client over an in-memory venue. */
function fakeVenue(state: {
  geofences: unknown[] | null;
  wayfinding: unknown[] | null;
  plans?: unknown[];
}): IndoorAtlasClient {
  return {
    async get(path) {
      if (path === `/venues/${venueId}/floorplans`)
        return { status: "ok", body: state.plans ?? [floorPlan] };
      const collection = path.endsWith("/geofences/geojson")
        ? state.geofences
        : path.endsWith("/wayfinding/geojson")
          ? state.wayfinding
          : undefined;
      if (collection === undefined) throw new Error(`unexpected GET ${path}`);
      return collection === null
        ? { status: "notFound" }
        : {
            status: "ok",
            body: { type: "FeatureCollection", features: collection },
          };
    },
  };
}

function recordingWriter(state: {
  geofences: unknown[] | null;
  wayfinding: unknown[] | null;
}) {
  const puts: { path: string; body: unknown }[] = [];
  const writer: IndoorAtlasWriter = {
    async put(path, body) {
      puts.push({ path, body });
      const features = (body as { features: unknown[] }).features;
      if (path.endsWith("/geofences/geojson")) state.geofences = features;
      else state.wayfinding = features;
    },
  };
  return { writer, puts };
}

test("the SAI Dining proposal is consistent and reviewed", () => {
  assert.deepEqual(checkProposal(sai), []);
  assert.equal(sai.review.status, "reviewed");
  assert.equal(sai.venue.indoorAtlasVenueId, venueId);
  assert.equal(sai.floor.floorPlanId, planId);
  assert.deepEqual(
    sai.pois.map((poi) => poi.kind),
    ["exit", "entrance", "stairs", "toilet"],
  );
});

test("image corners map onto the floor plan corners", () => {
  const near = (a: number[], b: number[]) =>
    assert.ok(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) < 1e-6, `${a} ≉ ${b}`);
  near(imageToLngLat([0, 0], corners), [136.96256506488285, 35.15370107155422]);
  near(imageToLngLat([1, 0], corners), [136.96309621733133, 35.15349206281189]);
  near(imageToLngLat([0, 1], corners), [136.96220522921433, 35.15308424446702]);
  near(imageToLngLat([1, 1], corners), [136.9627363816628, 35.15287523572469]);
});

test("published features satisfy the app sync contract (exits, names, graph)", () => {
  const geofences = buildGeofenceFeatures(sai, corners);
  const wayfinding = buildWayfindingFeatures(sai, corners);
  assert.equal(geofences.length, 6);
  assert.equal(wayfinding.length, 19);
  for (const edge of wayfinding)
    for (const point of edge.geometry.coordinates) assert.equal(point[2], 2);
  const venue = mapIndoorAtlasVenue(
    {
      venue: {
        id: venueId,
        name: "SAI Dining / 生協南部食堂",
        coordinates: { lat: 35.15329, lon: 136.96268 },
      },
      order: 0,
      floorPlans: [floorPlan],
      geofenceFeatures: geofences,
      wayfindingFeatures: wayfinding,
    },
    { updatedAt: "2026-11-10T00:00:00.000Z" },
  );
  assert.ok(venue);
  assert.deepEqual(
    venue.exits.map((exit) => [exit.name.en, exit.name.ja, exit.kind]),
    [
      ["Exit", "出口", "exit"],
      ["Entrance", "入口", "entrance"],
      ["Stairs and elevator", "階段・EV", "stairs"],
    ],
  );
  assert.equal(venue.pois.length, 4);
  assert.equal(venue.areas?.length, 2);
  assert.equal(venue.indoorAtlas?.hasWayfinding, true);
  // Every POI sits inside the venue gate.
  for (const poi of venue.pois) {
    const dLat = (poi.lat! - venue.location.lat) * 111_000;
    const dLng =
      (poi.lng! - venue.location.lng) *
      111_000 *
      Math.cos((venue.location.lat * Math.PI) / 180);
    assert.ok(Math.hypot(dLat, dLng) < venue.location.radiusM);
  }
});

test("checkProposal catches names the app would misread and broken graphs", () => {
  const broken: FloorPlanProposal = structuredClone(sai);
  broken.pois[3]!.name = "Toilets near the exit / トイレ";
  broken.pois[0]!.description = "Verified on site";
  broken.graph.edges.push(["exit", "nowhere"]);
  broken.graph.nodes.push({ id: "island", at: [0.1, 0.1] });
  const problems = checkProposal(broken).join("\n");
  assert.match(problems, /toilet but the app would read it as exit/);
  assert.match(problems, /claims to be verified/);
  assert.match(problems, /exit → nowhere/);
  assert.match(problems, /island cannot be reached/);
});

test("planGeofences keeps foreign features, reports name conflicts, is idempotent", () => {
  const ours = buildGeofenceFeatures(sai, corners);
  const clash = { ...foreignPoi, id: "22222222-2222-11f1-8222-222222222222" };
  clash.properties = { ...clash.properties, name: "EXIT / 出口" };
  const first = planGeofences([foreignPoi, clash], ours);
  assert.equal(first.kept, 2);
  assert.equal(first.added.length, 6);
  assert.deepEqual(first.conflicts, [
    "EXIT / 出口 (22222222-2222-11f1-8222-222222222222)",
  ]);
  const replaced = planGeofences([foreignPoi, clash], ours, {
    replaceConflicts: true,
  });
  assert.equal(replaced.kept, 1);
  assert.equal(replaced.replaced.length, 1);
  const again = planGeofences(replaced.features, ours);
  assert.equal(again.changed, false);
  assert.equal(again.unchanged.length, 6);
  assert.equal(again.features.length, 7);
});

test("planWayfinding merges without duplicates, or replaces on request", () => {
  const ours = buildWayfindingFeatures(sai, corners);
  const reversed = {
    ...ours[0]!,
    geometry: {
      ...ours[0]!.geometry,
      coordinates: [...ours[0]!.geometry.coordinates].reverse(),
    },
  };
  const other = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [136.1, 35.1, 1],
        [136.2, 35.2, 1],
      ],
    },
  };
  const merged = planWayfinding([reversed, other], ours);
  assert.equal(merged.added, 18);
  assert.equal(merged.features.length, 20);
  assert.equal(planWayfinding(merged.features, ours).changed, false);
  const replaced = planWayfinding([other], ours, { replaceGraph: true });
  assert.equal(replaced.features.length, 19);
  assert.equal(replaced.removed, 1);
});

test("publish dry run reads and plans but writes nothing", async () => {
  const state = { geofences: [foreignPoi], wayfinding: null };
  const { writer, puts } = recordingWriter(state);
  const report = await publishFloorPlanProposal(sai, {
    client: fakeVenue(state),
    writer,
    saveBackup: async () => assert.fail("no backup on a dry run"),
    now: () => new Date("2026-11-10T03:00:00Z"),
  });
  assert.equal(report.applied, false);
  assert.equal(puts.length, 0);
  assert.equal(report.geofences.added.length, 6);
  assert.equal(report.wayfinding?.added, 19);
  assert.match(report.lines.at(-1)!, /Dry run/);
});

test("publish --apply backs up, writes the merged documents, then is a no-op", async () => {
  const state: { geofences: unknown[] | null; wayfinding: unknown[] | null } = {
    geofences: [foreignPoi],
    wayfinding: null,
  };
  const { writer, puts } = recordingWriter(state);
  const backups: FloorPlanBackup[] = [];
  const dependencies = {
    client: fakeVenue(state),
    writer,
    saveBackup: async (backup: FloorPlanBackup) => {
      backups.push(structuredClone(backup));
      return `backup-${backup.kind}`;
    },
    now: () => new Date("2026-11-10T03:00:00Z"),
  };
  const report = await publishFloorPlanProposal(sai, dependencies, {
    apply: true,
  });
  assert.equal(report.applied, true);
  assert.deepEqual(
    puts.map((put) => put.path),
    [
      `/venues/${venueId}/geofences/geojson`,
      `/venues/${venueId}/wayfinding/geojson`,
    ],
  );
  assert.equal(state.geofences?.length, 7);
  assert.equal(state.wayfinding?.length, 19);
  assert.deepEqual(
    backups.map((backup) => [backup.kind, backup.body.features.length]),
    [
      ["geofences", 1],
      ["wayfinding", 0],
    ],
  );
  const second = await publishFloorPlanProposal(sai, dependencies, {
    apply: true,
  });
  assert.equal(puts.length, 2);
  assert.match(second.lines.at(-1)!, /Nothing to change/);

  await restoreFloorPlanBackup(backups[0]!, writer);
  assert.deepEqual(state.geofences, [foreignPoi]);
});

test("publish refuses unreviewed proposals, conflicts and mismatched plans", async () => {
  const state = { geofences: [], wayfinding: [] };
  const { writer } = recordingWriter(state);
  const dependencies = {
    client: fakeVenue(state),
    writer,
    saveBackup: async () => "x",
    now: () => new Date(),
  };
  const draft = structuredClone(sai);
  draft.review.status = "proposed";
  await assert.rejects(
    publishFloorPlanProposal(draft, dependencies, { apply: true }),
    /Only reviewed proposals/,
  );
  const clash = {
    ...foreignPoi,
    properties: { ...foreignPoi.properties, name: "Exit / 出口" },
  };
  await assert.rejects(
    publishFloorPlanProposal(
      sai,
      {
        ...dependencies,
        client: fakeVenue({ geofences: [clash], wayfinding: [] }),
      },
      { apply: true },
    ),
    (error) => error instanceof PublishError && /Conflicts/.test(error.message),
  );
  const cropped = {
    ...floorPlan,
    image: { ...floorPlan.image, width: 1800, height: 1273 },
  };
  await assert.rejects(
    publishFloorPlanProposal(sai, {
      ...dependencies,
      client: fakeVenue({ geofences: [], wayfinding: [], plans: [cropped] }),
    }),
    /different crop/,
  );
  await assert.rejects(
    publishFloorPlanProposal(sai, {
      ...dependencies,
      client: fakeVenue({
        geofences: [],
        wayfinding: [],
        plans: [{ ...floorPlan, floorNumber: 3 }],
      }),
    }),
    /floor 3/,
  );
});

test("the writer sends the key in a header only and keeps it out of errors", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const writer = createIndoorAtlasWriter({
    apiKey: "secret-key",
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return calls.length === 1
        ? new Response(null, { status: 200 })
        : new Response("bad id secret-key", { status: 400 });
    },
  });
  await writer.put("/venues/x/geofences/geojson", {
    type: "FeatureCollection",
  });
  assert.equal(calls[0]!.headers["x-api-key"], "secret-key");
  assert.ok(!calls[0]!.url.includes("secret-key"));
  await assert.rejects(
    writer.put("/venues/x/geofences/geojson", {}),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("secret-key"));
      assert.match(error.message, /HTTP 400/);
      return true;
    },
  );
});

test("OCR labels become a proposed, deterministic proposal", () => {
  const sample = readFileSync(
    new URL("./fixtures/floorplan-ocr-sample.json", import.meta.url),
    "utf8",
  );
  const { labels, dropped } = parseLabels(sample);
  assert.equal(labels.length, 6);
  assert.equal(dropped, 1);
  let counter = 0;
  const proposal = labelsToProposal(labels, {
    venue: sai.venue,
    floor: sai.floor,
    source: { kind: "event-map", title: "避難経路図 sample" },
    now: new Date("2026-11-10T00:00:00Z"),
    random: () => Buffer.alloc(10, ++counter),
  });
  assert.equal(proposal.review.status, "proposed");
  assert.deepEqual(
    proposal.pois.map((poi) => [poi.name, poi.kind, poi.confidence]),
    [
      ["Exit / 出口", "exit", 0.95],
      ["Toilets / トイレ", "toilet", 0.9],
      ["Entrance / 入口", "entrance", 0.9],
      // The keyword rule (階段 → stairs) overrides the model and halves confidence.
      ["Stairs and elevator / 階段・EV", "stairs", 0.43],
    ],
  );
  assert.match(proposal.review.note ?? "", /机・椅子置場/);
  assert.deepEqual(checkProposal(proposal), []);
  assert.ok(floorPlanProposalSchema.safeParse(proposal).success);
  assert.deepEqual(proposal.pois[0]!.at, [0.823, 0.2495]);
});

test("uuidV1 produces version-1 ids that IndoorAtlas accepts", () => {
  const id = uuidV1(new Date("2026-11-10T00:00:00Z"), Buffer.alloc(10, 7));
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(
    id,
    uuidV1(new Date("2026-11-10T00:00:01Z"), Buffer.alloc(10, 7)),
  );
});
