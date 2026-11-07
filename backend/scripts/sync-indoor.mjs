import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { indoorCatalog as catalog } from "../src/services/indoorService.ts";
import { answerIndoorQuestion } from "../src/services/indoorAssistantService.ts";
import { indoorAskSchema } from "../src/schemas/indoor.ts";

// Precompute the first demo from the same graph as the API. It works from a local
// HTML file or bundled APK, without GPS, backend credentials or setup questions.
const demo = answerIndoorQuestion(
  indoorAskSchema.parse({
    message: "room 221 in Engineering Building II",
    context: { buildingId: "nu-eng2", checkpointId: "eng2-office-3" },
  }),
);
if (demo.status !== "ready") throw new Error("Room 221 demo route is missing");
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
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const block = `${start}\n<script type="application/json" id="indoorCatalog">${safeJson(catalog)}</script>\n<script type="application/json" id="indoorDemo">${safeJson(demo)}</script>\n${end}`;
const updated = html.slice(0, first) + block + html.slice(last + end.length);
if (updated !== html) writeFileSync(page, updated);
