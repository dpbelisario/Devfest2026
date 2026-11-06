import { Router, type Request } from "express";
import { z } from "zod";
import {
  assistantLanguages,
  type AssistantService,
} from "../services/assistantService.js";
import {
  siteDisasters,
  type LiveDataService,
} from "../services/liveDataService.js";
import type { RateLimiter } from "../services/rateLimiter.js";

/** Public read endpoints over the ingestion job outputs, plus the assistant. */
export interface LiveContext {
  live: LiveDataService;
  /** Absent when the assistant is disabled; POST /assistant then answers 503. */
  assistant?: AssistantService;
  assistantLimiter: RateLimiter;
}

const coordinate = (min: number, max: number) =>
  z.coerce.number().finite().min(min).max(max);

const sitesQuerySchema = z.object({
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  radiusMeters: z.coerce.number().int().min(100).max(20_000).default(5_000),
  disaster: z.enum(siteDisasters).optional(),
});

const assistantBodySchema = z.object({
  message: z.string().trim().min(1).max(500),
  language: z.enum(assistantLanguages).default("en"),
  location: z
    .object({
      lat: coordinate(-90, 90),
      lng: coordinate(-180, 180),
      source: z.enum(["gps", "demo"]),
    })
    .nullable()
    .default(null),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "model"]),
        text: z.string().max(1500),
      }),
    )
    .max(8)
    .default([]),
});

function clientKey(req: Request): string {
  return req.ip ?? "unknown";
}

export function createLiveRouter(context: LiveContext): Router {
  const router = Router();

  // Public, credential-free endpoints. The app's bundled offline copy of the UI
  // runs on https://appassets.androidplatform.net, so allow any origin.
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res
        .set("Access-Control-Allow-Methods", "GET, POST")
        .set("Access-Control-Allow-Headers", "Content-Type")
        .set("Access-Control-Max-Age", "3600")
        .status(204)
        .end();
      return;
    }
    next();
  });

  router.get("/sites", async (req, res, next) => {
    const parsed = sitesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).set("Cache-Control", "no-store").json({
        error: "INVALID_QUERY",
        message:
          "Provide lat and lng, and optionally limit (1–50), radiusMeters (100–20000) and disaster.",
      });
      return;
    }
    try {
      const found = await context.live.findSites(parsed.data);
      if (!found) {
        res
          .status(503)
          .set("Cache-Control", "no-store")
          .json({ error: "DATA_NOT_READY" });
        return;
      }
      res.set("Cache-Control", "public, max-age=300").json({
        dataset: found.info,
        notice:
          "Official designations only. Opening status and capacity are unknown; distances are straight-line.",
        sites: found.sites,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/alerts", async (_req, res, next) => {
    try {
      res
        .set("Cache-Control", "public, max-age=30")
        .json(await context.live.getAlerts());
    } catch (error) {
      next(error);
    }
  });

  router.post("/assistant", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!context.assistant) {
      res.status(503).json({ error: "ASSISTANT_DISABLED" });
      return;
    }
    const parsed = assistantBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_BODY" });
      return;
    }
    if (!context.assistantLimiter.take(clientKey(req))) {
      res.status(429).json({ error: "RATE_LIMITED" });
      return;
    }
    try {
      res.json(await context.assistant.reply(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
