import { Router } from "express";
import type { IndoorVenueService } from "../services/indoorVenueService.js";

/**
 * `GET /api/indoor/venues`: public list of enabled IndoorAtlas venues
 * (see schemas/indoorVenue.ts). Short public caching keeps CDN copies close to
 * the server's own 5-minute cache, so venue edits reach phones in minutes.
 */
export function createIndoorVenuesRouter(service: IndoorVenueService): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res
        .set("Access-Control-Allow-Methods", "GET, OPTIONS")
        .set("Cache-Control", "no-store")
        .status(204)
        .end();
      return;
    }
    next();
  });
  router.get("/", async (_req, res) => {
    res
      .set("Cache-Control", "public, max-age=60")
      .json(await service.listEnabledVenues());
  });
  return router;
}
