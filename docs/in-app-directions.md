# In-app walking directions

Selecting a site and tapping **Directions** keeps the user in Contour. It requests
precise GPS in Nagoya, calculates a walking route, draws its full geometry on the
Leaflet map, and opens a panel with distance, estimated walking time and expandable
route steps. Close or Android Back returns to site browsing. The existing dotted
selection line is only a connection between points, not a walking route.

## Provider and limits

The page calls the FOSSGIS OSRM **foot** server at
`https://routing.openstreetmap.de/routed-foot/route/v1/foot/` directly. This requires
internet but no Google Maps or ARCore API key, backend route changes, or new server
credentials. Start and destination coordinates are sent to that provider when
Directions is pressed; the panel explains this. Provider, OSM attribution and map correction links live
in **About → Credits**; the map retains its attribution. Street names are shown as returned by OSM; action
labels follow the app's four interface languages.

This is a walking **preview**, not live turn-by-turn navigation or a verified
hazard-aware evacuation route. The router does not check current disaster hazards,
closures, site opening status, accessibility or surveyed entrances. Existing site
hazard designations do not establish route safety. Fictional demo destinations are
rejected, and denied/out-of-area location never falls back to the simulated origin.

GPS accuracy must be within 50 metres. Both endpoints must snap within 75 metres
of the walking network; even this does not verify entrance access. Missing routes,
invalid responses, offline requests and timeouts show an error without drawing a
substitute walking line. A route is cleared if a GPS update moves more than 40
metres from its requested origin. **Recalculate** explicitly requests a new route;
there are no automatic routing requests while walking.

The public server is suitable only for light prototype use. Each page spaces
requests at least 1.1 seconds apart and caches up to ten routes for five minutes.
This is per-page throttling, not a global allowance: multiple users/tabs can exceed
the provider's aggregate limit. Before wider distribution, use a dedicated walking
routing service with shared rate limiting and appropriate availability guarantees.
See the [provider usage policy](https://routing.openstreetmap.de/about.html) and
[OSRM response documentation](https://project-osrm.org/docs/v5.24.0/api/).

## Try the local change

1. Rebuild the APK with the bundled page to avoid loading an older hosted UI:
   from `android/`, run `./gradlew :app:assembleDebug -PcontourUiUrl=` and install
   `app/build/outputs/apk/debug/app-debug.apk`. Use JDK 17 and Android SDK 35.
2. On a physical phone in Nagoya, enable internet and device location. Wait for
   official sites to load. Open a site card and tap **Directions**.
3. Allow precise location. Expect the detail sheet to close, a loading message,
   then a solid green street-following route and its distance/time. Google Maps
   should not open. Expand **Route steps** and pan/zoom the map.
4. Tap **Recalculate**; an unchanged origin/destination can use the cached route.
   Move more than 40 metres from the origin and verify the route clears with a
   prompt to recalculate. This is not automatic turn-by-turn guidance.
5. Close the panel or press Android Back. Open another site and request directions;
   the previous request/route must not overwrite the new selection.
6. Deny location, disable internet, or test with poor GPS accuracy. Expect an
   actionable message and no walking line. Offline/demo sites must explicitly
   refuse walking directions. **Simulated positions are not used as your origin.**
7. Switch English/Japanese/Chinese/Korean and check panel labels. Open the route
   steps, rotate through supported phone layouts, and check scrolling and Close.

For the hosted UI, the backend must be redeployed with the changed HTML, then the
app reopened. No deployment or push is performed by editing the local file.

Physical routes and site entrances still require field verification. Do not use
this prototype as real evacuation guidance.
