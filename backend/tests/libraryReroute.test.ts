import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";

test("library reroute validates physical segment claims and refuses disconnected exits", async () => {
  const endpoint = "/api/indoor/library-reroute";
  const body = {
    from: "lib-2-service",
    destination: "exit",
    blockedEdges: [{ from: "lib-2-service", to: "lib-2-hall" }],
  };
  const good = await request(app).post(endpoint).send(body);
  assert.equal(good.status, 200);
  assert.equal(good.body.requiresFieldSurvey, true);
  assert.equal(good.body.nodes.at(-1).id, "lib-2-exit");
  assert.equal(good.body.usesLift, false);
  assert.equal(
    (
      await request(app)
        .post(endpoint)
        .send({
          ...body,
          blockedEdges: [{ from: "lib-2-exit", to: "lib-2-hall" }],
        })
    ).status,
    422,
  );
  assert.equal(
    (
      await request(app)
        .post(endpoint)
        .send({
          ...body,
          blockedEdges: [{ from: "missing", to: "lib-2-hall" }],
        })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post(endpoint)
        .send({ ...body, blockedEdges: [] })
    ).status,
    400,
  );
  const stairs = await request(app)
    .post(endpoint)
    .send({ ...body, destination: "stairs" });
  assert.equal(stairs.status, 200);
  assert.ok(stairs.body.nodes.every((n: { floor: number }) => n.floor === 2));
});
