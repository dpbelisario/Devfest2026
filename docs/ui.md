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
3D AR directions (camera + compass arrows), and English / 日本語 / 中文 / 한국어.

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
- Back button closes AR / sheet / menu / page first, then returns to the Top tab, then exits.
- Links outside the app (Google Maps directions) open in the matching app.
- Map tiles, Leaflet and fonts load from the internet.

## Limits (this is a prototype)

- All shelters, capacities and the user's position (Nagoya University) are fictional demo data.
- 3D AR here is a compass arrow on the camera view, not ARCore geospatial tracking.
