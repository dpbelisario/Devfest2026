import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createWebAppRouter } from "../src/routes/webApp.js";

await test("Maps config exposes only the public browser key and cannot be cached", async () => {
  const app = express().use(
    "/app",
    createWebAppRouter("AIzaPublicBrowserKeyForTestingOnly123456"),
  );
  const response = await request(app).get("/app/maps-config").expect(200);
  assert.deepEqual(response.body, {
    browserKey: "AIzaPublicBrowserKeyForTestingOnly123456",
  });
  assert.equal(response.headers["cache-control"], "no-store");
});
await test("Missing Maps config disables Google without breaking the app page", async () => {
  const app = express().use("/app", createWebAppRouter(""));
  const response = await request(app).get("/app/maps-config").expect(200);
  assert.deepEqual(response.body, { browserKey: "" });
  await request(app).get("/app/").expect(200);
});
