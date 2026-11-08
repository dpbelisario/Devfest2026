import { Router } from "express";
import { z } from "zod";
import { indoorRouteQuerySchema, indoorAskSchema } from "../schemas/indoor.js";
import { answerIndoorQuestion } from "../services/indoorAssistantService.js";
import {
  findIndoorRoute,
  indoorCatalog,
  normalizeRoomCode,
} from "../services/indoorService.js";

const roomsQuerySchema = z.object({ q: z.string().trim().max(80).default("") });

/** Indoor room lookup and plan previews, independent of emergency ingestion. */
export const indoorRouter = Router();
indoorRouter.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res
      .set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      .set("Access-Control-Allow-Headers", "Content-Type")
      .status(204)
      .end();
    return;
  }
  next();
});
indoorRouter.get("/catalog", (_req, res) => res.json(indoorCatalog));
indoorRouter.post("/ask", (req, res) => {
  const parsed = indoorAskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_BODY" });
    return;
  }
  res.json(answerIndoorQuestion(parsed.data));
});
indoorRouter.get("/rooms", (req, res) => {
  const query = roomsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "INVALID_QUERY" });
    return;
  }
  const q = normalizeRoomCode(query.data.q);
  const rooms = indoorCatalog.buildings.flatMap((building) =>
    building.nodes
      .filter(
        (node) =>
          node.kind === "room" && normalizeRoomCode(node.label).includes(q),
      )
      .map((node) => ({
        ...node,
        buildingId: building.id,
        buildingName: building.name,
        source: building.source,
      })),
  );
  res.json({ rooms });
});
indoorRouter.get("/route", (req, res) => {
  const query = indoorRouteQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "INVALID_QUERY" });
    return;
  }
  const { buildingId, from, to, avoidStairs } = query.data;
  const building = indoorCatalog.buildings.find(
    (item) => item.id === buildingId,
  );
  if (
    !building ||
    !building.nodes.some((node) => node.id === from) ||
    !building.nodes.some((node) => node.id === to)
  ) {
    res.status(404).json({ error: "UNKNOWN_CHECKPOINT" });
    return;
  }
  const route = findIndoorRoute(building, from, to, avoidStairs);
  if (!route) {
    res.status(422).json({ error: "NO_INDOOR_PATH" });
    return;
  }
  res.json({ ...route, source: building.source });
});

const libraryRerouteSchema = z
  .object({
    from: z.string().min(1).max(80),
    destination: z.enum(["exit", "stairs"]),
    blockedEdges: z
      .array(
        z
          .object({
            from: z.string().min(1).max(80),
            to: z.string().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

indoorRouter.post("/library-reroute", (req, res) => {
  const parsed = libraryRerouteSchema.safeParse(req.body);
  const building = indoorCatalog.buildings.find((b) => b.id === "nu-library");
  if (!parsed.success || !building) {
    res.status(400).json({ error: "INVALID_BODY" });
    return;
  }
  const { from, destination, blockedEdges } = parsed.data;
  const start = building.nodes.find((n) => n.id === from);
  if (
    !start ||
    blockedEdges.some(
      (b) =>
        !building.edges.some(
          (e) =>
            (e.from === b.from && e.to === b.to) ||
            (e.from === b.to && e.to === b.from),
        ),
    )
  ) {
    res.status(400).json({ error: "UNKNOWN_CHECKPOINT_OR_EDGE" });
    return;
  }
  const targets =
    destination === "exit"
      ? ["lib-2-exit"]
      : building.nodes
          .filter((n) => n.kind === "stairs" && n.floor === start.floor)
          .map((n) => n.id);
  const routes = targets
    .map((to) => findIndoorRoute(building, from, to, false, blockedEdges))
    .filter((route) => route !== undefined);
  routes.sort(
    (a, b) =>
      a.edges.reduce((s, e) => s + e.cost, 0) -
      b.edges.reduce((s, e) => s + e.cost, 0),
  );
  if (!routes[0]) {
    res.status(422).json({ error: "NO_INDOOR_PATH" });
    return;
  }
  res.json(routes[0]);
});
