# Contour UI prototype

The visual design for Contour, as one HTML page shown in an Android WebView. It is a design
reference and a runnable demo, separate from the Compose app one folder up (`android/app`).
It is not part of that Gradle build: it has its own `settings.gradle.kts` and wrapper.

- Design source: `app/src/main/assets/contour.html` (one file: HTML, CSS, JS). Edit it, then run again.
- Android shell: this folder, app id `com.contour.ui`, so it installs next to the Compose app
  instead of replacing it.
- Built with Android Studio 2026.2, AGP 9.5.0, Gradle 9.8.2, compile SDK 37 (JDK 17 or newer).

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
- The page is served from `https://appassets.androidplatform.net/assets/contour.html` by the app
  itself, a secure context, which the camera and compass need.
- The WebView user agent carries `ContourApp`; the page then fills the real screen instead of
  drawing its own phone frame. Back closes AR / sheet / menu / page first, then goes to the Top tab.
- Links outside the app (Google Maps directions) open in the matching app.

## Limits (this is a prototype)
- All shelters, capacities and the user's position (Nagoya University) are fictional demo data.
- 3D AR here is a compass arrow on the camera view, not ARCore geospatial tracking.
- The map, Leaflet and fonts load from the internet.
