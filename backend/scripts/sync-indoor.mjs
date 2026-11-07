import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";

// Keep one catalog source. Embed room/floor data for the bundled phone fallback;
// route calculation still uses the backend and fails visibly when offline.
const catalog = JSON.parse(
  readFileSync(new URL("../data/indoor.json", import.meta.url), "utf8"),
);
const page = new URL(
  "../../android/app/src/main/assets/contour.html",
  import.meta.url,
);
const start = "<!-- indoor-catalog:start -->";
const end = "<!-- indoor-catalog:end -->";
const html = readFileSync(page, "utf8");
const first = html.indexOf(start);
const last = html.indexOf(end);
if (first < 0 || last < first)
  throw new Error("Missing indoor catalog markers");
const block = `${start}\n<script type="application/json" id="indoorCatalog">${JSON.stringify(catalog).replace(/</g, "\\u003c")}</script>\n${end}`;
const updated = html.slice(0, first) + block + html.slice(last + end.length);
if (updated !== html) writeFileSync(page, updated);
