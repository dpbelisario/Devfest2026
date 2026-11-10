import express, { type ErrorRequestHandler, type Express } from "express";
import { healthRouter } from "./routes/health.js";
import { destinationsRouter } from "./routes/destinations.js";
import { directionsRouter } from "./routes/directions.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createLiveRouter, type LiveContext } from "./routes/live.js";
import { webAppRouter } from "./routes/webApp.js";
import { createLibraryLocalizationRouter } from "./routes/libraryLocalization.js";
import { RateLimiter } from "./services/rateLimiter.js";
import { indoorRouter } from "./routes/indoor.js";
import { createIndoorVenuesRouter } from "./routes/indoorVenues.js";
import { IndoorVenueService } from "./services/indoorVenueService.js";
import { createFloorPlanImagesRouter } from "./routes/floorPlanImages.js";
import { FloorPlanImageService } from "./services/floorPlanImageService.js";
import type { JobsContext } from "./services/jobs/context.js";

const noStore = "no-store";

/**
 * Build the Express app. `/jobs` is mounted only when job dependencies are
 * supplied (JOBS_ENABLED=true on the private jobs service). `/api` (live
 * sites, alerts and the assistant) is mounted when live data is supplied.
 * `/api/indoor/venues` is always mounted; without `indoorVenues` it serves
 * the bundled seed only. `/api/indoor/floorplans/:id/image` is always
 * mounted; without `floorPlanImages` (no Mapping API key) it answers 404/503.
 */
export function createApp(
  options: {
    jobs?: JobsContext;
    live?: LiveContext;
    indoorVenues?: IndoorVenueService;
    floorPlanImages?: FloorPlanImageService;
  } = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  // Cloud Run (and Firebase Hosting in front of it) set X-Forwarded-For.
  app.set("trust proxy", true);
  app.use(
    "/api/indoor/localize-photo",
    createLibraryLocalizationRouter({
      localizer: options.live?.libraryLocalizer,
      limiter:
        options.live?.assistantLimiter ??
        new RateLimiter({ windowMs: 60000, perKeyLimit: 1, totalLimit: 1 }),
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use("/health", healthRouter);
  app.use("/destinations", destinationsRouter);
  app.use("/directions", directionsRouter);
  app.use("/app", webAppRouter);
  const indoorVenues = options.indoorVenues ?? new IndoorVenueService();
  app.use("/api/indoor/venues", createIndoorVenuesRouter(indoorVenues));
  app.use(
    "/api/indoor/floorplans",
    createFloorPlanImagesRouter(
      options.floorPlanImages ??
        new FloorPlanImageService({ venues: indoorVenues, client: null }),
    ),
  );
  app.use("/api/indoor", indoorRouter);
  if (options.live) app.use("/api", createLiveRouter(options.live));
  if (options.jobs) app.use("/jobs", createJobsRouter(options.jobs));
  // Errors must not be cached: Firebase Hosting's CDN otherwise keeps a 404 for
  // up to 10 minutes, hiding routes added by a later deploy.
  app.use((_req, res) =>
    res.status(404).set("Cache-Control", noStore).json({ error: "NOT_FOUND" }),
  );
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    void _next;
    res.set("Cache-Control", noStore);
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "INVALID_JSON" });
      return;
    }
    console.error("Request failed", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  };
  app.use(handleError);
  return app;
}

/** Public app without job routes. */
export const app = createApp();
