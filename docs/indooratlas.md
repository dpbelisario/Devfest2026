# IndoorAtlas: room 221 pilot

Android uses IndoorAtlas SDK **3.8.1** for positioning and continuous wayfinding.
The existing Student → Ask → 3D AR design is retained. Ask for room 221: the app
starts native positioning and uses the mapped route's next segment plus the
rear-camera-facing compass direction for forward/back/left/right arrows. The SDK
recomputes the route as location changes. Cross-floor segments show up/down arrows.
There are no building, checkpoint or alignment forms in this flow.

**Activation:** IndoorAtlas positioning and wayfinding are active only when
`INDOORATLAS_API_KEY`, `INDOORATLAS_API_SECRET` and `INDOORATLAS_VENUE_ID` are all
configured at build time (`android/local.properties` or build environment) for a
venue that has been surveyed with MapCreator. Without all three the SDK is never
started (`BuildConfig.INDOORATLAS_CONFIGURED` is false): the app still builds and
runs, the room 221 Ask answer reports that corridor mapping is needed, and only
the experimental floor estimate with manual − / + correction is shown. No live
route arrows appear without a configured, surveyed venue.

The venue was created on the separate account as
`0d3ece20-da98-11f1-95cb-e11cd22c6739`. Floor-plan uploads and setup are recorded
below; positioning still requires MapCreator recordings and SDK credentials.
Compilation and simulated routing checks do not establish successful physical positioning.

### Saved CMS setup, November 7, 2026

