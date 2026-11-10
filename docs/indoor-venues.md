# IndoorAtlas venues as server data

Supported IndoorAtlas venues are runtime data. Adding, changing or disabling a
venue needs no GitHub push, APK rebuild or backend redeploy: write a Firestore
document and phones pick it up within about 2 minutes (60-second server cache,
60-second CDN cache, the app refreshes on resume at most once a minute).

**The venue list follows the owner's IndoorAtlas account.** A scheduled job
copies every IndoorAtlas venue (name, address, description, location, floor
plans with their map placement, POIs, POIs named like exits, geofence polygons,
whether a wayfinding graph exists) into Firestore every 5 minutes. Synced venues
are listed first; the first one is shown in the app as **"01 · <name>"**, then
the app's own venues continue the numbering (**02 · Central Library**,
**03 · Engineering Building II**). See [IndoorAtlas sync](#indooratlas-sync),
[What changes in the app](#what-changes-in-the-app-when-you-edit-indooratlas)
and the [raw archive](#raw-indooratlas-archive) kept for floor-plan tooling.

**One-time prerequisite:** the backend that serves `GET /api/indoor/venues` must
be deployed once (this code on `main` and the `api` service rebuilt). After that,
venue changes are data only.

## What is implemented

- **Backend:** `GET /api/indoor/venues` (public, no account) returns the enabled
  venues. It reads the Firestore collection `indoorVenues` (one document per
  venue, document ID = venue `id`), validates every document with the zod schema
  in `backend/src/schemas/indoorVenue.ts`, skips invalid documents with a logged
  warning, and caches the result in-process for 60 seconds (CDN `max-age=60`).
  `LIVE_DATA_STORE=memory|off` serves only the seed.
- **Seed:** `backend/data/indoor-venues.json` holds, in this order, the
  **Central Library** (no IndoorAtlas venue: name and floors B1, 1F–4F from
  `backend/data/indoor.json`, location from the campus pin; listed and numbered
  only, the library floor-map and exit-preview flows are unchanged) and the
  Engineering Building II pilot (venue `0d3ece20-da98-11f1-95cb-e11cd22c6739`,
  2F/3F floor plans, room 221 POI `e8679fc0-da9a-11f1-b91e-6591398611dd`), copied
  from [indooratlas.md](indooratlas.md). Neither has **exits**: none have been
  surveyed (the library's exit previews are schematic map routes without
  coordinates).
  A Firestore document with the same `id` overrides the seed venue (including
  disabling it); seed venues without a document stay listed. When Firestore has
  no valid documents or cannot be read, the seed is served, so behaviour is the
  same as before this change.
- **Android:** on every resume (at most once a minute) the app loads its
  on-device copy of the last good list, then fetches
  `${API_BASE_URL}api/indoor/venues` (or the hosted UI's origin when no API URL
  is configured) off the main thread and caches the response; the page is told
  with the `contour-indoor-venues` event. Venues without `indoorAtlas` are listed
  for the page only (no SDK matching, no Nearest exit). The
  IndoorAtlas SDK detects the venue itself; the app matches the SDK venue ID
  against the list. Unlisted venues show the existing "not detected" message.
  For a listed venue the app uses its area (`location`) as the building gate,
  its floor plans to cross-check the SDK floor level, and its `room-221` POI
  (`indoorAtlasPoiId`, else an SDK POI named `221` / `Room 221`) for the room 221
  route. If the endpoint fails it keeps the cached list, then the build-time
  default (`INDOORATLAS_VENUE_ID` / `INDOORATLAS_ROOM221_POI_ID`).
- **Web page:** the Student Ask note shows `01 · <venue name>` for the server's
  primary venue with its IndoorAtlas address on the next line
  (`ContourBridge.indoorVenues()`; `IndoorAtlas · <name>` when an older server
  sends no rank), falling back to "Engineering Building II". The Google map
  shows the synced venue's floor plan, geofences, POIs and exits, see
  [Map overlay](#map-overlay).

- **Nearest exit (Android):** in Student mode, Ask offers **Nearest exit** when
  any listed venue has exits. Native positioning detects the venue, picks the
  nearest exit (same floor first, then the nearest other floor; haversine
  distance from the IndoorAtlas position) and asks the IndoorAtlas SDK for a
  wayfinding route to the exit's coordinates and floor. When the venue has no
  wayfinding graph (`hasWayfinding: false`), or the SDK has no route, the AR view
  shows a straight bearing labelled "Direct direction, not a route". Exits from
  IndoorAtlas are labelled "exit marked in IndoorAtlas · not verified on site".
  The room 221 flow is unchanged and still works when its venue is listed.

Not implemented yet: the floor estimate
(barometer/GPS altitude) and manual floor − / + correction are still calibrated
for Engineering Building II (floors 1–4) only; nearest-exit guidance has not been
tested on site.

**Positioning still needs** the IndoorAtlas SDK key and secret in the APK build
(see [indooratlas.md](indooratlas.md)) and a venue surveyed with MapCreator 2.
Listing a venue does not make an unsurveyed building positionable.

## Venue document

```jsonc
{
  "id": "example-building", // lowercase slug; also the Firestore document ID
  "name": { "en": "…", "ja": "…" },
  "enabled": true,
  "address": "…", // optional, display only
  "description": "…", // optional, display only
  "indoorAtlas": {
    // optional: without it the venue is listed and numbered only
    "venueId": "<IndoorAtlas venue UUID>",
    "floors": [
      {
        "floorPlanId": "<floor plan UUID>",
        "floorLevel": 1,
        "name": "1F",
        "plan": {
          // optional (synced): where the image lies on the map; never the image URL
          "topLeft": { "lat": 35.0, "lng": 136.0 },
          "topRight": { "lat": 35.0, "lng": 136.001 },
          "bottomLeft": { "lat": 34.999, "lng": 136.0 },
          "bottomRight": { "lat": 34.999, "lng": 136.001 },
          "center": { "lat": 34.9995, "lng": 136.0005 }, // optional
          "bearing": 0, // optional, degrees clockwise from north
          "widthPx": 1000, "heightPx": 1000, "widthM": 90, "heightM": 110, // optional
        },
      },
    ],
  },
  "floorLevels": [-1, 1, 2], // optional, for venues without IndoorAtlas floor plans
  "location": { "lat": 35.0, "lng": 136.0, "radiusM": 100 }, // building centre + gate radius
  "exits": [
    {
      "id": "main-door",
      "name": { "en": "…", "ja": "…" },
      "floorLevel": 1,
      "lat": 35.0,
      "lng": 136.0,
      "kind": "exit", // exit | entrance | stairs
      "source": "event-map", // verified | event-map | estimate | indooratlas
      "indoorAtlasPoiId": "<POI UUID>", // optional
    },
  ],
  "pois": [
    {
      "id": "room-221", // the room 221 flow uses this id
      "name": { "en": "…", "ja": "…" },
      "floorLevel": 2,
      "indoorAtlasPoiId": "<POI UUID>", // optional
      "lat": 35.0, // optional, together with lng
      "lng": 136.0,
    },
  ],
  "areas": [
    // optional (synced): IndoorAtlas geofence polygons, display only
    {
      "id": "ia-<geofence UUID>",
      "name": { "en": "…", "ja": "…" }, // optional
      "description": "…", // optional
      "floorLevel": 1,
      "indoorAtlasGeofenceId": "<geofence UUID>",
      "ring": [{ "lat": 35.0, "lng": 136.0 }, …], // 3–64 points, no closing point
    },
  ],
  "updatedAt": "2026-11-09T00:00:00.000Z", // set by the script
  "notes": "internal; not returned by the API",
}
```

`source` matters: only `verified` exits were checked on site. Exits copied from an
event or venue map are `event-map`; POIs the venue owner marked in IndoorAtlas
and that the sync recognised as exits are `indooratlas`; anything else is
`estimate`. Never present `event-map`, `indooratlas` or `estimate` exits as
verified evacuation routes. Floor levels must match the floor numbers set in the
IndoorAtlas CMS.

Synced documents also carry `syncedFrom: "indooratlas"`, `syncOrder` (position in
the IndoorAtlas venue list) and `indoorAtlas.hasWayfinding`. Do not hand-edit
synced documents: the next sync overwrites them (only `enabled` is kept).

The API returns `{ venues: [...], source: "firestore" | "seed", checkedAt }`;
each venue has the fields above without `enabled`, `notes` and `syncOrder`, plus
`origin: "firestore" | "seed"`, `rank` (1-based) and `primary` (true for rank 1).

**Order and numbers:** IndoorAtlas-synced venues first (IndoorAtlas list order,
then name), then manual Firestore venues (by id), then seed venues (seed file
order: Central Library, then Engineering II). Ranks are continuous (01, 02, 03…).
Every enabled venue is listed; a Firestore document with a seed venue's id can
still disable it (`indoor-venues disable nu-library`).

## IndoorAtlas sync

`POST /jobs/indooratlas/sync` on the private `contour-jobs` service mirrors the
IndoorAtlas account that owns the Mapping API key. It only calls `GET` endpoints of
the [Mapping REST API](https://mapping-api.indooratlas.com/public/v1) with the key
in the `X-API-Key` header (10 s timeout per call), and writes only documents with
`syncedFrom: "indooratlas"` (plus the [raw archive](#raw-indooratlas-archive)).
The Cloud Workflow `indooratlas-sync` calls it every 5 minutes (Cloud Scheduler
job `indooratlas-sync-every-15-minutes`: the original name is kept so reruns of
`infra/setup-cloud-jobs.sh` update it in place; created enabled). The answer is a
summary:

```json
{
  "configured": true,
  "venues": 1,
  "floors": 1,
  "pois": 12,
  "exits": 3,
  "areas": 2,
  "archived": 1,
  "updated": 1,
  "disabled": 0,
  "skipped": 0
}
```

Mapping, per IndoorAtlas venue (`GET /venues`, then `/venues/{id}/floorplans`,
`/venues/{id}/geofences/geojson` and `/venues/{id}/wayfinding/geojson`):

| IndoorAtlas                                           | Venue document                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| venue `id`                                            | document ID `ia-<venue UUID>` (lowercase), `indoorAtlas.venueId`                                                                                          |
| venue `name`                                          | `name.en` and `name.ja`; a name containing `" / "` is split into `en / ja`                                                                                |
| venue `address`, `description`                        | `address` (max 300 chars), `description` (max 1000); omitted when empty                                                                                   |
| venue `coordinates`                                   | `location.lat` / `lng`                                                                                                                                    |
| floor-plan corners                                    | `location.radiusM` = farthest corner from the venue coordinates + 20 m, clamped to 50–2000 m; **120 m** when no floor plan has corners                    |
| floor plan `id`, `floorNumber`                        | `indoorAtlas.floors[]`: `floorPlanId`, `floorLevel`, name `2F` / `B1`; floors outside −5…60 and a second plan on the same floor number are skipped        |
| floor plan `image` corners, center, bearing, size     | `floors[].plan` (all four corners required, else omitted); the image `url` expires and is **never stored**                                                |
| GeoJSON `Point` feature                               | `pois[]`: id `ia-<feature UUID>`, `indoorAtlasPoiId`, `lat`/`lng`, `floorLevel` = `properties.floor`                                                      |
| GeoJSON `Polygon` feature (geofence)                  | `areas[]`: id `ia-<feature UUID>`, name/description, floor, outer ring (closing point dropped, evenly sampled to ≤ 64 points); at most 100 per venue      |
| POI whose name or description matches an exit keyword | also `exits[]` with `source: "indooratlas"` and `kind`: exit/emergency exit/出口/非常口/避難 → `exit`, entrance/入口 → `entrance`, stairs/階段 → `stairs` |
| wayfinding graph with at least one edge (404 = none)  | `indoorAtlas.hasWayfinding: true`; the graph itself is not stored (the SDK routes on it)                                                                  |
| venue no longer in `GET /venues`                      | its synced document is set `enabled: false`                                                                                                               |

Keyword matching is case-insensitive (English words on word boundaries); when
several match, exit wins over entrance, entrance over stairs. Exits are only as
good as the POIs the owner marks: name the exit POIs "Exit", "非常口", "Stairs"…
in IndoorAtlas.

Rules: a venue whose sub-requests fail, or that does not fit the schema, is
skipped and its stored copy kept; malformed items (floor plans, features) are
skipped and logged by ID; unchanged venues are not rewritten (idempotent). A
manual document that covers the same IndoorAtlas venue ID wins and the venue is
reported as `skipped`. New synced venues start enabled; `indoor-venues disable
ia-<uuid>` sticks across syncs. The key is never logged or returned. Without the
key the job answers `{"configured": false, …}` and changes nothing.

**Turn it on** (Cloud Shell, repository root, once):

```sh
gcloud config set project gen-lang-client-0467526025
bash infra/setup-cloud-jobs.sh   # creates the empty secret, IAM, workflow, enabled schedule
read -rsp 'IndoorAtlas Mapping API key: ' KEY; echo
printf %s "$KEY" | gcloud secrets versions add indooratlas-mapping-api-key --data-file=-; unset KEY
bash infra/setup-cloud-jobs.sh   # attaches the secret to contour-jobs
gcloud workflows run indooratlas-sync --location asia-northeast1
```

Run it by hand from a checkout instead (same service, writes Firestore with your
Application Default Credentials):

```sh
read -rsp 'IndoorAtlas Mapping API key: ' INDOORATLAS_MAPPING_API_KEY; echo
export INDOORATLAS_MAPPING_API_KEY
npm run indoor-venues --workspace backend -- sync
npm run indoor-venues --workspace backend -- list
```

### What changes in the app when you edit IndoorAtlas

| Edit in IndoorAtlas                  | Where it shows                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Venue name                           | "01 · <name>" (Student Ask note), AR exit header, `venue.name` in native `contour-indoor` events |
| Address                              | Second line under "01 · <name>"; `venue.address` in `contour-indoor` events                      |
| Location (venue coordinates)         | Building gate (`location`), radius from the floor-plan corners                                   |
| Floor plan (image, alignment, floor) | Map overlay image and floor switcher; SDK floor cross-check                                      |
| Geofences (polygons)                 | Faint areas on the map, name/description on tap                                                  |
| POIs / exit POIs                     | Small map markers; exits highlighted ("marked in IndoorAtlas"), Nearest exit                     |
| Wayfinding graph                     | Nearest exit routes along it (`hasWayfinding`)                                                   |
| Venue order / deletion               | "01" is the first venue; deleted venues are disabled                                             |

**How fast:** the sync runs every 5 minutes; the `api` service caches the list
for 60 seconds (chosen over a Firestore "version" document: one collection read
per minute per instance is cheap, needs no extra write path and cannot get out
of step); the CDN caches it for 60 seconds; Android refetches on resume at most
once a minute and the map page refetches when it becomes visible (also at most
once a minute). Worst case about 8 minutes, typically 3–4; after a manual sync
about 2 minutes. Floor plan images are cached up to 10 minutes on the server
and 5 minutes in the browser/CDN.

### Floor plan images

`GET /api/indoor/floorplans/{floorPlanId}/image` (public `api` service) serves
the image of a floor plan that belongs to an **enabled, synced** venue in the
public list; any other ID answers 404 without contacting IndoorAtlas (not an
open proxy). It serves the copy archived by the sync (bucket
`INDOORATLAS_ARCHIVE_BUCKET`) first, else asks the Mapping API for a fresh URL
(`GET /venues/{id}/floorplans` with the key, server-side only) and downloads it:
10 s timeout, 8 MiB cap, PNG/JPEG/WebP only (content type and magic bytes must
agree). Bytes are cached in memory for 10 minutes (failures for 30 s).

| Status | Body                               | When                                                   |
| ------ | ---------------------------------- | ------------------------------------------------------ |
| 200    | image, `public, max-age=300`, ETag | found (304 on a matching `If-None-Match`)              |
| 404    | `{"error":"NOT_FOUND"}`            | not a floor plan of a listed synced venue              |
| 503    | `{"error":"NOT_CONFIGURED"}`       | neither the key nor the archive bucket on `api`        |
| 502    | `{"error":"UPSTREAM_UNAVAILABLE"}` | IndoorAtlas/image host failed or the image was refused |

The key is sent only to the Mapping API, never to the image host, and never
appears in responses or logs.

### Map overlay

`contour.html` (script `indoorAtlasMapOverlay`) draws, on the Google map only
(the offline Leaflet map shows nothing extra):

- the floor plan image of the focused synced venue (the venue IndoorAtlas
  detected on Android, else the first synced venue with a floor plan), placed by
  its top-left, top-right and bottom-left corners with a CSS affine matrix in a
  `google.maps.OverlayView` (this carries rotation/`bearing` and scale; one code
  path for rotated and north-up plans);
- the floor shown is the IndoorAtlas floor (`contour-indoor` with
  `floorSource` `indooratlas` or `corrected`), else the lowest floor; a small
  floor switcher appears on the right when the venue has several floors;
- geofence polygons faintly, name and description on tap (no evacuation meaning);
- POIs as small grey dots and exits as green dots labelled "marked in IndoorAtlas".

## Add or change a venue

1. **Survey** the building with IndoorAtlas: create the venue and floor plans in
   the [CMS](https://app.indooratlas.com/), draw the wayfinding graph, place POIs,
   then walk it with **MapCreator 2** and generate the positioning map (details in
   [indooratlas.md](indooratlas.md#set-up-the-venue)).
2. **Copy the IDs** from the CMS: the venue ID, each floor plan ID with its floor
   number, and any POI IDs you want the app to use.
3. **Write the JSON:** copy [`indoor-venue.template.json`](indoor-venue.template.json)
   (placeholder values, not a real venue; the script rejects its all-zero IDs and
   0,0 coordinates) and fill in real values. Label every exit's `source` honestly.
4. **Upsert** from Cloud Shell, in a checkout of the repository (Application
   Default Credentials; your account needs `roles/datastore.user`):

   ```sh
   gcloud config set project gen-lang-client-0467526025
   git clone https://github.com/dpbelisario/Devfest2026.git && cd Devfest2026
   npm ci
   npm run indoor-venues --workspace backend -- upsert ~/my-venue.json
   npm run indoor-venues --workspace backend -- list
   ```

   `upsert` validates with the same schema as the API, sets `updatedAt` and
   replaces the whole document. A file may hold one venue, an array, or
   `{ "venues": [...] }`. Set `GOOGLE_CLOUD_PROJECT` / `FIRESTORE_DATABASE_ID` to
   target another project or database.

5. **Wait about 2 minutes** (server and CDN cache), then bring the app back to the foreground. No rebuild.

Enable or disable a venue (a seed venue is first copied into Firestore):

```sh
npm run indoor-venues --workspace backend -- disable nu-engineering-2
npm run indoor-venues --workspace backend -- enable nu-engineering-2
npm run indoor-venues --workspace backend -- disable ia-<venue UUID>   # a synced venue
```

Editing documents in the Firestore console also works, but nothing checks them
until the API reads them: an invalid document is skipped (see the Cloud Run log
warning `Skipping invalid indoorVenues/<id>`) and `list` marks it `INVALID`. Prefer
the script.

## Raw IndoorAtlas archive

Each sync also keeps a complete, read-only copy of everything the Mapping API
key can read, separate from the app-facing `indoorVenues` documents, for
floor-plan tooling ([floorplan-to-indooratlas.md](floorplan-to-indooratlas.md)).
It is **never served by the public API**. Enabled when `INDOORATLAS_ARCHIVE_BUCKET`
is set on `contour-jobs` (the setup script sets it to `<project>-indooratlas`).

| What (GET only)                                                                                                                    | Stored                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /venues` entry (id, name, description, address, coordinates)                                                                  | snapshot `venue`, verbatim                                                                                   |
| `GET /venues/{id}/floorplans` (every field, incl. center, bearing, corners, width/height px and m, metersToPixels, pixelsToMeters) | snapshot `floorPlans`, verbatim **without `image.url`** (expires), plus `storedImage: { path, contentType }` |
| `GET /venues/{id}/geofences/geojson` (polygons + POIs, all properties)                                                             | snapshot `geofences`, verbatim                                                                               |
| `GET /venues/{id}/wayfinding/geojson`                                                                                              | snapshot `wayfinding`, verbatim                                                                              |
| `GET /venues/{id}/radios/geojson` (BLE beacons, Wi-Fi)                                                                             | snapshot `radios`, verbatim                                                                                  |
| `GET /floorplans/{floorPlanId}/paths/geojson` (enabled paths), per floor plan                                                      | snapshot `paths[floorPlanId]`, verbatim                                                                      |
| floor plan images (downloaded during the sync, 8 MiB cap, PNG/JPEG/WebP)                                                           | `gs://<bucket>/floorplans/{floorPlanId}/{sha256 prefix}.{png,jpg,webp}`                                      |

A 404 answer is stored as `null`. Where:

- **Snapshots:** `gs://<bucket>/raw/{venueId}/{contentHash}.json`
  (`format: "contour-indooratlas-raw/1"`, `venueId`, `contentHash`, `fetchedAt`
  and the fields above). Cloud Storage rather than Firestore because GeoJSON has
  nested arrays (Firestore cannot store them) and can exceed 1 MiB.
- **Metadata:** Firestore `indoorAtlasRaw/{venueId}`: `name`, `contentHash`
  (SHA-256 of the content, key order independent), `fetchedAt` (when this content
  was first seen), `snapshotPath`, `counts`, `images` and `history` (the last 10
  snapshots, newest first; older snapshot objects are deleted).
- A new snapshot is written only when the content hash changes. Images are
  downloaded again only when their floor plan object (without URL) changes; a
  failed download keeps the previous image.
- Archive failures are logged and never block the venue sync.

**Export** (Cloud Shell, repository root, `npm ci` done; ADC with read access to
the bucket and Firestore):

```sh
INDOORATLAS_ARCHIVE_BUCKET=gen-lang-client-0467526025-indooratlas \
  npm run indoor-venues --workspace backend -- export all ./indooratlas-raw
```

writes `indooratlas-raw/<venueId>/` with `meta.json`, `snapshot.json`,
`venue.json`, `floorplans.json`, `geofences.geojson`, `wayfinding.geojson`,
`radios.geojson`, `paths/<floorPlanId>.geojson` and
`images/<floorPlanId>.<ext>`. Use a venue UUID instead of `all` for one venue.
Older snapshots: `gcloud storage cp gs://<bucket>/raw/<venueId>/<hash>.json .`
(hashes in `history`). On the private jobs service,
`GET /jobs/indooratlas/raw/{venueId}` (IAM-authenticated) returns
`{ meta, snapshot }`. No API key is stored anywhere in the archive.

## Permissions

The public `api` Cloud Run service needs Firestore read access
(`roles/datastore.viewer` or broader), as it already has for `/api/sites`, plus
`roles/secretmanager.secretAccessor` on `indooratlas-mapping-api-key` and
`roles/storage.objectViewer` on the archive bucket (both granted by
`infra/setup-cloud-jobs.sh`, for the floor plan image proxy). Only the admin
running the script needs write access. The sync runs as `contour-jobs-runtime`
(`roles/datastore.user`, `roles/secretmanager.secretAccessor` on
`indooratlas-mapping-api-key` only, `roles/storage.objectAdmin` on the archive
bucket only).

## Not verified

The sync was built from the Mapping API's OpenAPI description (v0.5.0) and tested
against its example responses only; it has not been run against the real
IndoorAtlas account. Unchecked: whether `GET /venues` lists every venue of the
account (no paging is documented), the real POI naming in the owner's venue
(e.g. "SAI Dining"), the actual floor numbers, and SDK routing to exit coordinates
on site. The radios and paths endpoints, the image host's content types and
redirects, and the map overlay's alignment against a real rotated floor plan
were only tested with fixtures and stubs (the overlay math with a flat-projection
stub in headless Chromium).
