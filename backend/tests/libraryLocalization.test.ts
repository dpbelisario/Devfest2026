import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createLibraryLocalizationRouter } from "../src/routes/libraryLocalization.js";
import {
  LibraryLocalizationService,
  libraryPhotoSchema,
} from "../src/services/libraryLocalizationService.js";
import { RateLimiter } from "../src/services/rateLimiter.js";

const photo = {
  mimeType: "image/png" as const,
  imageBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGvEAAAAASUVORK5CYII=",
};
const limiter = () =>
  new RateLimiter({ windowMs: 60000, perKeyLimit: 1, totalLimit: 2 });

test("library photo input rejects malformed, mismatched and oversized image data", () => {
  assert.equal(libraryPhotoSchema.safeParse(photo).success, true);
  for (const bad of [
    { ...photo, imageBase64: "data:image/png;base64," + photo.imageBase64 },
    { ...photo, imageBase64: photo.imageBase64 + "\n" },
    { ...photo, mimeType: "image/jpeg" },
    { ...photo, imageBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") },
    { ...photo, floor: 0 },
    { ...photo, floor: "2" },
    { ...photo, imageBase64: "<svg>unsafe</svg>" },
    { ...photo, x: 40 },
  ])
    assert.equal(libraryPhotoSchema.safeParse(bad).success, false);
});

test("photo candidates use only known library IDs and catalog labels, with no position", async () => {
  const service = new LibraryLocalizationService(async (input) => {
    assert.deepEqual(input.contents[0]?.parts?.[1]?.inlineData, {
      mimeType: photo.mimeType,
      data: photo.imageBase64,
    });
    assert.deepEqual(input.tools, []);
    assert.match(input.systemInstruction, /untrusted data/);
    return {
      parts: [
        {
          text: JSON.stringify({
            candidates: [
              { checkpointId: "lib-2-service", observedText: "Service Desk" },
              { checkpointId: "a11", observedText: "A11" },
              { checkpointId: "lib-2-service", observedText: "Service Desk" },
            ],
          }),
        },
      ],
    };
  });
  const result = await service.identify(photo);
  assert.deepEqual(result, {
    status: "candidates",
    buildingId: "nu-library",
    requiresConfirmation: true,
    candidates: [
      {
        checkpointId: "lib-2-service",
        label: "Service Desk · public side",
        floor: 2,
        observedText: "Service Desk",
      },
    ],
  });
  assert.equal(
    (await service.identify({ ...photo, floor: 1 })).status,
    "unknown",
  );
});

test("ambiguous and malformed model results remain unknown instead of positioning the user", async () => {
  for (const text of [
    "not JSON",
    "{}",
    '{"candidates":[]}',
    '{"candidates":[{"checkpointId":"missing","observedText":"Exit"}]}',
    '{"candidates":[{"checkpointId":"lib-2-service","observedText":""}]}',
    '{"candidates":[{"checkpointId":"lib-2-service","observedText":"Service","x":50}]}',
  ]) {
    const service = new LibraryLocalizationService(async () => ({
      parts: [{ text }],
    }));
    const result = await service.identify(photo);
    assert.equal(result.status, "unknown");
    assert.equal(result.requiresConfirmation, true);
    assert.deepEqual(result.candidates, []);
  }
});

test("photo HTTP route bounds requests, rate limits model calls and handles failure privately", async () => {
  let calls = 0;
  const localizer = new LibraryLocalizationService(async () => {
    calls++;
    return { parts: [{ text: '{"candidates":[]}' }] };
  });
  const app = express();
  app.use(
    "/api/indoor/localize-photo",
    createLibraryLocalizationRouter({ localizer, limiter: limiter() }),
  );
  app.use(express.json({ limit: "16kb" }));
  const endpoint = "/api/indoor/localize-photo";
  assert.equal(
    (
      await request(app)
        .post(endpoint)
        .send({ ...photo, mimeType: "image/jpeg" })
    ).status,
    400,
  );
  const good = await request(app).post(endpoint).send(photo);
  assert.equal(good.status, 200);
  assert.equal(good.headers["cache-control"], "no-store");
  assert.equal((await request(app).post(endpoint).send(photo)).status, 429);
  assert.equal(calls, 1);
  const huge = await request(app)
    .post(endpoint)
    .send({ ...photo, imageBase64: "A".repeat(800000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers["access-control-allow-origin"], "*");
  assert.equal((await request(app).options(endpoint)).status, 204);
  assert.equal(
    (
      await request(app)
        .post(endpoint)
        .set("Content-Type", "application/json")
        .send("{")
    ).status,
    400,
  );
  const disabled = express().use(
    endpoint,
    createLibraryLocalizationRouter({ limiter: limiter() }),
  );
  assert.equal(
    (await request(disabled).post(endpoint).send(photo)).status,
    503,
  );
  const broken = express().use(
    endpoint,
    createLibraryLocalizationRouter({
      localizer: new LibraryLocalizationService(async () => {
        throw new Error("provider secret");
      }),
      limiter: limiter(),
    }),
  );
  const failed = await request(broken).post(endpoint).send(photo);
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: "PHOTO_ANALYSIS_UNAVAILABLE" });
});
