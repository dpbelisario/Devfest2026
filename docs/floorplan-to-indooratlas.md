# Floor plans to IndoorAtlas: OCR, walls and mapping

Owner: Minh (@Deadspree). Status: proposed. Tracking issue: see "Floor-plan ingestion" on GitHub.

## Why

The app now takes its indoor venues from the IndoorAtlas account. Every 5 minutes
the `indooratlas-sync` job copies each venue's name, address, location, floors,
points of interest (POIs), geofences and wayfinding status into Firestore
`indoorVenues`, and the app picks the changes up without a code change or new APK
(`docs/indoor-venues.md`, PR #48). The account's first venue is shown as **01**
(today: SAI Dining / 生協南部食堂), then the app's own venues (Central Library 02,
Engineering II 03).

What is still manual is getting a building **into** IndoorAtlas: uploading and
aligning the floor plan, placing exits and rooms as POIs, and drawing the walkable
graph. The iPhone floor-overlay editor already does most of this locally for the
Central Library (label OCR, wall detection, landmark routes;
`docs/native-floor-overlay.md`, `docs/automatic-floor-walls.md`,
`docs/landmark-directions.md`). This feature moves that pipeline to the server and
publishes the reviewed result to IndoorAtlas, so a new building becomes a working
venue in the app by uploading a floor plan.

## Target flow

```
floor plan (PNG/JPEG/PDF page, or a photo of a 避難経路図)
  → 1. extract   OCR labels (rooms, 出口/非常口/入口/階段/EV/トイレ), exit icons,
                 walls + openings
  → 2. align     image corners on the map (reuse the iPhone editor's alignment, or
                 an existing IndoorAtlas floor plan's corners)
  → 3. review    a person accepts/edits every proposed exit, room and wall
                 (nothing is published unreviewed)
  → 4. publish   IndoorAtlas Mapping API: floor plan, POIs + geofences, wayfinding
                 graph, walkable mask
  → 5. sync      existing indooratlas-sync job pulls it into indoorVenues
  → app          venue list, map overlay, Nearest exit
```

## Data available

