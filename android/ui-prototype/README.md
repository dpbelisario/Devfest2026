# Contour UI prototype

The visual design for Contour, as one HTML page shown in an Android WebView. It is a design
reference and a runnable demo, separate from the Compose app in `android/app`. It is its own
Gradle project (own `settings.gradle.kts` and wrapper) and is not part of the Compose build.

- Source of the design: `app/src/main/assets/contour.html` (single file: HTML, CSS, JS).
- Android shell: this folder (Android Studio project, own Gradle build, app id `com.contour.app`).
  This is the app distributed to testers; see `../../docs/apk-distribution.md`.
- Hosting: the backend serves this same file at `/app/`. The shell loads it from there, so a
  change to `contour.html` reaches phones when the backend redeploys, without a new APK.

Built with Android Studio 2026.2, AGP 9.5.0, Gradle 9.8.2, compile SDK 37 (JDK 17 or newer).

## Open and run

1. Android Studio: **File > Open** and pick `android/ui-prototype` (this folder, not `android/`).
   Let Gradle sync.
2. Pick a phone or emulator, press **Run**. Allow the camera for 3D AR directions.

## What it contains

Top page, Area list, Surrounding (map with shelter cards and a detail sheet), Attendance sheet
(register / confirm survivor information, saved on the device only), Disaster info placeholder,
3D AR directions (camera + compass arrows), and English / 日本語 / 中文 / 한국어.

## Design rules

- Palette: warm off-white `#F7F6F2`, charcoal `#202321`, safety red `#C74636`, muted green `#D9E4D6`,
  plus light blue, sand and clay tints for the Top page cards.
- Headings and numbers: Barlow Condensed. Everything else: Noto Sans JP. Sentence case, no all-caps.
- Corners 8–12 px, thin borders instead of shadows.

## How it works

- With `CONTOUR_UI_URL` set (in `local.properties`, or `-PcontourUiUrl` in CI), the app loads the hosted
  page, e.g. `https://<backend>/app/`. UI changes then reach phones when the backend redeploys.
- Without it, or if the hosted page fails or takes over 8 s, the app shows the bundled copy from
  `https://appassets.androidplatform.net/assets/contour.html`. Both origins are secure contexts, which
  the camera and compass need.
- The WebView user agent carries `ContourApp`; the page then fills the real screen instead of drawing its own phone frame.
- Back button closes AR / sheet / menu / page first, then returns to the Top tab, then exits.
- Links outside the app (Google Maps directions) open in the matching app.
- Map tiles, Leaflet and fonts load from the internet.

## Limits (this is a prototype)

- All shelters, capacities and the user's position (Nagoya University) are fictional demo data.
- 3D AR here is a compass arrow on the camera view, not ARCore geospatial tracking.
