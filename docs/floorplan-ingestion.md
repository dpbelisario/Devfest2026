# Public university floor plans: sourcing and replication

Public floor plans can be collected consistently **for a curated set of buildings
with known university sources**. A university-specific adapter can discover links,
download revisions and extract candidate room/floor labels. It cannot guarantee a
usable plan for an arbitrary building. Publication is fragmented by faculty and
facility, some floors are omitted, and a campus map or room list is often the only
public material. No scraper is implemented by this document.

Use these sources for room catalogs and reviewed floor-plan previews. Measured
door positions, corridor geometry, building alignment and positioning-map recordings
remain separate work. See [the pilot](indoor-pilot.md) and
[IndoorAtlas setup](indooratlas.md) for current behavior and physical mapping steps.

## Nagoya Engineering Building II: what we used

The primary source is the official
[2026 Engineering student handbook](https://www.engg.nagoya-u.ac.jp/current/doc/binran/binran_2026.pdf#page=36),
**PDF page 36, printed page 30**, headed `工学部2号館`. The browser fragment
`#page=36` selects a viewer page; it is not part of the downloaded PDF URL.
The handbook describes its contents as current on March 1, 2026, so a 2026 filename
does not establish that a room is unchanged today.

We rendered the complete page, visually identified each labeled floor drawing,
and cropped them with Pillow. The original reference render was
`/tmp/contour-eng2-current.png`; the local upload/reference crops are in
`~/Downloads/Contour-IndoorAtlas-setup/`. These are schematic reference images,
not university-issued measured floor-plan files.

The page places room 221 on middle-wing 2F and the mechanical/aerospace office on
middle-wing 3F. The existing route graph was interpreted manually from the drawings;
it was not automatically extracted or surveyed. Ordinary `pdftotext` extraction of
this page garbles some Japanese text and omits important drawn room labels. A text
layer being present is therefore insufficient evidence of complete extraction.
`pdfimages -f 36 -l 36 -list` lists no embedded raster images for this page;
rendering preserves the vector drawing and labels together.

The building point comes separately from the official
[campus directory CSV](https://www.nagoya-u.ac.jp/extra/map/a_js/map_data.csv).
Its headerless row ID `71`, grid fields `B3,3` (displayed as B3-3), name
`工学部2号館`, gives **latitude 35.15583615, longitude 136.9646781**.
That point is a directory reference, not a surveyed entrance or complete-building
center. The existing canonical catalog is `backend/data/indoor.json`.

For **SAI Dining**, the university's
[G30 welcome-party notice](https://admissions.g30.nagoya-u.ac.jp/event_schedule/2024-welcome-party/)
identifies **South Cafeteria 2F**, campus marker **B5-3**. A floor schematic is
published on page 11 of the
[2026 Japanese Ornithological Society conference program](https://osj2026.ornithology.jp/docs/osj2026_book.pdf?20261026=#page=11).
The source was visually checked and a one-page PDF plus PNG crop saved under
`~/Downloads/Contour-SAI-Dining-map/`. It shows the entrance, stairs/elevator,
exit and toilet direction. Poster rows and booths are temporary conference
furniture, not ordinary dining seating; no measured scale is supplied. This is a
useful discovery pattern for conference venues, while requiring a review that
separates facility geometry from event-specific arrangements. It has not been
uploaded to IndoorAtlas or incorporated into the room-221 route.

## Reproduce the download, render and crops

Requires `curl`, Python 3, Poppler (`pdftoppm`, `pdfinfo`) and Pillow. On macOS,
install missing dependencies with `brew install poppler` and install Pillow in a
Python virtual environment. Run from any directory; all artifacts go under the
chosen output directory, outside the repository.

```bash
python3 -m venv /tmp/contour-floorplan-tools
/tmp/contour-floorplan-tools/bin/python -m pip install Pillow

floorplan_dir="$HOME/Downloads/Contour-IndoorAtlas-reproduced"
mkdir -p "$floorplan_dir"

curl --fail --location --silent --show-error \
  --dump-header "$floorplan_dir/handbook-response-headers.txt" \
  'https://www.engg.nagoya-u.ac.jp/current/doc/binran/binran_2026.pdf' \
  --output "$floorplan_dir/binran_2026.pdf"

pdfinfo "$floorplan_dir/binran_2026.pdf"
pdftoppm -f 36 -l 36 -scale-to 1600 -singlefile -png \
  "$floorplan_dir/binran_2026.pdf" "$floorplan_dir/engineering-II-page36"

curl --fail --location --silent --show-error \
  'https://www.nagoya-u.ac.jp/extra/map/a_js/map_data.csv' \
  --output "$floorplan_dir/campus-map.csv"

/tmp/contour-floorplan-tools/bin/python - "$floorplan_dir" <<'PY'
import csv
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

out = Path(sys.argv[1])
pdf = out / "binran_2026.pdf"
expected_pdf_hash = "aa823878696b0b6a7bf5fd1e8750e56acf2132803d5a4b8bb1f3d473b69ade04"
pdf_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
if pdf_hash != expected_pdf_hash:
    raise SystemExit("Source revision changed: inspect PDF page 36 and update crops before proceeding.")

image = Image.open(out / "engineering-II-page36.png")
if image.size != (1132, 1600):
    raise SystemExit(f"Unexpected render dimensions: {image.size}; do not reuse pixel crops.")

# Pillow boxes: (left, top, right, bottom), origin at top-left;
# right/bottom are excluded. These apply only to the checked page/render.
boxes = {
    "1F": (116, 1007, 589, 1287),
    "2F": (116, 505, 589, 968),
    "3F": (600, 1007, 1070, 1447),
    "4F": (600, 505, 1070, 968),
}
derivatives = []
for floor, box in boxes.items():
    target = out / f"engineering-II-{floor}-schematic.png"
    crop = image.crop(box)
    crop.save(target)
    derivatives.append({
        "floor": floor,
        "filename": target.name,
        "cropBox": list(box),
        "pixelSize": list(crop.size),
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    })
    print(target.name, crop.size)

with (out / "campus-map.csv").open(encoding="utf-8-sig", newline="") as stream:
    row = next(row for row in csv.reader(stream) if row[0] == "71")
if row[1:4] != ["B3", "3", "工学部2号館"]:
    raise SystemExit("Directory row changed: verify building identity.")

manifest = {
    "retrievedAt": datetime.now(timezone.utc).isoformat(),
    "buildingId": "nu-eng2",
    "sourceUrl": "https://www.engg.nagoya-u.ac.jp/current/doc/binran/binran_2026.pdf",
    "sourceSha256": pdf_hash,
    "sourceBytes": pdf.stat().st_size,
    "sourceEdition": "2026",
    "sourceEffectiveDate": "2026-03-01",
    "pdfPageOneBased": 36,
    "printedPage": "30",
    "render": {
        "tool": "pdftoppm",
        "toolVersion": subprocess.run(
            ["pdftoppm", "-v"], capture_output=True, text=True, check=True
        ).stderr.splitlines()[0],
        "scaleTo": 1600,
        "pixelSize": [1132, 1600],
    },
    "directory": {
        "sourceUrl": "https://www.nagoya-u.ac.jp/extra/map/a_js/map_data.csv",
        "sha256": hashlib.sha256((out / "campus-map.csv").read_bytes()).hexdigest(),
        "rowId": row[0],
        "grid": f"{row[1]}-{row[2]}",
        "latitude": float(row[5]),
        "longitude": float(row[6]),
    },
    "derivatives": derivatives,
    "geometryStatus": "schematic-unsurveyed",
    "metricScale": None,
}
(out / "source-manifest.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print("Directory building coordinate:", manifest["directory"])
PY
```

Verified November 7, 2026 with Poppler 26.04.0: the downloaded PDF has 49 pages,
4,394,808 bytes and an A4 page of 595.276 x 841.89 points. The render is exactly
**1132 x 1600 pixels**, pixel-identical to the existing reference render. The crops
are 473 x 280 (1F), 473 x 463 (2F), 470 x 440 (3F), and 470 x 463 (4F).
Visually check the page heading, floor labels, room 221 and office before upload.
Increasing resolution requires proportionally updated crop coordinates; a different
edition may change page numbering, labels or layout entirely.

## Optional coarse alignment reference

Public [OSM way 158472869](https://www.openstreetmap.org/way/158472869) is named
`工学部2号館` and carries a source tag referring to
`MLIT_PLATEAU bldg_63ae6ab9-c048-4b04-96c1-2f849bc4146e`. This is secondary
geometry with stated provenance, not a newly verified university survey.
The geometry was read on November 7, 2026 from the
[public OSM map API](https://api.openstreetmap.org/api/0.6/map?bbox=136.9640,35.1552,136.9652,35.1563).

| Reference derived from the OSM polygon     | Approximate value                                            |
| ------------------------------------------ | ------------------------------------------------------------ |
| Geographic bounds                          | Lat 35.1551631 to 35.1560605; lon 136.9641696 to 136.9653628 |
| Long wing direction toward schematic right | 116.5 degrees true; reverse 296.5 degrees                    |
| Direction toward schematic top             | 26.5 degrees true                                            |
| Outer extent along wing / across wings     | 87.5 m / 68.0 m                                              |
| Center of that rotated enclosing rectangle | 35.15561139, 136.96476536                                    |

Distances use a local tangent approximation at latitude 35.1556 (111,195 m per
latitude degree; longitude multiplied by cosine of latitude). The long-edge bearing
uses vertices `(35.1557095, 136.9653628)` and `(35.1560605, 136.9645015)`.
The directory point is about 26 m from this enclosing-rectangle center, near the
north wing. Do not center the whole drawing blindly on that directory point.

The reference footprint ratio is about 1.287, while the 2F schematic outline is
about 447 / 396 = 1.129. The roughly 14% discrepancy means **uniform image scaling
cannot match both axes**. The crop also includes white margins. These numbers can
help orient a preliminary overlay, but should not be entered as measured interior
dimensions. Obtain a measured plan or survey multiple exterior/interior landmarks
before assigning metric room-door coordinates. The 4F drawing also omits the
middle-wing outline; do not interpret blank paper as proof that no connection exists.

## Other universities: checked public examples

This was a small discoverability check on November 7, 2026, not an inventory or a
statistical coverage estimate. Each of these three universities publishes at least
one usable reference; that establishes no promise of whole-campus coverage.

| University and primary public source                                                                                                                                                       | What is actually available                                                                                                                                                                                                                               | Adapter implications / limits                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Osaka: [CELAS floor-map index](https://www.celas.osaka-u.ac.jp/facilities/floormap/) and [linked PDF](https://www.celas.osaka-u.ac.jp/wp-content/uploads/uncategorised/celas-floormap.pdf) | Building-specific pages plus a five-page PDF covering teaching/general-education buildings, B1F through 5F; the downloaded PDF title is `floormap_202604`. Ordinary text extraction preserves labels such as `共A201`.                                   | Crawl the index and its linked building pages, then split/review PDF floor regions. A page can contain several buildings and the first page includes both B1F and 1F. Preserve building prefixes; this is not a map of every Osaka building.                                                         |
| Tokyo: [Mechanical Engineering Building 2 map page](https://www.kikaib.t.u-tokyo.ac.jp/map2/)                                                                                              | Explicit floor headings for 1F, 2F, 3F, 7F and 8F, linked GIF images, and an HTML legend mapping room codes to classroom names. The checked [2F GIF](https://www.kikaib.t.u-tokyo.ac.jp/wp-content/uploads/2024/02/map_2f.gif) is only 325 x 383 pixels. | Join each image to the nearest floor heading and parse the HTML legend before OCR. Omitted floors stay unavailable. Small images limit door/geometry precision. An indexed older handbook URL returned 404 during the check: rediscover from live landing pages instead of trusting search snippets. |
| Kyoto: [Academic Affairs building floor-map page](https://www.kyoto-u.ac.jp/ja/education-campus/contact/infomation/bld)                                                                    | Separate 1F/2F JPEG links; the checked [2F image](https://www.kyoto-u.ac.jp/sites/default/files/inline-images/gakumubu-floor-map-2F-024e161496571569812c36b2b08905dd.jpg) is 8206 x 3851 pixels.                                                         | Download the original linked image, not a thumbnail; associate the HTML floor heading with the asset. OCR can propose labels, followed by image review. This single facility is evidence of availability, not a university-wide index.                                                               |

## A practical adapter and review workflow

1. **Register a university and target buildings.** Start with its official campus
   directory, student handbook, teaching-room pages and library/facility pages.
   Keep building IDs, local names, aliases and campus identity explicit. Room `221`
   is not globally unique. Search within official domains using local terms such
   as `フロアマップ`, `講義室配置図`, `館内図` and `学生便覧`; record failed searches
   as availability unknown, not proof that no plan exists.
2. **Discover and fetch through one adapter per source family.** Restrict ordinary
   crawling to registered public university domains, follow actual PDF/image links,
   and distinguish campus layouts from indoor plans. Inspect content type and file
   signature because asset URLs need not have extensions. Use bounded requests,
   cached downloads and server-provided ETag/Last-Modified where available. A login
   page, missing asset or unpublished floor is a recorded blocker; do not bypass it.
3. **Extract candidates according to format.** For vector/text PDFs, use text and
   bounding boxes plus a rendered-page check; lines are not automatically walls or
   traversable paths. For scans, PNG/JPEG/GIF and broken PDF font mappings, render or
   use the original raster and apply Japanese/English OCR as a proposal. For SVG,
   inspect `viewBox`, transforms and text/path structure; text may be outlined and
   units may be arbitrary. Preserve a rendered reference for every format. An
   HTML room legend may be more reliable than OCR. No checked sample established
   that its SVG or raster dimensions represent meters.
4. **Normalize and review.** Record building, floor and wing on every room, its
   original label and source region, and whether it is observed or inferred.
   Separate room existence/floor assignment from door coordinates, corridor edges
   and accessibility. Have a person check repeated labels, missing rooms, multi-floor
   pages and stair connections. Never infer floor from the first digit alone.
5. **Publish a versioned catalog and mapping package.** Only reviewed facts enter
   room lookup. Unsurveyed geometry can enter a clearly labeled preview; measured
   routing requires surveyed doors, scale, north alignment and connections. IndoorAtlas
   additionally requires venue configuration and on-site positioning recordings.
   Downloading a floor plan supplies neither automatic location nor live access status.

Keep a manifest per immutable source revision: landing and asset URLs, retrieval
time, edition/effective date, HTTP validators, content hashes, original bytes,
PDF page/printed page or image region, render tool/version, crop dimensions, extracted
labels and confidence, reviewer/date, and redistribution/attribution status.
Public visibility does not establish a redistribution license; keep a reference
link and confirm terms before republishing a campus-wide asset collection.

On refresh, compare source hashes first. If bytes change, render/diff the relevant
pages and review room, floor and geometry changes before replacing the current
catalog. Compare the relevant plan region as well as whole-file hashes: timetable
edits elsewhere in a handbook can change the PDF without changing the plan.
Preserve the last approved revision and its derived graph/POI IDs; missing rooms
need explicit retirement, not silent ID reuse. Record source availability, extracted
floors and reviewed rooms against a known target-building inventory before reporting
coverage percentages.

For the next university, start with one teaching building and one reviewed room
journey. The concrete blockers to wider coverage are unpublished/missing floors,
stale or broken assets, unreadable labels, incompatible schematic proportions,
unknown door/corridor connections and unverified access conditions. Automating
discovery and refresh is worthwhile; automating claims of precise navigation is not
supported by these public sources.
