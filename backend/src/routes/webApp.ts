import { Router } from "express";
import { config } from "../config.js";
import { findWebAppFile } from "../services/webAppService.js";

/** Serve the shared app and its public, referrer-restricted Maps configuration. */
export function createWebAppRouter(
  browserKey = config.GOOGLE_MAPS_BROWSER_KEY,
) {
  const webAppRouter = Router();
  webAppRouter.get("/maps-config", (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json({ browserKey: browserKey ?? null });
  });
  const webAppFile = findWebAppFile();

  // The Android shell loads this page, so UI changes reach phones on redeploy.
  // no-cache makes the WebView revalidate (ETag) on every launch.
  webAppRouter.get("/", (_req, res) => {
    if (!webAppFile) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.sendFile(webAppFile, {
      headers: { "Cache-Control": "no-cache" },
    });
  });

  return webAppRouter;
}
export const webAppRouter = createWebAppRouter();
