import { Router } from "express";
import { findWebAppFile } from "../services/webAppService.js";

export const webAppRouter = Router();
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
