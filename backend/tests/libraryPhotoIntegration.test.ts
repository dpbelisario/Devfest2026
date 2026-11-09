import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createLiveContext } from "../src/services/createLiveContext.js";
import { LibraryLocalizationService } from "../src/services/libraryLocalizationService.js";

test("the real app accepts a bounded photo above its ordinary JSON limit and keeps confirmation required", async () => {
  const live = createLiveContext(
    parseConfig({ LIVE_DATA_STORE: "memory", ASSISTANT_ENABLED: "false" }),
  )!;
  live.libraryLocalizer = new LibraryLocalizationService(async () => ({
    parts: [
      {
        text: '{"candidates":[{"checkpointId":"lib-2-service","observedText":"Service Desk"}]}',
      },
    ],
  }));
  const html = readFileSync(
    new URL("../../android/app/src/main/assets/contour.html", import.meta.url),
    "utf8",
  );
  const maps = JSON.parse(
    html.match(
      /<script type="application\/json" id="libraryFloorMaps">(.*?)<\/script>/s,
    )![1]!,
  ) as { image: string }[];
  const imageBase64 = maps[0]!.image.split(",")[1]!;
  assert.ok(imageBase64.length > 16000);
  const response = await request(createApp({ live }))
    .post("/api/indoor/localize-photo")
    .send({ mimeType: "image/jpeg", imageBase64 });
  assert.equal(response.status, 200);
  assert.equal(response.body.requiresConfirmation, true);
  assert.equal(response.body.candidates[0].checkpointId, "lib-2-service");
  assert.equal(response.body.candidates[0].x, undefined);
  assert.equal(
    (
      await request(createApp())
        .post("/api/indoor/localize-photo")
        .send({ mimeType: "image/jpeg", imageBase64 })
    ).status,
    503,
  );
});
