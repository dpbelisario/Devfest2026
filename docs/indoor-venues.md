# IndoorAtlas venues as server data

Supported IndoorAtlas venues are runtime data. Adding, changing or disabling a
venue needs no GitHub push, APK rebuild or backend redeploy: write a Firestore
document and phones pick it up within about 5 minutes (next app start after the
server cache expires).

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
- **Web page:** the Student Ask note shows `IndoorAtlas · <venue name>` from the
  list (`ContourBridge.indoorVenues()`), falling back to "Engineering Building II".

Not implemented yet: exits are delivered to the app and page but not drawn or used
for routing; the room-221 Ask flow is still the only IndoorAtlas destination; the
floor estimate (barometer/GPS altitude) is still calibrated for Engineering
Building II only.

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
      "source": "event-map", // verified | event-map | estimate
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
event or venue map are `event-map`; anything else is `estimate`. Never present
`event-map` or `estimate` exits as verified evacuation routes. Floor levels must
match the floor numbers set in the IndoorAtlas CMS.

The API returns `{ venues: [...], source: "firestore" | "seed", checkedAt }`;
each venue has the fields above without `enabled` and `notes`, plus
`origin: "firestore" | "seed"`.

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
```

Editing documents in the Firestore console also works, but nothing checks them
until the API reads them: an invalid document is skipped (see the Cloud Run log
warning `Skipping invalid indoorVenues/<id>`) and `list` marks it `INVALID`. Prefer
the script.

## Permissions

The public `api` Cloud Run service needs Firestore read access
(`roles/datastore.viewer` or broader), as it already has for `/api/sites`. Only
the admin running the script needs write access.
