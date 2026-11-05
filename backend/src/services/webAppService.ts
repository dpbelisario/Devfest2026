import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locations of the Contour UI page (contour.html), in priority order.
 * - Built image: `npm run build` copies it to dist/web/ next to dist/src/.
 * - Local dev (tsx): read straight from the Android shell's bundled asset, so
 *   the hosted page and the APK's offline fallback come from one source file.
 */
const candidates = [
  new URL("../../web/contour.html", import.meta.url),
  new URL(
    "../../../ui-prototype/android/app/src/main/assets/contour.html",
    import.meta.url,
  ),
].map((url) => fileURLToPath(url));

/**
 * Returns the absolute path of the UI page, or undefined when it was not
 * bundled (the /app route then answers 404 instead of failing at startup).
 */
export function findWebAppFile(): string | undefined {
  return candidates.find((path) => existsSync(path));
}
