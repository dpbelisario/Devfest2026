# Native iPhone floor overlay

Open **Contour → Central Library → Details → Floor overlay**.
Double-tapping Central Library’s Details button also opens it. There is no duplicate
button below the screen; the map uses the full safe-area height.
The editor uses SwiftUI, UIKit gestures, MapKit and the system Photos/Files pickers.
Apple base-map tiles need connectivity; floor images and alignment remain local.
The editor requires iOS 17; the existing iOS 16 shell shows an availability message.

1. Pan to the building. Choose standard or satellite from the map menu.
2. Import from **Photos** or **Files** (up to 20 MB, downsampled to 2048 px).
   Choose the matching **Floor** in the alignment controls. Older saves default to 2F.
3. In **Move plan**, drag the background to pan the map or the image to move it.
   Drag any of the four 44-point corner icons to scale proportionally while keeping
   the opposite corner fixed. Pinch also scales; twist two fingers to rotate.
4. **Move map** lets gestures pass through the image, useful if it covers the screen.
5. Rotation/width fields, increment buttons, 0.5 m geographic nudges and opacity
   provide precise adjustments. The keyboard's **Done** dismisses numeric entry.
6. Drag the grab handle above **Alignment parameters** down to collapse the panel
   into a small **Show parameters** bar, exposing more of the map. Drag up or tap
   the bar to expand it. The fields scroll independently below the handle. Collapsing
   dismisses the keyboard and preserves all edits. **Hide controls** removes the
   panel completely; **Controls** reopens it expanded. Use **Save alignment** to
   retain changes; **Cancel** restores the saved version.
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

The native saved file/default is transferred on page load, save/visibility changes
and return from the editor. The aligned image appears on the general Google/Leaflet
map, without destination pins. Saving or returning focuses it; startup preserves
live GPS centering. Hide/Show controls this geographic image. AR reads its alignment
independently.

**Details → Floor Maps** uses that same saved PNG and reviewed destinations for its
selected floor, in one geographic map with all numbered location pins. The separate
upright PNG viewer is hidden on this floor; other floors retain their reference viewer. Opening the viewer selects the saved floor. Other floors retain
their bundled reference images. Saving a replacement image or revised pins refreshes
the viewer, including when it is already open. Hiding the geographic overlay does
not hide the saved plan inside Floor Maps. The viewer also offers **Edit floor
overlay / Detect labels**. Only one imported plan is currently stored per device.
The iPhone Floor Maps flow hides the old relative-obstacle demo, 3D preview,
route-preview explanation, photo assistance/landmark identification and legacy
checkpoint-route controls on every floor. The floor selector remains above the
current floor map. Legacy DOM nodes stay hidden and inert for compatibility with
existing hosted-page handlers; Android/shared HTML is unaffected. The native editor,
starting-point confirmation and saved-destination controls remain available.

The trusted bridge opens the editor from the normal Details controls. Single-click
Details opens the sheet; double-tapping the library Details button opens the native
editor directly. An explicit Floor overlay button inside the sheet provides an
accessible alternative. Standalone web/Android clients retain Floor Maps
and do not pretend to have the native iOS editor.

Map, image and corner handles remain sibling native views in the editor, so their
gestures do not intercept each other. Import/save validation, atomic storage,
existing local-save priority and the bundled image are preserved.

## Suggested starting point

Opening **Details → Floor Maps** on the saved plan's floor starts a dedicated
location watch. The preview shows the phone-reported coordinate in blue, an
accuracy circle, and an orange dashed straight line to the nearest suggested saved
label. The saved floor PNG appears in the preview with its saved position, scale, rotation
and opacity, including when the geographic overlay is hidden on the general map.
The preview initially fits the complete floor image and reported position. Google
Maps supplies the basemap when the online SDK is available; the offline fallback
retains the floor image and position line without basemap tiles. The general
building map still has no room pins. The suggested label also has an orange outline
on the floor image. This feature is injected by the native adapter, so the installed
iPhone can use it with the existing hosted page without a web deployment.

All saved locations appear as numbered, tappable pins on the single map and in the
**Starting point** dropdown. This includes locations outside the automatic suggestion
radius. Tapping a pin or choosing its name selects a starting-point candidate and
updates the orange highlight and dashed line. There is no separate three-item
suggestion list. The map remains usable without location permission or a fresh fix;
only the blue phone marker, accuracy circle and line require fresh coordinates.
**Saved destinations** remains a separate, explicitly named dropdown for the route
goal; that selection receives a green ring without changing the starting point.
Pins use translucent blue/orange fills so printed names remain readable. Choosing
alone does not confirm a pose. the full-width blue **Set my position here** button moves the Floor Maps
position dot to the selected pin, without changing the phone's compass heading.
After confirmation, the floor-map dot and destination AR share one native step/gyro
tracker. GPS fixes no longer move that dot. The initial compass reading seeds heading;
later turns come from gyroscope rotation around gravity. iOS pedometer counts advance
the point using the **Step length for next confirmation (m)** setting (default 0.72 m).
Allow Motion & Fitness when requested and hold the phone in front while walking.
Changing the setting takes effect on the next confirmation, which resets the tracker.
**Use uncorrected phone position** ends indoor tracking and returns to raw location.
Closing Floor Maps or backgrounding pauses the tracker and requires reconfirmation.
Opening/closing the native AR camera preserves the shared tracker while foregrounded.
Reloading, editing the image/alignment or moving/removing the anchor clears the session.
See [indoor-step-navigation.md](indoor-step-navigation.md) for behavior and limits.

