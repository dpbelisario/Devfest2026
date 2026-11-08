# Contour UI

The app opens the Contour UI: one HTML page (`android/app/src/main/assets/contour.html`) shown in a
WebView by `WebUiActivity`. The original Compose scaffold (`MainActivity`: destination list and route
preview) is still in the app but is no longer the launcher; start it with
`adb shell am start -n com.contour.app/.MainActivity`.

- Design source: `android/app/src/main/assets/contour.html` (single file: HTML, CSS, JS).
- Hosting: the backend serves this same file at `/app/`. The app loads it from there, so a change to
  `contour.html` reaches phones when the backend redeploys, without a new APK. The APK build is in
  `android/cloudbuild.yaml`; see [apk-distribution.md](apk-distribution.md).

## Open and run

1. Android Studio: **File > Open** and pick `android/`. Let Gradle sync (JDK 17).
2. Pick a phone or emulator, press **Run**. Allow the camera for 3D AR directions.
3. Optional: set `CONTOUR_UI_URL=https://<backend>/app/` in `android/local.properties` to load the hosted page.

## What it contains

Top page, Area list, Surrounding (map with shelter cards and a detail sheet), Attendance sheet
(register / confirm survivor information, saved on the device only), Disaster info placeholder,
3D AR directions (camera + compass arrows), indoor navigation in a fictional building
([indoor-nav.md](indoor-nav.md)), and English / 日本語 / 中文 / 한국어.

## Design rules

- Palette: cool white `#F3F5F3`, near-black `#141714`, green `#178049`, soft green `#DFF0E5`,
  red only for "Need help".
- Headings and numbers: Barlow Condensed. Everything else: Noto Sans JP. Sentence case, no all-caps.
- Corners 8–12 px, thin borders instead of shadows.

## How it works

- With `CONTOUR_UI_URL` set (in `local.properties`, or `-PcontourUiUrl` in CI), the app loads the hosted
  page. Without it, or if the hosted page fails or takes over 8 s, it shows the bundled copy from
  `https://appassets.androidplatform.net/assets/contour.html`. Both origins are secure contexts, which
  the camera and compass need.
- The WebView user agent carries `ContourApp`; the page then fills the real screen instead of drawing its own phone frame.
- A native container applies system-bar, display-cutout, and keyboard insets around the WebView.
  Keep this padding on the container: older WebViews can draw content under the system bars when
  padding is applied directly to the WebView, leaving visible header buttons outside their touch area.
- Back button / gesture closes AR / sheet / menu / page first, then returns to the map, then clears
  the search, then leaves the app. It keeps working after the app has been sent to the background.
- Links outside the app (Google Maps directions) open in the matching app.
- Map tiles, Leaflet and fonts load from the internet.

## Check header compatibility

Run the same APK on Pixel 8 API 35 and Medium Phone API 37, including their different WebView
versions. From the map, tap the menu, open a page, return to the map, and switch between English
and Japanese. Check that the header stays below the status bar and cutout and both buttons respond.
Repeat with gesture and three-button navigation. Open the attendance form and its keyboard, verify
that the focused input remains reachable by scrolling, then dismiss the keyboard and check the header
again. Updating WebView alone should not be required to make the header usable.

## Live data, map and AR

See [live-data.md](live-data.md) for the API.

- **Map.** When online, the map lists the 15 nearest official designated emergency evacuation sites
  (Nagoya City, GSI data via the `nagoya-import` workflow) within 4 km. The settings button filters
  by hazard. Cards and the detail sheet show what each site is designated for; opening status and
  capacity are shown as unknown, and distances are straight-line. The dotted line is a straight
  line, not a route. **Directions** opens an in-app walking route preview with distance,
  estimated time and route steps. See [in-app-directions.md](in-app-directions.md) for requirements
  and checks.
- **Location.** The map requests live location on entry. Nagoya University is only the initial
  preview viewport; the position dot and dotted bearing line remain hidden until a fresh fix.
  The first fix centers the map; ongoing updates move the dot and selected line origin without
  replacing the destination. Outside-Nagoya positions are supported, while the evacuation
  dataset and walking routes remain Nagoya-specific. Waiting/unavailable status is shown.
  The Android shell grants location only to our own page origins.
  See [live-location-fix.md](live-location-fix.md) for checks and local iPhone configuration.
- **3D AR.** The arrow points from the current GPS position to the chosen site and updates while
  walking (distance, "You're near the site" within 25 m, low-accuracy warning above 50 m).
  Heading comes from the compass; without one, a slider simulates turning.
- **Disaster info** (menu, or the warning chip on the map) shows the latest JMA Aichi bulletin for
  Nagoya (official status per warning/advisory) and recent earthquake, tsunami and volcano
  bulletins, with links to JMA. A cancelled bulletin is shown as "status unknown", never all-clear.
- **Ask Contour** (button on the map, or the menu) sends questions to the Gemini assistant. It
  answers from the same data and can highlight sites on the map or start AR toward one.
- **Offline / API down.** The page falls back to the fictional demo points (marked "Demo") and
  says so in the status pill.
- **Languages.** Every page (including Emergency information and About, which have their own
  language menu) follows English / 日本語 / 中文 / 한국어. Official site names arrive in Japanese only;
  in the Android app they are machine-translated on the device (ML Kit, `OfflineTranslator`) and
  cached, with the Japanese name kept as the second line. In a plain browser they stay in Japanese.
  Addresses stay in Japanese. Official site names around Nagoya University (434 places) have built-in
  English / Chinese / Korean names; the device translator covers the rest. On Disaster info, JMA
  warning names, statuses, bulletin types and the usual headline sentences are translated in the page,
  with the original Japanese shown under each translated headline.
- **Search** matches place names only (in any of the four languages), not addresses.

## Limits (this is a prototype)

- Official data covers Nagoya City only. Designated sites are not necessarily open shelters.
- Demo points, capacities and gathering points are fictional and only appear offline.
- 3D AR is a compass arrow on the camera view, not ARCore geospatial tracking; accuracy depends on
  GPS and compass calibration.
- The assistant can make mistakes; official announcements take priority.
