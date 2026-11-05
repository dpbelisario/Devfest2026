import { URL } from "node:url";
import { cpSync } from "node:fs";
cpSync(
  new URL("../data/", import.meta.url),
  new URL("../dist/data/", import.meta.url),
  { recursive: true },
);
cpSync(
  new URL(
    "../../android/app/src/main/assets/contour.html",
    import.meta.url,
  ),
  new URL("../dist/web/contour.html", import.meta.url),
);
