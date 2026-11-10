import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(
  new URL("../../android/app/src/main/assets/contour.html", import.meta.url),
  "utf8",
);
const script = html.match(
  /<script id="indooratlas-math">([\s\S]*?)<\/script>/,
)?.[1];
assert.ok(script);
const context = vm.createContext({ window: {} });
vm.runInContext(script, context);
const guidance = vm.runInContext("window.contourIndoorGuidance", context) as (
  data: unknown,
) => {
  action: string;
  relative: number | null;
  remaining: number;
  nextTurn?: string;
} | null;

const northLeg = {
  begin: { latitude: 35.1558, longitude: 136.9646, floor: 2 },
  end: { latitude: 35.1559, longitude: 136.9646, floor: 2 },
  length: 11,
};
const route = { status: "navigating", floor: 2, heading: 0, legs: [northLeg] };

test("a mapped north corridor changes guidance as the phone faces different directions", () => {
  assert.equal(guidance(route)?.action, "straight");
  assert.equal(guidance({ ...route, heading: 180 })?.action, "around");
  assert.equal(guidance({ ...route, heading: 90 })?.action, "left");
  assert.equal(guidance({ ...route, heading: 270 })?.action, "right");
});

test("unknown position, missing heading, wrong floor and malformed routes produce no arrows", () => {
  assert.equal(guidance({ ...route, status: "lowAccuracy" }), null);
  assert.equal(guidance({ ...route, heading: null }), null);
  assert.equal(guidance({ ...route, floor: 3 }), null);
  assert.equal(guidance({ ...route, legs: [] }), null);
  assert.equal(guidance({ ...route, legs: [null] }), null);
  assert.equal(guidance({ ...route, legs: [{ begin: null }] }), null);
  assert.equal(
    guidance({ ...route, legs: [{ ...northLeg, length: NaN }] }),
    null,
  );
});

test("an upcoming left junction keeps the arrow forward until the current segment is traversed", () => {
  const westLeg = {
    begin: northLeg.end,
    end: { ...northLeg.end, longitude: 136.9645 },
    length: 9,
  };
  const approach = guidance({ ...route, legs: [northLeg, westLeg] });
  assert.equal(approach?.action, "straight");
  assert.equal(approach?.nextTurn, "left");
  const junction = guidance({
    ...route,
    legs: [{ ...northLeg, length: 0.5 }, westLeg],
  });
  assert.equal(junction?.action, "left");
});

test("floor-changing segments work without a compass; arrival requires the destination floor", () => {
  const stairs = {
    ...northLeg,
    begin: { ...northLeg.begin, floor: 3 },
    length: 3.5,
  };
  assert.equal(
    guidance({ ...route, floor: 3, heading: null, legs: [stairs] })?.action,
    "down",
  );
  assert.equal(
    guidance({ ...route, legs: [{ ...northLeg, length: 1 }] })?.action,
    "arrive",
  );
  assert.equal(
    guidance({ ...route, floor: 3, legs: [{ ...northLeg, length: 1 }] }),
    null,
  );
});

test("every executable inline script parses", () => {
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.ok(match[1] !== undefined && match[2] !== undefined);
    if (/type="application\/json"|src=/.test(match[1])) continue;
    new vm.Script(match[2]);
  }
});
