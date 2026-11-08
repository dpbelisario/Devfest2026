import { z } from "zod";

export const indoorNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  labelJa: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  floor: z
    .number()
    .int()
    .min(-1)
    .max(10)
    .refine((floor) => floor !== 0, "Use -1 for B1; there is no floor 0"),
  kind: z.enum(["room", "corridor", "stairs", "lift", "landmark"]),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});

export const indoorEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["corridor", "stairs", "lift"]),
  // Relative graph cost only: the source plan has no surveyed distances.
  cost: z.number().positive(),
  surveyed: z.boolean(),
});

export const indoorBuildingSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    nameJa: z.string(),
    campus: z.string(),
    aliases: z.array(z.string()).default([]),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        source: z.url(),
      })
      .optional(),
    source: z.object({
      url: z.url(),
      title: z.string(),
      reviewedAt: z.string(),
    }),
    floors: z.array(z.number().int()),
    nodes: z.array(indoorNodeSchema),
    edges: z.array(indoorEdgeSchema),
  })
  .superRefine((building, ctx) => {
    const ids = new Set(building.nodes.map((node) => node.id));
    if (ids.size !== building.nodes.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate indoor node ID" });
    }
    for (const node of building.nodes) {
      if (!building.floors.includes(node.floor)) {
        ctx.addIssue({ code: "custom", message: "Node uses an unknown floor" });
      }
    }
    for (const edge of building.edges) {
      const from = building.nodes.find((node) => node.id === edge.from);
      const to = building.nodes.find((node) => node.id === edge.to);
      if (!from || !to || edge.from === edge.to) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid indoor edge endpoint",
        });
      } else if ((from.floor === to.floor) !== (edge.kind === "corridor")) {
        ctx.addIssue({ code: "custom", message: "Invalid floor transition" });
      }
    }
  });

export const indoorCatalogSchema = z.object({
  version: z.literal(1),
  buildings: z.array(indoorBuildingSchema),
});

export type IndoorBuilding = z.infer<typeof indoorBuildingSchema>;
export type IndoorNode = z.infer<typeof indoorNodeSchema>;
export type IndoorEdge = z.infer<typeof indoorEdgeSchema>;

export const indoorRouteQuerySchema = z.object({
  buildingId: z.string().trim().min(1).max(80),
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  avoidStairs: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const indoorAskSchema = z.object({
  message: z.string().trim().min(1).max(500),
  language: z.enum(["en", "ja", "zh", "ko"]).default("en"),
  location: z
    .object({
      lat: z.number().finite().min(-90).max(90),
      lng: z.number().finite().min(-180).max(180),
      accuracyMeters: z.number().finite().min(0).optional(),
      source: z.enum(["gps", "demo"]),
    })
    .nullable()
    .default(null),
  context: z
    .object({
      buildingId: z.string().max(80).optional(),
      checkpointId: z.string().max(80).optional(),
      destinationId: z.string().max(80).optional(),
    })
    .default({}),
  avoidStairs: z.boolean().default(false),
});

export type IndoorAskRequest = z.infer<typeof indoorAskSchema>;
