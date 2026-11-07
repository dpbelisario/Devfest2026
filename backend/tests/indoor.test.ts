import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { indoorBuildingSchema } from "../src/schemas/indoor.js";
import {
  findIndoorRoute,
  indoorCatalog,
} from "../src/services/indoorService.js";

const building = indoorCatalog.buildings[0]!;

test("room search normalizes full-width and spaced timetable codes", async () => {
  const response = await request(app)
    .get("/api/indoor/rooms")
    .query({ q: "Ａ － ２６" });
  assert.equal(response.status, 200);
  assert.equal(response.body.rooms.length, 1);
  assert.equal(response.body.rooms[0].label, "A26");
  assert.equal(response.body.rooms[0].floor, 2);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["cache-control"], "no-store");
  const unknown = await request(app)
    .get("/api/indoor/rooms")
    .query({ q: "Physics 2026" });
  assert.deepEqual(unknown.body.rooms, []);
});

test("same-floor indoor path stays on the floor and retains survey status", () => {
  const route = findIndoorRoute(building, "a11", "a14", false)!;
  assert.equal(route.mode, "plan-preview");
  assert.equal(route.requiresFieldSurvey, true);
  assert.equal(route.nodes[0]?.id, "a11");
  assert.equal(route.nodes.at(-1)?.id, "a14");
  assert.ok(route.nodes.every((node) => node.floor === 1));
  assert.ok(route.edges.every((edge) => edge.kind === "corridor"));
});

test("avoid-stairs selects a lift connection without claiming accessibility", () => {
  const route = findIndoorRoute(building, "a11", "a34", true)!;
  assert.equal(route.usesLift, true);
  assert.equal(route.requiresFieldSurvey, true);
  assert.ok(route.edges.every((edge) => edge.kind !== "stairs"));
  assert.ok(route.nodes.some((node) => node.floor === 3));
  const stairs = findIndoorRoute(building, "a11", "a31", false)!;
  assert.ok(stairs.edges.some((edge) => edge.kind === "stairs"));
});

test("unknown, disconnected and identical checkpoints are handled", () => {
  assert.equal(findIndoorRoute(building, "unknown", "a11", false), undefined);
  assert.equal(
    findIndoorRoute({ ...building, edges: [] }, "a11", "a12", false),
    undefined,
  );
  const same = findIndoorRoute(building, "a11", "a11", false)!;
  assert.equal(same.nodes.length, 1);
  assert.equal(same.edges.length, 0);
});

test("every pilot room is reachable from the first floor", () => {
  for (const room of building.nodes.filter((node) => node.kind === "room")) {
    assert.ok(findIndoorRoute(building, "a11", room.id, false), room.label);
  }
});

test("route endpoint rejects invalid inputs and returns a plan preview", async () => {
  for (const query of [
    {},
    { buildingId: building.id, from: "a11", to: "a26", avoidStairs: "yes" },
  ]) {
    assert.equal(
      (await request(app).get("/api/indoor/route").query(query)).status,
      400,
    );
  }
  assert.equal(
    (
      await request(app)
        .get("/api/indoor/route")
        .query({ buildingId: building.id, from: "nope", to: "a26" })
    ).status,
    404,
  );
  const response = await request(app).get("/api/indoor/route").query({
    buildingId: building.id,
    from: "a11",
    to: "a26",
    avoidStairs: "true",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, "plan-preview");
  assert.equal(response.body.requiresFieldSurvey, true);
  assert.equal(response.body.usesLift, true);
  assert.equal(response.body.source.url, building.source.url);
  assert.equal("distanceMeters" in response.body, false);
});

test("catalog schema rejects broken connections", () => {
  assert.equal(
    indoorBuildingSchema.safeParse({
      ...building,
      edges: [
        {
          from: "unknown",
          to: "a11",
          kind: "corridor",
          cost: 1,
          surveyed: false,
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    indoorBuildingSchema.safeParse({
      ...building,
      edges: [
        { from: "a11", to: "a26", kind: "corridor", cost: 1, surveyed: false },
      ],
    }).success,
    false,
  );
});
