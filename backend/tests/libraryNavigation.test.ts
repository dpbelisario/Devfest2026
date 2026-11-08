import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { indoorBuildingSchema } from "../src/schemas/indoor.js";
import {
  findIndoorRoute,
  indoorCatalog,
} from "../src/services/indoorService.js";

const library = indoorCatalog.buildings.find((b) => b.id === "nu-library")!;
const html = readFileSync(
  new URL("../../android/app/src/main/assets/contour.html", import.meta.url),
  "utf8",
);

test("every library checkpoint reaches the 2F exit using stairs only for floor changes", () => {
  assert.deepEqual(library.floors, [-1, 1, 2, 3, 4]);
  for (const node of library.nodes) {
    const route = findIndoorRoute(library, node.id, "lib-2-exit", false)!;
    assert.ok(route, node.id);
    assert.equal(route.nodes.at(-1)?.floor, 2);
    assert.equal(route.usesLift, false);
    assert.equal(route.requiresFieldSurvey, node.id !== "lib-2-exit");
    assert.equal(
      route.edges.some((e) => e.kind === "stairs"),
      node.floor !== 2,
    );
    if (node.floor !== 2)
      assert.equal(
        findIndoorRoute(library, node.id, "lib-2-exit", true),
        undefined,
      );
    for (const stair of library.nodes.filter(
      (n) => n.floor === node.floor && n.kind === "stairs",
    )) {
      const same = findIndoorRoute(library, node.id, stair.id, false)!;
      assert.ok(same.nodes.every((n) => n.floor === node.floor));
    }
  }
  assert.equal(
    indoorBuildingSchema.safeParse({
      ...library,
      nodes: [{ ...library.nodes[0], floor: 0 }],
    }).success,
    false,
  );
});

test("offline exit and nearest-stairs routes match the shared routing service", () => {
  const match = html.match(
    /<script type="application\/json" id="libraryRoutes">(.*?)<\/script>/s,
  )!;
  const routes = JSON.parse(match[1]!) as Record<
    string,
    {
      exit: ReturnType<typeof findIndoorRoute>;
      stairs: NonNullable<ReturnType<typeof findIndoorRoute>>;
    }
  >;
  for (const node of library.nodes) {
    assert.deepEqual(
      routes[node.id]?.exit,
      findIndoorRoute(library, node.id, "lib-2-exit", false),
    );
    const stairs = routes[node.id]!.stairs;
    assert.equal(stairs.nodes.at(-1)?.kind, "stairs");
    assert.ok(stairs.nodes.every((n) => n.floor === node.floor));
    const cost = stairs.edges.reduce((total, e) => total + e.cost, 0);
    for (const stair of library.nodes.filter(
      (n) => n.floor === node.floor && n.kind === "stairs",
    )) {
      assert.ok(
        cost <=
          findIndoorRoute(library, node.id, stair.id, false)!.edges.reduce(
            (total, e) => total + e.cost,
            0,
          ),
      );
    }
  }
});

test("phone arrow requires calibration, fresh heading, fresh checkpoint and the same floor", () => {
  const source = html.match(
    /<script id="libraryNavigationCore">(.*?)<\/script>/s,
  )![1]!;
  const context = {
    window: {} as {
      ContourLibrary: {
        arrow: (
          a: object,
          b: object,
          h: number | null,
          o: number | null,
          ht: number,
          ct: number,
          now: number,
        ) => number | null;
      };
    },
  };
  runInNewContext(source, context);
  const arrow = context.window.ContourLibrary.arrow.bind(
    context.window.ContourLibrary,
  );
  const a = { x: 0, y: 0, floor: 2 },
    b = { x: 1, y: 0, floor: 2 };
  assert.equal(arrow(a, b, 90, 0, 10000, 10000, 10000), 0);
  assert.equal(arrow(a, b, 180, 0, 10000, 10000, 10000), -90);
  assert.equal(arrow(a, b, null, 0, 10000, 10000, 10000), null);
  assert.equal(arrow(a, b, 90, null, 10000, 10000, 10000), null);
  assert.equal(arrow(a, b, 90, 0, 10000, 10000, 12001), null);
  assert.equal(arrow(a, b, 90, 0, 71000, 10000, 71000), null);
  assert.equal(arrow(a, { ...b, floor: 3 }, 90, 0, 10000, 10000, 10000), null);
});
