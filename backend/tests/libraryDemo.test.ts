import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("all five official library maps remain available in the offline page", () => {
  const html = readFileSync(
    new URL("../../android/app/src/main/assets/contour.html", import.meta.url),
    "utf8",
  );
  const embedded = html.match(
    /<script type="application\/json" id="libraryFloorMaps">(.*?)<\/script>/s,
  );
  assert.ok(embedded);
  const maps = JSON.parse(embedded[1]!) as {
    floor: string;
    image: string;
  }[];
  assert.deepEqual(
    maps.map((map) => map.floor),
    ["B1", "1F", "2F", "3F", "4F"],
  );
  for (const map of maps) {
    assert.ok(map.image.startsWith("data:image/jpeg;base64,"));
    const bytes = Buffer.from(map.image.split(",")[1]!, "base64");
    assert.ok(bytes.length > 50000);
    assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(bytes.subarray(-2).toString("hex"), "ffd9");
  }
});