[The separate-account venue](https://app.indooratlas.com/locations/0d3ece20-da98-11f1-95cb-e11cd22c6739)
is saved as **Nagoya University — Engineering Building II** at
`35.15561139, 136.96476536`. The original Comone venue is unchanged.

| Floor | Floor-plan ID                          | Relative altitude | Image-up bearing | Approximate canvas |
| ----- | -------------------------------------- | ----------------- | ---------------- | ------------------ |
| 2F    | `3f9a5929-0f70-4b45-922f-8f95b53b9be8` | 3.5 m             | 26.49°           | 92.4 × 90.4 m      |
| 3F    | `64cc64e0-e2bb-4f48-ac6e-4dd8508c5353` | 7.0 m             | 26.49°           | 92.3 × 86.4 m      |

Both university-handbook schematic crops are uploaded and aligned approximately
over the Engineering II footprint. Relative heights assume 3.5 m between floors;
the drawings have no measured scale, and their proportions differ from the exterior
footprint. These are preview alignments requiring field checks. No MapCreator
recordings or configured SDK credentials were available for this build.

The [exported preview wayfinding graph](indooratlas-engineering-II-preview-graph.json)
contains seven nodes and six edges: office-side middle-wing 3F corridor → north-wing
stairs → matching 2F landing → middle-wing corridor near room 221. It is a manual
interpretation of the schematic, not surveyed corridor/door geometry. The exported
graph alone does not enable positioning. CMS persistence was verified, and the
wayfinding editor successfully previewed an office-side 3F origin to the 2F endpoint
with a route visible on both floors. This checks graph connectivity, not positioning
accuracy or whether the physical corridor/door path is correct.

The room POI is `e8679fc0-da9a-11f1-b91e-6591398611dd`, named `Room221`, floor 2,
at `35.155600092138236, 136.9647637009621`, about 1 m from the graph endpoint.
Its placement is approximate; the actual door position still needs checking.

## Set up the venue

1. [Create/sign in to IndoorAtlas](https://app.indooratlas.com/). The advertised
   trial is 30 days, without a credit card.
2. Create **Nagoya University — Engineering Building II**, near the full-building
   center `35.15561139, 136.96476536`. Upload separate 2F and 3F plans and align their
   scale, orientation and location on the building footprint. Use floor numbers
   **2** and **3** so they match the university's floor labels.
3. The [2026 university handbook, printed page 30](https://www.engg.nagoya-u.ac.jp/current/doc/binran/binran_2026.pdf#page=36)
   supplies schematic layouts and places room 221 in the middle wing on 2F. Its
   drawing has no metric scale or precise door geometry. Local reference crops
   in `~/Downloads/Contour-IndoorAtlas-setup/` can help prepare the venue, but must
   be aligned and checked on site; they are not measured floor plans.
4. Use the CMS wayfinding editor to draw actual corridor centerlines, connect
   matching stair landings across floors, and mark the room **door** as a POI
   named `Room 221`. Connect the POI to the corridor; don't route through walls.
5. Install **MapCreator on an Android phone**, sign into the same account and
   walk the mapped corridors on 2F and 3F, including the stair transition. Upload
   the recordings, generate the positioning map, inspect map quality, then test
   positioning on site. This physical walk cannot be done from the development
   computer. BLE beacons can improve the first fix, especially on iPhones.
6. Create an **SDK application key and secret**; note the venue ID and optionally
   the room-221 POI ID. Enter the key and secret locally with:

   ```sh
   python3 android/scripts/configure-indooratlas.py
   ```

   The helper uses hidden input, writes ignored `android/local.properties` with
   permissions 0600, and prints no credential values. Equivalent configuration:

   ```properties
   INDOORATLAS_API_KEY=your-mobile-sdk-key
   INDOORATLAS_API_SECRET=your-mobile-sdk-secret
   INDOORATLAS_VENUE_ID=0d3ece20-da98-11f1-95cb-e11cd22c6739
   INDOORATLAS_ROOM221_POI_ID=e8679fc0-da9a-11f1-b91e-6591398611dd
   ```

   Build environment variables with those names are also supported. SDK key and
   secret are client credentials packaged in the APK as required by IndoorAtlas;
   use a dedicated prototype application key. Never put account/admin credentials
   or keys in HTML, commits, issue comments or chat. If the POI ID is omitted, the
   detected venue must contain exactly one POI named `221` or `Room 221`.

7. Rebuild the APK using JDK 17 and SDK 35:

   ```sh
   cd android
   ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
   ```

Firebase App Distribution builds (`android/cloudbuild.yaml`) read the key and
secret from Secret Manager (`indooratlas-api-key`, `indooratlas-api-secret`) and
use the venue/POI IDs above as defaults. Store the secrets once with
`bash android/setup-indooratlas-secrets.sh` in Cloud Shell; see
[apk-distribution.md](apk-distribution.md#4b-indooratlas-credentials-optional).
Without them the CI APK still builds, with IndoorAtlas reported as not configured.
Local Gradle builds need `dl.cloudsmith.io` reachable to download the SDK.

## Estimates and correction

Without a mapped venue/key, Android still attempts floor estimation. In 3D AR,
the only added controls are **− / floor / +**. If the floor is unknown, + starts
at 1F and − starts at 4F; further taps adjust it. Corrections reset the pressure
baseline and temporarily lock IndoorAtlas to that logical floor. A corroborated
pressure/step floor transition updates the lock; closing/backgrounding ends it.

- On Android 14+, GPS altitude is converted from ellipsoid altitude to mean sea
  level using Android's `AltitudeConverter`. It is compared with GSI ground
  elevation **37.4 m** at the building coordinate. The initial calculation assumes
  **3.5 m** floor spacing and a phone **1.2 m** above the slab. These are editable
  `FloorEstimator` parameters, not measured building facts. The first-floor slab
  may differ from the surrounding terrain.
- The estimate is attempted only within 100 m of the building, with horizontal
  accuracy ≤50 m and mean-sea-level vertical accuracy ≤20 m. Out-of-range floor
  results remain unknown. Displayed uncertainty includes a 2 m model allowance;
  it is a heuristic, not calibrated statistical confidence.
- Pressure changes, at least four detected steps and 2.5 seconds of dwell can
  update a known/corrected floor. Steps alone do not identify floor or vertical
  direction. Pressure alone has no absolute reference. Elevator travel is not
  handled by this fallback and weather/air-conditioning can affect it.
- On older Android versions or devices without usable altitude/pressure/step
  sensors, the starting floor stays unknown until corrected or detected by the
  mapped SDK.
- Supported Android phones use **ARCore** for the camera background and measured
  visual-inertial movement behind the existing HTML interface. After a known or
  corrected floor, vertical camera-pose changes can update the floor estimate.
  A transition needs at least 85% of the configured floor height and 2.5 seconds
  of dwell. Tracking loss discards the visual baseline; a new world origin cannot
  count as stairs. This does not recognize corridor or door signs, and the HTML
  direction arrows remain an overlay rather than world-anchored geometry.
- `INDOORATLAS_AR_FUSION=true` optionally forwards tracked ARCore poses to the
  IndoorAtlas AR fusion API. IndoorAtlas documents that AR features require
  account enablement through sales; leave this flag off until enabled. The local
  ARCore height experiment can operate without this add-on or a geospatial API key.
  Unsupported phones retain the ordinary camera background and sensor estimates.

The app shows precise route arrows only when the SDK reports the configured venue,
position accuracy ≤8 m, a known floor with certainty ≥0.7 (or a user correction),
available positioning, and fresh location/route readings within six seconds.
Compass readings must be recent, of at least medium sensor accuracy, with a
geographic declination reference. Hold the phone upright. Floor/position corrections
clear the previous route while the SDK recalculates. Empty routes, stale readings,
wrong venues and missing POIs show status text instead of substitute arrows.
Arrival says to check the door sign; proximity does not verify the room.

The browser and iPhone retain the previous labeled checkpoint demo. Native sensor
fusion/IndoorAtlas integration in this branch is Android-only. Mapping and physical
device checks are still required before claiming automatic room navigation.

## Integration with the separate kmp-ios branch

`kmp-ios` deployment continues separately. This branch changes the Android shell
and shared HTML but does not deploy or merge that branch. An iPhone adapter can
reuse the following contract when the implementations are integrated:

- Send `ContourIndoor.postMessage(JSON.stringify({ type, navigationId, floor? }))`.
  Commands are `start221`, `stop`, `correctFloor`, `cameraStart`, and `cameraStop`.
  Navigation IDs match `[a-zA-Z0-9-]{1,80}`; stop/correction commands target the
  active navigation. The Android listener accepts only the trusted main frame.
  The separately scoped fictional sample engine also uses `demoSensorsStart`
  and `demoSensorsStop` on this transport with `sample-<session>` IDs. It is named
  `ContourIndoorDemo` and must not replace the native `ContourIndoor` object.
- Dispatch `contour-indoor` with event detail containing `navigationId`, `status`,
  `floor`, `floorSource`, `uncertaintyFloors`, `heading`, `cameraTracking`, and
  optional `legs`. Each leg has `length` and `begin`/`end` points containing
  `latitude`, `longitude`, and `floor`. Missing geometry clears precise arrows.
- Dispatch `contour-native-camera` with `{ navigationId, state: "ready" | "fallback" }`.
  Ready means an actual native camera frame is available. The HTML waits while
  permission or installation is pending, then uses the native background or opens
  the ordinary browser camera on fallback. A late event for a closed session is ignored.
- Dispatch `contour-indoor-paused` to clear stale directions on backgrounding.
  Same-navigation native resume preserves the corrected/estimated floor and
  rebases camera movement after tracking interruption.

Shared HTML and native lifecycle code are the likely integration points. The iPhone
adapter must supply real readings before exposing this bridge; otherwise it retains
the existing preview. Native parity and physical iPhone validation are separate work.

## Validation on site

Try room 221 from at least two different corridors/floors. Compare detected floor
against signage, turn the phone through all four directions, walk the stair route,
correct an intentionally wrong floor, cover/reopen the camera, background/resume,
deny permissions, and lose network. Confirm arrows disappear on tracking loss and
that the route avoids walls and selects the correct door. Record the floor map,
phone model, positioning error and stair-transition results.

## Sources

- [IndoorAtlas setup and MapCreator workflow](https://www.indooratlas.com/get-started/)
- [Android SDK setup](https://support.indooratlas.com/support/solutions/articles/36000050564-setup-positioning-sdk-with-android)
- [Continuous wayfinding API](https://support.indooratlas.com/support/solutions/articles/36000095621-using-wayfinding-with-android)
- [Official SDK examples](https://github.com/IndoorAtlas/android-sdk-examples)
- [Android altitude datum conversion](https://developer.android.com/reference/android/location/altitude/AltitudeConverter)
- [IndoorAtlas AR fusion contract and entitlement](https://docs.indooratlas.com/android/latest/com/indooratlas/android/sdk/iaarsession)
- [GSI ground elevation query](https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=136.9646781&lat=35.15583615&outtype=JSON)

Google Indoor Maps is not used by this branch; IndoorAtlas supplies its own
venue mapping, positioning and wayfinding.
