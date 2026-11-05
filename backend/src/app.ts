import express, { type ErrorRequestHandler, type Express } from "express";
import { healthRouter } from "./routes/health.js";
import { destinationsRouter } from "./routes/destinations.js";
import { directionsRouter } from "./routes/directions.js";
import { createJobsRouter } from "./routes/jobs.js";
import { webAppRouter } from "./routes/webApp.js";
import type { JobsContext } from "./services/jobs/context.js";

const noStore = "no-store";

/**
 * Build the Express app. `/jobs` is mounted only when job dependencies are
 * supplied (JOBS_ENABLED=true on the private jobs service).
 */
export function createApp(options: { jobs?: JobsContext } = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use("/health", healthRouter);
  app.use("/destinations", destinationsRouter);
  app.use("/directions", directionsRouter);
  app.use("/app", webAppRouter);
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
