# Native iPhone floor overlay

Open **Contour → Central Library → Details → Floor overlay**, or double-tap
Central Library’s **Details** button. There is no separate native bottom bar.
The editor uses SwiftUI, UIKit gestures, MapKit and the system Photos/Files pickers.
Apple base-map tiles need connectivity; floor images and alignment remain local.
The editor requires iOS 17; the existing iOS 16 shell shows an availability message.

1. Pan to the building. Choose standard or satellite from the map menu.
2. Import from **Photos** or **Files** (up to 20 MB, downsampled to 2048 px).
3. In **Move plan**, drag the background to pan the map or the image to move it.
   Drag any of the four 44-point corner icons to scale proportionally while keeping
   the opposite corner fixed. Pinch also scales; twist two fingers to rotate.
4. **Move map** lets gestures pass through the image, useful if it covers the screen.
5. Rotation/width fields, increment buttons, 0.5 m geographic nudges and opacity
   provide precise adjustments. The keyboard's **Done** dismisses numeric entry.
6. **Hide controls** clears map space without discarding edits. Reopen Controls
   and **Save alignment**. **Cancel** restores the saved version.
7. **Hide/Show** persists visibility. **Find** centers the overlay. Top-bar **Done**
   returns to Contour; save before closing to retain edits.

## Saved and bundled plans

The user-authorized export from the iPhone is bundled as
`ios/Contour/Resources/default-floor-overlay.json`. It contains the 2F Central
Library image and the exact saved position, dimensions, rotation, opacity and
visibility. See [floor-overlay-snapshot.md](floor-overlay-snapshot.md) for provenance.
Fresh iPhone installs use this default. A local saved plan always takes precedence;
updating the app never overwrites local alignment or visibility.

One local plan is saved atomically in Application Support/Contour/geographic-overlay.json.
Image processing and disk I/O run on an actor away from the main thread. Failed
saves keep edits open; failed imports preserve the saved plan. No device location,
camera permission or upload is needed to align an image. Alignment does not improve
indoor positioning, infer routes, or establish that an exit is usable.

The native file/default is authoritative for the separate editor. The surrounding
main map never automatically draws or focuses the floor image on startup, Save,
or return. The existing Google/Leaflet overlay adapter remains available internally;
the shell clears its main-map image. AR reads the saved supported image alignment
independently and estimates the Entrance Hall door coordinate from it.

The trusted bridge opens the editor from the normal Details controls. Single-click
Details opens the sheet; double-tapping the library Details button opens the native
editor directly. An explicit Floor overlay button inside the sheet provides an
accessible alternative. Standalone web/Android clients retain Library floor maps
and do not pretend to have the native iOS editor.

Map, image and corner handles remain sibling native views in the editor, so their
gestures do not intercept each other. Import/save validation, atomic storage,
existing local-save priority and the bundled image are preserved.

## Build and verification

Sources live under `ios/Contour/Features/FloorPlanImport/`. Build the Contour scheme
with the existing Kotlin shared-framework phase and an installed JDK. Distribution
keeps `com.contour.app` and display name Contour. Local signing uses command-line
team/bundle overrides; no credentials or signing profiles belong in the repository.
`CONTOUR_DISPLAY_NAME` can distinguish local builds. `CONTOUR_UI_URL=` uses the
bundled page for immediate local testing; production defaults to the hosted URL.
See [live-location-fix.md](live-location-fix.md).

UIKit scene lifecycle support allows launch with the iOS 27 SDK. Camera/location
activity stops when the scene resigns active. The tests cover the Details bridge,
presentation, geometry/validation, all four rotated corner resizes, map interaction
while editing, and the bundled floor image. Real GPS accuracy, multi-touch and
building alignment still require physical verification.

Optional browser regressions require Playwright, Chrome and the official Leaflet
1.9.4 distribution. Set `NODE_PATH` if using a shared development runtime:

```sh
LEAFLET_TEST_FILE=/path/to/leaflet.js node ios/tests/native-overlay.browser.cjs
LEAFLET_TEST_FILE=/path/to/leaflet.js node ios/tests/live-location.browser.cjs
node --test ios/tests/bridge.test.cjs ios/tests/build-shared.test.cjs
```

Browser checks cover native-style injection into the real page, width/rotation/
opacity changes, hide/show, reload, invalid data, startup GPS and moving line origins.
Google OverlayView lifecycle/geometry is checked with a mocked SDK; real online
Google overlay rendering still needs a phone check after deployment.
The iPhone development app was built, installed and launched during implementation;
it uses local Personal Team signing rather than Firebase iOS OTA distribution.