Before confirmation, the facing arrow uses a separate native compass subscription
(true heading when available, magnetic otherwise). Confirmation seeds the gyro
tracker with that heading. Later compass changes do not override the indoor heading.
No camera is needed for the map dot; the AR camera is used for obstacle observations.

Automatic nearest-start suggestions use finite valid fixes no older than 30 seconds
(and at most 5 seconds in the future), with nonnegative accuracy no worse than 100 m.
Automatic candidates must be within twice the reported accuracy, clamped to 50–150 m.
Standalone floor labels such as `2F` are excluded from automatic recommendations,
but saved pins are not deleted. These are demo heuristics, not calibrated probabilities.
Users can choose any saved pin manually regardless of GPS quality or distance.
They must check the floor and landmark; printed labels may not be walkable checkpoints.
Before confirmation, stale or denied fixes clear the blue dot and line while
retaining the floor and pins; after confirmation the last corrected point remains.
Closing Floor Maps, switching away from the saved floor, backgrounding or clearing
the plan stops this feature's watch and removes its layers. The general map's
independent watch is preserved. Google keyboard-navigation controls are disabled
in the embedded map; zoom controls and map gestures remain available.

The dashed line is a bearing preview, not a wall-aware walking route. Confirmation,
walkable checkpoint geometry and ongoing indoor tracking remain future work.

## Open AR navigation

A full-width **Open AR navigation** button sits directly beneath **Saved destinations**.
It requires a confirmed start and a different selected destination. Stand at the
confirmed pin before opening the full-screen native camera. The structured native
bridge validates the floor, finite coordinates, names and a goal distance between
0.5 and 1000 m. AR uses the same live step/gyro pose as the map; the camera only adds obstacle
observations. Its bridge checks that the foreground tracking session matches the
confirmed start and is active. GPS and AR camera translation do not move this pose. Camera permission denial is
reported. Close preserves the map selections. See [camera-obstacle-arrow-ios.md](camera-obstacle-arrow-ios.md)
for tracking/obstacle limitations and interruption behavior. This is not wall-aware
route planning or verified evacuation guidance.

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
node ios/tests/floor-map-sync.browser.cjs
node --test ios/tests/bridge.test.cjs ios/tests/build-shared.test.cjs
```

Browser checks cover native-style injection into the real page, width/rotation/
opacity changes, hide/show, reload, invalid data, startup GPS and moving line origins.
Google OverlayView lifecycle/geometry is checked with a mocked SDK; real online
Google overlay rendering still needs a phone check after deployment.
The iPhone development app was built, installed and launched during implementation;
it uses local Personal Team signing rather than Firebase iOS OTA distribution.

## Detect labels and save destination pins

Tap **Detect labels** in the native floor editor to run Apple's Vision OCR on the
original normalized PNG. No photo is uploaded and no separate model or OCR service
is bundled. Detection runs off the UI thread. English/Japanese recognition is
requested where supported, with automatic language detection and spelling
correction disabled to preserve short room codes. Very small/rotated text or
single letters may be missed. OCR confidence is a recognition score, not location
accuracy. Detection returns at most 120 suggestions; it does not interpret a legend.

Review the numbered suggestions against the original image. Rename labels,
uncheck unwanted text/legend entries, select a number and tap the image to move
it, or use **Add pin** for a missed label. **Cancel** changes nothing. **Save pins**
persists the reviewed set immediately when alignment is not being edited; during
an alignment edit it updates the draft and **Save alignment** is still required.
Saving an empty reviewed set clears the saved pins. Re-detection preserves reviewed pins and merges nearby matching source labels.
Nearby Japanese captions immediately above English are grouped into one English-named
pin; the Japanese caption remains visible as source text in review. Tightly stacked
caption lines are joined. Different locations with the same room name remain separate.
Existing saved bilingual duplicates are also grouped when loaded; saving retains the
cleaned set. Grouping uses text boxes and spacing, not machine translation, so review
is still necessary for unusual layouts. New image imports start with no pins.

Pins store top-left normalized image coordinates. They follow image movement,
rotation and scaling in the editor. In **Floor Maps**, tap a numbered pin to choose a starting point, or choose a goal
from **Saved destinations**. Selection highlights the pin and label; it does
not move the general map or create a GPS line. Closing Floor Maps removes those
pins from the page. Labels are inserted as text, never HTML.

Pins indicate printed labels rather than room entrances. OCR does not infer walls,
walking paths or usable exits, and does not improve indoor GPS.

Old saved plans and the bundled default remain compatible without a destinations
field. Local data, including reviewed pins, remains on that iPhone.

Implementation reference: [Apple Vision text recognition](https://developer.apple.com/documentation/vision/recognizing-text-in-images).

The native integration regression loads the real bundled page in WKWebView and
checks image synchronization, pins confined to Floor Maps, geographic Hide/Show,
and reload. Browser checks additionally cover replacement images, revised pin
positions, floor switching, selection and reopening. Native tests also cover the
full-height map and the retained Details editor action. Fixtures do not overwrite
saved phone data.
