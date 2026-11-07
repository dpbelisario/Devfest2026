import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { app } from "../src/app.js";
import { indoorAskSchema } from "../src/schemas/indoor.js";
import { answerIndoorQuestion } from "../src/services/indoorAssistantService.js";

const ask = (input: Record<string, unknown>) =>
  answerIndoorQuestion(indoorAskSchema.parse(input));

test("room 221 resolves to Engineering II middle wing 2F without guessing the start", () => {
  const response = ask({
    message:
      "hey how do I get to room 221 of the building I'm in (Engineering Building II Nagoya)",
  });
  assert.equal(response.status, "need-checkpoint");
  assert.equal(response.context.buildingId, "nu-eng2");
  assert.equal(response.context.destinationId, "eng2-221");
  assert.match(response.reply, /2F/);
  assert.equal(response.route, undefined);
});

test("GPS suggests a building but does not invent an indoor floor or checkpoint", () => {
  const response = ask({
    message: "How do I get to room 221?",
    location: {
      lat: 35.15583615,
      lng: 136.9646781,
      accuracyMeters: 10,
      source: "gps",
    },
  });
  assert.equal(response.status, "need-building");
  assert.match(response.reply, /GPS.*Are you inside/);
  assert.equal(response.context.buildingId, undefined);
  assert.equal(response.route, undefined);
  const demo = ask({
    message: "How do I get to room 221?",
    location: {
      lat: 35.15583615,
      lng: 136.9646781,
      accuracyMeters: 10,
      source: "demo",
    },
  });
  assert.doesNotMatch(demo.reply, /GPS/);
});

test("building and checkpoint confirmation retain the destination", () => {
  const response = ask({
    message: "Engineering Building II",
    context: { buildingId: "nu-eng2", destinationId: "221" },
  });
  assert.equal(response.status, "need-checkpoint");
  const ready = ask({
    message: "Start here",
    context: { ...response.context, checkpointId: "eng2-office-3" },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.route?.nodes[0]?.id, "eng2-office-3");
  assert.equal(ready.route?.nodes.at(-1)?.id, "eng2-221");
  assert.ok(
    ready.route?.steps.some(
      (step) => step.action === "down" && step.floor === 2,
    ),
  );
  assert.equal(ready.route?.requiresFieldSurvey, true);
  assert.match(ready.reply, /Go down to 2F/);
});

test("spoken starting room and explicit from/to keep origin separate from target", () => {
  const context = { buildingId: "nu-eng2", destinationId: "eng2-221" };
  const response = ask({ message: "I'm at room 231", context });
  assert.equal(response.route?.nodes[0]?.id, "eng2-231");
  assert.equal(response.route?.nodes.at(-1)?.id, "eng2-221");
  const both = ask({
    message: "From room 231 to room 221 in Engineering Building II",
  });
  assert.equal(both.route?.nodes[0]?.id, "eng2-231");
  assert.equal(both.route?.nodes.at(-1)?.id, "eng2-221");
});

test("other buildings and unmapped rooms never inherit Engineering II routes", () => {
  for (const name of ["Engineering Building III", "Engineering Building 3"]) {
    const response = ask({
      message: `Room 221 in ${name}`,
      context: { buildingId: "nu-eng2", checkpointId: "eng2-office-3" },
    });
    assert.equal(response.status, "not-found");
    assert.equal(response.route, undefined);
  }
  const unknown = ask({
    message: "room 999 in Engineering Building II",
    context: { checkpointId: "eng2-office-3" },
  });
  assert.equal(unknown.status, "not-found");
  assert.equal(unknown.route, undefined);
  const pending = ask({
    message: "room 999",
    context: {
      buildingId: "nu-eng2",
      destinationId: "221",
      checkpointId: "eng2-office-3",
    },
  });
  assert.equal(pending.status, "not-found");
  assert.equal(pending.route, undefined);
});

test("route instructions are shared camera actions with explicit alignment", () => {
  const response = ask({
    message: "room 221 in Engineering Building II",
    context: { buildingId: "nu-eng2", checkpointId: "eng2-office-3" },
    language: "ja",
  });
  const route = response.route!;
  assert.equal(route.steps[0]?.action, "align");
  assert.ok(route.steps.some((step) => step.action === "right"));
  assert.ok(
    route.steps.every(
      (step) =>
        typeof step.texts.en === "string" && typeof step.texts.ja === "string",
    ),
  );
  assert.match(response.reply, /2階/);
  const accessible = ask({
    message: "room 221 in Engineering Building II",
    context: { buildingId: "nu-eng2", checkpointId: "eng2-office-3" },
    avoidStairs: true,
  });
  assert.equal(accessible.route?.usesLift, true);
});

test("indoor chat validates input and supports bundled-page CORS preflight", async () => {
  assert.equal(
    (await request(app).post("/api/indoor/ask").send({ message: "" })).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/indoor/ask")
        .send({
          message: "room 221",
          location: { lat: 100, lng: 0, source: "gps" },
        })
    ).status,
    400,
  );
  const response = await request(app)
    .post("/api/indoor/ask")
    .send({ message: "room 221 in Engineering Building II" });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "need-checkpoint");
  const options = await request(app)
    .options("/api/indoor/ask")
    .set("Origin", "https://appassets.androidplatform.net")
    .set("Access-Control-Request-Headers", "Content-Type");
  assert.equal(options.status, 204);
  assert.equal(options.headers["access-control-allow-origin"], "*");
  assert.equal(options.headers["access-control-allow-headers"], "Content-Type");
});