Everything the Mapping API key can read is already archived by every sync
(read-only, GET only), separate from the app-facing `indoorVenues` documents.
Details: [indoor-venues.md#raw-indooratlas-archive](indoor-venues.md#raw-indooratlas-archive).

| Data                                                                                                                                                                    | Where                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Venue list entry: id, name, description, address, coordinates                                                                                                           | snapshot `venue`                                                            |
| Every floor plan object: id, name, floorNumber, image width/height (px and m), metersToPixels, pixelsToMeters, center, bearing, four corners (no image URL: it expires) | snapshot `floorPlans[]`                                                     |
| Floor plan images                                                                                                                                                       | `gs://<project>-indooratlas/floorplans/{floorPlanId}/{hash}.{png,jpg,webp}` |
| Geofences GeoJSON: polygons and POIs with all properties (`floor`, `name`, `description`)                                                                               | snapshot `geofences`                                                        |
| Wayfinding GeoJSON (graph edges `[lng, lat, floor]`)                                                                                                                    | snapshot `wayfinding`                                                       |
| Radios GeoJSON (BLE beacons, Wi-Fi access points)                                                                                                                       | snapshot `radios`                                                           |
| Enabled paths GeoJSON per floor plan                                                                                                                                    | snapshot `paths[floorPlanId]`                                               |

Snapshots are JSON files `gs://<project>-indooratlas/raw/{venueId}/{contentHash}.json`;
Firestore `indoorAtlasRaw/{venueId}` holds the current hash, `fetchedAt`, counts,
image paths and the last 10 snapshots (`history`), so a change can be diffed and
a bad publish rolled back from the previous snapshot. 404 answers are `null`.

Get it all as files (Cloud Shell, repository root, after `npm ci`):

```sh
INDOORATLAS_ARCHIVE_BUCKET=gen-lang-client-0467526025-indooratlas \
  npm run indoor-venues --workspace backend -- export all ./indooratlas-raw
```

This writes `indooratlas-raw/<venueId>/{meta,snapshot,venue,floorplans}.json`,
`{geofences,wayfinding,radios}.geojson`, `paths/<floorPlanId>.geojson` and
`images/<floorPlanId>.<ext>`. No API key is stored or exported. In code, use
`readRawSnapshot()` from `backend/src/services/indoorAtlasArchive.ts`, or the
private `GET /jobs/indooratlas/raw/{venueId}` on `contour-jobs`.

## IndoorAtlas Mapping API (what you will call)

Base `https://mapping-api.indooratlas.com/public/v1`, header `X-API-Key`. Spec:
<https://docs.indooratlas.com/mapping-api-v1.yaml> (OpenAPI 3, version 0.5.0).

| Step               | Call                                                                                                     | Notes                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Read current state | `GET /venues`, `GET /venues/{venueId}/floorplans`, `GET …/geofences/geojson`, `GET …/wayfinding/geojson` | Always read and back up before writing                                                             |
| New floor plan     | `POST /venues/{venueId}/floorplans/geojson`                                                              | Image + corner coordinates                                                                         |
| Rooms, exits       | `PUT /venues/{venueId}/geofences/geojson`                                                                | **Replaces** all geofences and POIs of the venue. Merge with what exists; never send a partial set |
| Walkable graph     | `PUT /venues/{venueId}/wayfinding/geojson`                                                               | **Replaces** the graph. LineString edges, positions `[lng, lat, floor]`                            |
| Walkable area      | `PUT /floorplans/{floorPlanId}/mask/geojson`                                                             | Optional; helps positioning                                                                        |

Feature ids must be UUID v1. POI properties: `floor`, `name`, `description`.

## Contract with the app (what the sync expects)

- **Exits:** a POI becomes an app exit when its name or description contains
  `exit`, `emergency exit`, `entrance`, `stairs`, `出口`, `非常口`, `避難`, `入口`
  or `階段` (case-insensitive, NFKC). Kind: exit > entrance > stairs. The app labels
  them "marked in IndoorAtlas, not verified on site". Do not write "verified".
- **Names:** `English / 日本語` in one name, split on `" / "`.
- **Floors:** `floorNumber` integers; one floor plan per floor number per venue.
- **Wayfinding:** with at least one valid edge the app routes Nearest exit along the
  graph; without one it shows a direct bearing with a warning.
- **Venue 01** is the account's first venue. The trial plan allows one location.

## Where the code goes

- `backend/src/services/floorplanIngestion/`: extraction, proposal format,
  GeoJSON builders, publish (with dry run). Routes on the private `contour-jobs`
  service under `/jobs/floorplans/*`, or a CLI in `backend/scripts/`, not on the
  public API.
- OCR: Gemini on Vertex AI is already wired (`backend/src/services/geminiClient.ts`,
  used by `/api/indoor/localize-photo`). Ask for structured output (labels with
  pixel boxes and a class); keep a deterministic post-processor. On-device OCR
  (Apple Vision in the iPhone editor) stays as a fallback.
- Walls: port the approach in `docs/automatic-floor-walls.md` (normalized line
  segments, doorway gaps) to TypeScript or keep it native and export.
- Keys: `indooratlas-mapping-api-key` in Secret Manager, already attached to
  `contour-jobs` (and to `api` for the floor plan image proxy) by
  `infra/setup-cloud-jobs.sh`. Publishing needs a key allowed to write; reading
  needs nothing new.
- Backups: before a `PUT`, compare with the latest raw snapshot (see
  [Data available](#data-available)); its `history` already keeps the last 10.

## Safety rules (from AGENTS.md)

- Exits taken from event maps or OCR are proposals, never verified evacuation
  routes. Keep `source` honest end to end.
- Publishing is dry-run by default, prints a diff, and stores a backup of the
  replaced GeoJSON (Firestore or Cloud Storage) so a bad publish can be undone.
- The `PUT` calls replace everything for the venue: read, merge, then write.
- No secrets in logs, responses, commits or the app.

## Test venues

- **SAI Dining / 生協南部食堂 2F** (IndoorAtlas venue `4402be90-dbff-11f1-95cb-e11cd22c6739`):
  floor plan from the 2026 Japanese Ornithological Society programme, page 11
  (`docs/floorplan-ingestion.md`). Event layout, no stated scale: expect 出口 (top
  right), 入口 + 階段・EV (bottom right), トイレ (right).
- **Central Library 2F**: existing reviewed overlay
  `ios/Contour/Resources/default-floor-overlay.json` and saved destinations
  (Entrance Hall, Sky Learning Studio…). Good ground truth for OCR and walls.

## Acceptance

1. From one floor-plan image, the tool proposes rooms, exits and walls as reviewable
   JSON with confidence and source.
2. After review, a dry run shows the exact IndoorAtlas changes; a real publish
   applies them and keeps a backup.
3. Within one sync cycle the app lists the venue, shows the exits, and Nearest exit
   picks one (route if a graph was published, direct bearing otherwise).
4. Tests use fixtures from the Mapping API spec and recorded OCR output; no network.
5. Docs: how to run it, what is verified and what is not.

## Out of scope

- The MapCreator 2 walk-through that IndoorAtlas positioning needs (on-site, by a
  person).
- iPhone IndoorAtlas positioning (`docs/ios-indoor-navigation.md`).
