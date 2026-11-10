import { Router } from "express";
import type { FloorPlanImageService } from "../services/floorPlanImageService.js";

/**
 * `GET /api/indoor/floorplans/:floorPlanId/image`: the IndoorAtlas floor plan
 * image of an enabled, synced venue (see services/floorPlanImageService.ts).
 *
 * - 200: image bytes (`image/png|jpeg|webp`), `Cache-Control: public, max-age=300`, ETag.
 * - 304: `If-None-Match` matches.
 * - 404 `{ error: "NOT_FOUND" }`: not a floor plan of a listed synced venue.
 * - 503 `{ error: "NOT_CONFIGURED" }`: no Mapping API key on this service.
 * - 502 `{ error: "UPSTREAM_UNAVAILABLE" }`: IndoorAtlas or the image failed checks.
 * Errors are `no-store`.
 */
export function createFloorPlanImagesRouter(
  service: FloorPlanImageService,
): Router {
  const router = Router();
  router.get("/:floorPlanId/image", async (req, res) => {
    const result = await service.get(req.params.floorPlanId);
    res.set("Access-Control-Allow-Origin", "*");
    if (result.status !== "ok") {
      const [status, error] =
        result.status === "notFound"
          ? [404, "NOT_FOUND"]
          : result.status === "notConfigured"
            ? [503, "NOT_CONFIGURED"]
            : [502, "UPSTREAM_UNAVAILABLE"];
      res.status(status).set("Cache-Control", "no-store").json({ error });
      return;
    }
    const { image } = result;
    res
      .set("Cache-Control", "public, max-age=300")
      .set("ETag", image.etag)
      .set("X-Content-Type-Options", "nosniff")
      .set("Cross-Origin-Resource-Policy", "cross-origin");
    const match = req.get("if-none-match");
    if (match && match.split(",").some((tag) => tag.trim() === image.etag)) {
      res.status(304).end();
      return;
    }
    res.type(image.contentType).send(image.bytes);
  });
  return router;
}
