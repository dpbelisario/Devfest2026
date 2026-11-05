import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
test("health is available", async () => {
  const r = await request(app).get("/health");
  assert.equal(r.status, 200);
});
test("UI page is served without stale caching", async () => {
  const r = await request(app).get("/app/");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"] ?? "", /text\/html/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.match(r.text, /ContourApp/);
});
test("invalid and missing coordinates are rejected", async () => {
  for (const query of [
    "",
    "?lat=91&lng=139&disaster=earthquake",
    "?lat=35&lng=139&disaster=invalid",
    "?lat=&lng=139&disaster=earthquake",
  ]) {
    const r = await request(app).get(`/destinations${query}`);
    assert.equal(r.status, 400);
  }
});
test("destinations are filtered by hazard and radius", async () => {
  const r = await request(app).get(
    "/destinations?lat=35.68&lng=139.767&disaster=earthquake",
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.destinations.length, 1);
  assert.equal(r.body.destinations[0].isDemo, true);
  const flood = await request(app).get(
    "/destinations?lat=35.68&lng=139.767&disaster=flood",
  );
  assert.deepEqual(flood.body.destinations, []);
  const far = await request(app).get(
    "/destinations?lat=0&lng=0&disaster=earthquake",
  );
  assert.deepEqual(far.body.destinations, []);
});
test("routes reject unknown destinations and unsupported origins", async () => {
  assert.equal(
    (
      await request(app).get(
        "/directions?originLat=35.68&originLng=139.767&destinationId=unknown",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(app).get(
        "/directions?originLat=0&originLng=0&destinationId=demo-site-1",
      )
    ).status,
    422,
  );
  const r = await request(app).get(
    "/directions?originLat=35.68&originLng=139.767&destinationId=demo-site-1",
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.waypoints.length, 3);
});
