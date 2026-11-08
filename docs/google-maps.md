# Google Maps setup and deployment

Contour's online campus/global basemap uses the supported Google Maps JavaScript
API in the shared iOS/Android WebView page. Google owns its map canvas, tiles,
logo and attribution; Contour retains custom destination markers, selection,
GPS ring, popups and route overlays. The map viewport leaves room above app
cards/sheets so Google branding remains visible. No undocumented Google tile URL,
proxy or Google tile cache is used.

The existing project `gen-lang-client-0467526025` already has billing enabled.
Maps JavaScript API (`maps-backend.googleapis.com`) is enabled and a separate
`Contour Maps browser` key is configured. Its API restriction is Maps JavaScript
API only. Its HTTP-referrer restrictions are:

- `https://gen-lang-client-0467526025.web.app/*`
- `https://gen-lang-client-0467526025.firebaseapp.com/*`

Firebase-generated Android/iOS/browser keys were not changed. The Google Maps
browser key is public client configuration, not a server credential. Store it as
`GOOGLE_MAPS_BROWSER_KEY` on the public Cloud Run `api` service. `/app/maps-config`
returns only this value (or null), with `Cache-Control: no-store`. It is not
committed into the app or GitHub. A different website or preview host needs its
own allowed referrer, preferably a separate restricted development key.

## Repeat the setup

Use an up-to-date Google Cloud Shell `gcloud`:

```sh
PROJECT_ID=gen-lang-client-0467526025
gcloud services enable maps-backend.googleapis.com --project "$PROJECT_ID"
gcloud services api-keys create --project "$PROJECT_ID" \
  --display-name='Contour Maps browser' \
  --api-target=service=maps-backend.googleapis.com \
  --allowed-referrers='https://gen-lang-client-0467526025.web.app/*,https://gen-lang-client-0467526025.firebaseapp.com/*'
```

Use that key's string in the service environment. Avoid pasting it into chat or
GitHub. This update preserves existing environment variables:

```sh
read -r -s GOOGLE_MAPS_BROWSER_KEY
gcloud run services update api --project "$PROJECT_ID" --region asia-northeast1 \
  --update-env-vars="GOOGLE_MAPS_BROWSER_KEY=$GOOGLE_MAPS_BROWSER_KEY"
unset GOOGLE_MAPS_BROWSER_KEY
```

This Mac's older `gcloud` may fail with an unknown `sandboxes` field when updating
Cloud Run. The initial setup used the supported Cloud Run REST v2 environment
update instead: read the service, preserve the complete existing container list
(including image, resources, ports and secret references), add the browser-key
environment entry, then PATCH with `updateMask=template.containers`. Do not replace
all service environment variables or alter the existing Firebase keys.

The existing public main deploy trigger updates the image, region and port
without resetting environment variables, so the key survives redeployment.
Any future environment changes must use `--update-env-vars` rather than replacing
the whole environment. Run the normal backend/native checks and
`npm run build`, commit the shared page and push owner `main`. Verify live
`/app/maps-config`, real Google rendering on the Firebase domain, the installed
iPhone page and the final Firebase Android APK before announcing the release.

## Offline behavior and scope

Google Maps requires a network connection. A bundled `file://` iOS page or
Android app-assets origin cannot use the same HTTP-referrer-restricted browser
key safely. These pages use the bundled Leaflet coordinate/marker canvas without
an outdoor basemap, showing that the map is unavailable. No OSM tiles are loaded
or retained. Library floor images, offline inferred routes and native continuous
AR remain available. Google Maps SDKs are not added to the native shells.

Walking directions still use the existing FOSSGIS/OSRM service and its
OpenStreetMap routing data; their attribution remains. Switching the basemap does
not replace the indoor library graph, determine indoor position or provide a
registered exit bearing. LiDAR/camera AR selection is separate.

## Costs and validation

[Google's official pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
currently lists Dynamic Maps with 10,000 free monthly loads, then US$7 per1,000
loads in the first paid tier. A Maps JavaScript map inside a native WebView is a
Dynamic Maps load. Billing must still be enabled; use Google Cloud budgets/quotas
to control costs. No Places, Routes or other paid Maps APIs were enabled. The hackathon
promotional credit uses the same billing account, but its applicability to Maps
was not verified; do not assume it covers Maps charges.

Real SDK rendering was tested from the allowed Firebase origin with the updated
page injected locally: actual Google script/tile requests succeeded, custom
markers and the direct library AR action worked, and no Maps authorization error
occurred. Backend tests check public-config output and no-store caching. Offline
and SDK-unavailable checks must preserve library card/AR access. Physical iOS and
Android map interaction still needs device validation after the combined release.

## Slow mobile loading

The config request waits up to 8 seconds and the Google SDK up to 15 seconds.
Native hosted-page fallback waits 20 seconds and is cancelled as soon as the
trusted document commits, so slow third-party assets do not switch to a restricted
bundled origin. iOS records only provider, hosted/bundled source, connectivity and
SDK readiness in Documents/map-load-state.json; it records no key or location.
A late SDK can trigger one hosted-page retry outside AR. XS Max diagnostics
confirmed hosted/google/online/SDK-ready after this fix; tile rendering also passed
a real Google browser test with the iPhone app user agent and a 6.2-second SDK delay.
