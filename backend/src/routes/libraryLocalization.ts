import { Router, json, type ErrorRequestHandler } from "express";
import {
  libraryPhotoSchema,
  type LibraryLocalizationService,
} from "../services/libraryLocalizationService.js";
import type { RateLimiter } from "../services/rateLimiter.js";

/** Mount at /api/indoor/localize-photo before the app's smaller JSON parser. */
export function createLibraryLocalizationRouter(context: {
  localizer?: LibraryLocalizationService;
  limiter: RateLimiter;
}): Router {
  const router = Router();
  router.use((req, res, next) => {
    res
      .set("Access-Control-Allow-Origin", "*")
      .set("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res
        .set("Access-Control-Allow-Methods", "POST, OPTIONS")
        .set("Access-Control-Allow-Headers", "Content-Type")
        .status(204)
        .end();
      return;
    }
    next();
  });
  router.post("/", json({ limit: "750kb" }), async (req, res) => {
    if (!context.localizer) {
      res.status(503).json({ error: "ASSISTANT_DISABLED" });
      return;
    }
    const parsed = libraryPhotoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_IMAGE" });
      return;
    }
    if (!context.limiter.take(req.ip ?? "unknown")) {
      res.status(429).json({ error: "RATE_LIMITED" });
      return;
    }
    try {
      res.json(await context.localizer.identify(parsed.data));
    } catch {
      // Never log image bytes or a provider error that might contain the request.
      res.status(502).json({ error: "PHOTO_ANALYSIS_UNAVAILABLE" });
    }
  });
  const handleImageError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    void _next;
    const tooLarge =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large";
    res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE" });
  };
  router.use(handleImageError);
  return router;
}
