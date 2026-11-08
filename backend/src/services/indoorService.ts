import { readFileSync } from "node:fs";
import {
  indoorCatalogSchema,
  type IndoorBuilding,
  type IndoorEdge,
  type IndoorNode,
} from "../schemas/indoor.js";

export const indoorCatalog = indoorCatalogSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../data/indoor.json", import.meta.url), "utf8"),
  ),
);

/** Normalize timetable room codes without guessing a class's current room. */
export function normalizeRoomCode(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export interface IndoorRoute {
  buildingId: string;
  mode: "plan-preview";
  requiresFieldSurvey: boolean;
  usesLift: boolean;
  nodes: IndoorNode[];
  edges: IndoorEdge[];
}

/**
 * Shortest path over undirected indoor connections. Costs are relative weights,
 * never meters or ETAs. Returns undefined for unknown or disconnected checkpoints.
 * Excluding stairs does not establish lift operation or accessible door widths.
 */
export function findIndoorRoute(
  building: IndoorBuilding,
  from: string,
  to: string,
  avoidStairs: boolean,
  blockedEdges: { from: string; to: string }[] = [],
): IndoorRoute | undefined {
  const nodes = new Map(building.nodes.map((node) => [node.id, node]));
  if (!nodes.has(from) || !nodes.has(to)) return undefined;
  const pending = new Set(nodes.keys());
  const distances = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, { id: string; edge: IndoorEdge }>();
  while (pending.size > 0) {
    let current: string | undefined;
    let best = Infinity;
    for (const id of pending) {
      const cost = distances.get(id) ?? Infinity;
      if (cost < best) {
        current = id;
        best = cost;
      }
    }
    if (!current) break;
    pending.delete(current);
    if (current === to) break;
    for (const edge of building.edges) {
      if (
        blockedEdges.some(
          (blocked) =>
            (blocked.from === edge.from && blocked.to === edge.to) ||
            (blocked.to === edge.from && blocked.from === edge.to),
        )
      )
        continue;
      if (avoidStairs && edge.kind === "stairs") continue;
      const next =
        edge.from === current
          ? edge.to
          : edge.to === current
            ? edge.from
            : undefined;
      if (!next || !pending.has(next)) continue;
      const candidate = best + edge.cost;
      if (candidate < (distances.get(next) ?? Infinity)) {
        distances.set(next, candidate);
        previous.set(next, { id: current, edge });
      }
    }
  }
  if (!distances.has(to)) return undefined;
  const path: IndoorNode[] = [];
  const edges: IndoorEdge[] = [];
  let id = to;
  while (true) {
    const node = nodes.get(id);
    if (!node) return undefined;
    path.unshift(node);
    if (id === from) break;
    const step = previous.get(id);
    if (!step) return undefined;
    edges.unshift(step.edge);
    id = step.id;
  }
  return {
    buildingId: building.id,
    mode: "plan-preview",
    requiresFieldSurvey: edges.some((edge) => !edge.surveyed),
    usesLift: edges.some((edge) => edge.kind === "lift"),
    nodes: path,
    edges,
  };
}
