import { z } from "zod";
import { classifyExit } from "../indoorAtlasSync.js";

/**
 * Reviewable floor-plan proposal (docs/floorplan-to-indooratlas.md): the
 * points of interest, display areas and walkable graph of one floor, in
 * normalized image coordinates (`[x, y]`, 0..1, origin top-left, y down), so
 * the same file fits any rendering of the same image. `publish` turns it into
 * IndoorAtlas geofence and wayfinding GeoJSON using the floor plan corners.
 *
 * Nothing in a proposal is verified on site: `origin` and `review` record how
 * each item was produced and who looked at it.
 */

const uuidV1 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "must be a UUID v1 (IndoorAtlas feature ids)",
  )
  .transform((value) => value.toLowerCase());
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
const unit = z.number().min(0).max(1);
/** Normalized image position `[x, y]`. */
export const imagePointSchema = z.tuple([unit, unit]);
export type ImagePoint = z.infer<typeof imagePointSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

/** What a POI is. Only exit, entrance and stairs become app exits (via their names). */
export const poiKinds = [
  "exit",
  "entrance",
  "stairs",
  "elevator",
  "toilet",
  "room",
  "other",
] as const;
export type PoiKind = (typeof poiKinds)[number];

export const proposalPoiSchema = z.object({
  id: uuidV1,
  /** `English / 日本語`, see the app contract in docs/floorplan-to-indooratlas.md. */
  name: text(120),
  description: text(500),
  kind: z.enum(poiKinds),
  at: imagePointSchema,
  /** 0..1: how sure the tracer or the OCR step is about the position and meaning. */
  confidence: z.number().min(0).max(1),
  /** How it was produced: traced by a person, or proposed by OCR. */
  origin: z.enum(["manual-trace", "ocr"]),
  note: z.string().trim().max(500).optional(),
});
export type ProposalPoi = z.infer<typeof proposalPoiSchema>;

export const proposalAreaSchema = z.object({
  id: uuidV1,
  name: text(120),
  description: text(500),
  /** Closed ring (first point repeated last), at least 3 distinct points. */
  ring: z.array(imagePointSchema).min(4).max(200),
});

export const proposalGraphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "lowercase id, letters/digits/-"),
        at: imagePointSchema,
        /** Node placed on this POI: its position is taken from the POI. */
        poiId: uuidV1.optional(),
      }),
    )
    .max(2000),
  edges: z.array(z.tuple([z.string(), z.string()])).max(5000),
});

export const floorPlanProposalSchema = z.object({
  schemaVersion: z.literal(1),
  venue: z.object({ indoorAtlasVenueId: uuid, name: text(200) }),
  floor: z.object({
    floorNumber: z.number().int().min(-5).max(60),
    floorPlanId: uuid,
    /** Width / height of the source image; publish checks the IndoorAtlas plan matches. */
    imageAspect: z.number().positive().max(20),
  }),
  source: z.object({
    kind: z.enum(["event-map", "evacuation-map", "floor-plan", "other"]),
    title: text(300),
    url: z.string().url().optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  review: z.object({
    /** Only `reviewed` proposals can be published. */
    status: z.enum(["proposed", "reviewed"]),
    by: z.string().trim().max(100).optional(),
    at: z.string().trim().max(40).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  pois: z.array(proposalPoiSchema).max(500),
  areas: z.array(proposalAreaSchema).max(100).default([]),
  graph: proposalGraphSchema.default({ nodes: [], edges: [] }),
});
export type FloorPlanProposal = z.infer<typeof floorPlanProposalSchema>;

/** Expected app exit kind for a POI kind (null: must not read as an exit). */
const expectedExitKind: Record<PoiKind, ReturnType<typeof classifyExit>> = {
  exit: "exit",
  entrance: "entrance",
  stairs: "stairs",
  elevator: null,
  toilet: null,
  room: null,
  other: null,
};

/**
 * Semantic checks beyond the schema. Returns problems as sentences; empty
 * when the proposal is consistent:
 * - ids unique across POIs and areas; graph node ids unique;
 * - each POI's name + description classifies as its `kind` in the app sync
 *   (an exit must read as an exit, a toilet must not);
 * - no text claims the data is verified;
 * - edges join two known, different nodes; `poiId` names a POI;
 * - the graph is connected and reaches every exit/entrance POI it has nodes for.
 */
export function checkProposal(proposal: FloorPlanProposal): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const item of [...proposal.pois, ...proposal.areas]) {
    if (ids.has(item.id)) problems.push(`Duplicate feature id ${item.id}.`);
    ids.add(item.id);
  }
  for (const poi of proposal.pois) {
    const kind = classifyExit(`${poi.name}\n${poi.description}`);
    const expected = expectedExitKind[poi.kind];
    if (kind !== expected)
      problems.push(
        `POI "${poi.name}" is a ${poi.kind} but the app would read it as ${kind ?? "not an exit"}; rename it.`,
      );
  }
  for (const item of [...proposal.pois, ...proposal.areas]) {
    if (/(?<!not |un)verified/i.test(`${item.name} ${item.description}`))
      problems.push(
        `"${item.name}" claims to be verified; proposals are never verified.`,
      );
  }
  const { nodes, edges } = proposal.graph;
  const nodeIds = new Set<string>();
  const poiIds = new Set(proposal.pois.map((poi) => poi.id));
  for (const node of nodes) {
    if (nodeIds.has(node.id)) problems.push(`Duplicate graph node ${node.id}.`);
    nodeIds.add(node.id);
    if (node.poiId && !poiIds.has(node.poiId))
      problems.push(`Graph node ${node.id} names unknown POI ${node.poiId}.`);
  }
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) {
      problems.push(`Graph edge ${a} → ${b} does not join two known nodes.`);
      continue;
    }
    adjacency.get(a)?.push(b);
    adjacency.get(b)?.push(a);
  }
  if (nodes.length > 0) {
    const first = nodes[0]!.id;
    const seen = new Set([first]);
    const queue = [first];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()!) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    const unreached = nodes.filter((node) => !seen.has(node.id));
    if (unreached.length)
      problems.push(
        `Graph is not connected: ${unreached.map((node) => node.id).join(", ")} cannot be reached.`,
      );
  }
  return problems;
}

/** Position of a graph node: its POI's position when `poiId` is set. */
export function nodePosition(
  proposal: FloorPlanProposal,
  node: FloorPlanProposal["graph"]["nodes"][number],
): ImagePoint {
  const poi = node.poiId
    ? proposal.pois.find((item) => item.id === node.poiId)
    : undefined;
  return poi ? poi.at : node.at;
}
