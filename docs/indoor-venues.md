# IndoorAtlas venues as server data

Supported IndoorAtlas venues are runtime data. Adding, changing or disabling a
venue needs no GitHub push, APK rebuild or backend redeploy: write a Firestore
document and phones pick it up within about 5 minutes (next app start after the
server cache expires).

**The venue list follows the owner's IndoorAtlas account.** A scheduled job
copies every IndoorAtlas venue (floor plans, POIs, POIs named like exits,
whether a wayfinding graph exists) into Firestore every 15 minutes. Synced
venues are listed first; the first one is shown in the app as **"01 · <name>"**.
See [IndoorAtlas sync](#indooratlas-sync).

**One-time prerequisite:** the backend that serves `GET /api/indoor/venues` must
be deployed once (this code on `main` and the `api` service rebuilt). After that,
venue changes are data only.

## What is implemented

- **Backend:** `GET /api/indoor/venues` (public, no account) returns the enabled
  venues. It reads the Firestore collection `indoorVenues` (one document per
  venue, document ID = venue `id`), validates every document with the zod schema
  in `backend/src/schemas/indoorVenue.ts`, skips invalid documents with a logged
  warning, and caches the result in-process for 5 minutes (CDN `max-age=60`).
  `LIVE_DATA_STORE=memory|off` serves only the seed.
- **Seed:** `backend/data/indoor-venues.json` holds the current Engineering
  Building II pilot (venue `0d3ece20-da98-11f1-95cb-e11cd22c6739`, 2F/3F floor
  plans, room 221 POI `e8679fc0-da9a-11f1-b91e-6591398611dd`), copied from
  [indooratlas.md](indooratlas.md). It has **no exits**: none have been surveyed.
  A Firestore document with the same `id` overrides the seed venue (including
  disabling it); seed venues without a document stay listed. When Firestore has
  no valid documents or cannot be read, the seed is served, so behaviour is the
  same as before this change.
- **Android:** on start the app loads its on-device copy of the last good list,
  then fetches `${API_BASE_URL}api/indoor/venues` (or the hosted UI's origin when
  no API URL is configured) off the main thread and caches the response. The
  IndoorAtlas SDK detects the venue itself; the app matches the SDK venue ID
  against the list. Unlisted venues show the existing "not detected" message.
  For a listed venue the app uses its area (`location`) as the building gate,
  its floor plans to cross-check the SDK floor level, and its `room-221` POI
  (`indoorAtlasPoiId`, else an SDK POI named `221` / `Room 221`) for the room 221
  route. If the endpoint fails it keeps the cached list, then the build-time
  default (`INDOORATLAS_VENUE_ID` / `INDOORATLAS_ROOM221_POI_ID`).
- **Web page:** the Student Ask note shows `01 · <venue name>` for the server's
  primary venue (`ContourBridge.indoorVenues()`; `IndoorAtlas · <name>` when an
  older server sends no rank), falling back to "Engineering Building II".

- **Nearest exit (Android):** in Student mode, Ask offers **Nearest exit** when
  any listed venue has exits. Native positioning detects the venue, picks the
  nearest exit (same floor first, then the nearest other floor; haversine
  distance from the IndoorAtlas position) and asks the IndoorAtlas SDK for a
  wayfinding route to the exit's coordinates and floor. When the venue has no
  wayfinding graph (`hasWayfinding: false`), or the SDK has no route, the AR view
  shows a straight bearing labelled "Direct direction, not a route". Exits from
  IndoorAtlas are labelled "exit marked in IndoorAtlas · not verified on site".
  The room 221 flow is unchanged and still works when its venue is listed.

Not implemented yet: exits are not drawn on a map; the floor estimate
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
  "indoorAtlas": {
    "venueId": "<IndoorAtlas venue UUID>",
    "floors": [
      { "floorPlanId": "<floor plan UUID>", "floorLevel": 1, "name": "1F" },
    ],
  },
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

**Order:** IndoorAtlas-synced venues first (IndoorAtlas list order, then name),
then manual Firestore venues (by id), then seed venues (by id). While at least one
synced venue is enabled, seed venues without a Firestore document are hidden: the
Engineering II seed belongs to another IndoorAtlas account. To list it anyway,
give it a Firestore document (`indoor-venues enable nu-engineering-2`).

## IndoorAtlas sync

`POST /jobs/indooratlas/sync` on the private `contour-jobs` service mirrors the
IndoorAtlas account that owns the Mapping API key. It only calls `GET` endpoints of
the [Mapping REST API](https://mapping-api.indooratlas.com/public/v1) with the key
in the `X-API-Key` header (10 s timeout per call), and writes only documents with
`syncedFrom: "indooratlas"`. The Cloud Workflow `indooratlas-sync` calls it every
15 minutes (Cloud Scheduler `indooratlas-sync-every-15-minutes`, created enabled
by `infra/setup-cloud-jobs.sh`). The answer is a summary:

```json
{
  "configured": true,
  "venues": 1,
  "floors": 1,
  "pois": 12,
  "exits": 3,
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
| venue `coordinates`                                   | `location.lat` / `lng`                                                                                                                                    |
| floor-plan corners                                    | `location.radiusM` = farthest corner from the venue coordinates + 20 m, clamped to 50–2000 m; **120 m** when no floor plan has corners                    |
| floor plan `id`, `floorNumber`                        | `indoorAtlas.floors[]`: `floorPlanId`, `floorLevel`, name `2F` / `B1`; floors outside −5…60 and a second plan on the same floor number are skipped        |
| GeoJSON `Point` feature                               | `pois[]`: id `ia-<feature UUID>`, `indoorAtlasPoiId`, `lat`/`lng`, `floorLevel` = `properties.floor`; polygons (geofences) are ignored                    |
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

The public `api` service caches the list for 5 minutes, so a sync reaches phones
within about 20 minutes in the worst case (15-minute schedule + cache), or about
5 minutes after a manual run.

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

5. **Wait about 5 minutes** (server cache) and restart the app. No rebuild.

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

## Permissions

The public `api` Cloud Run service needs Firestore read access
(`roles/datastore.viewer` or broader), as it already has for `/api/sites`. Only
the admin running the script needs write access. The sync runs as
`contour-jobs-runtime` (`roles/datastore.user`, plus
`roles/secretmanager.secretAccessor` on `indooratlas-mapping-api-key` only).

## Not verified

The sync was built from the Mapping API's OpenAPI description (v0.5.0) and tested
against its example responses only; it has not been run against the real
IndoorAtlas account. Unchecked: whether `GET /venues` lists every venue of the
account (no paging is documented), the real POI naming in the owner's venue
(e.g. "SAI Dining"), the actual floor numbers, and SDK routing to exit coordinates
on site.
