# Contour UI prototype

The visual design for Contour, as one HTML page shown in an Android WebView. It is a
design reference and a runnable demo, separate from the Compose app in `../android/`.

- Source of the design: `android/app/src/main/assets/contour.html` (single file: HTML, CSS, JS).
- Android shell: `android/` (Android Studio project, own Gradle build, app id `com.contour.ui`,
  so it installs next to the Compose app instead of replacing it).

## Open and run
1. Android Studio: **File > Open** and pick `ui-prototype/android`. Let Gradle sync (JDK 17+).
2. Run on an emulator or phone. Allow the camera for 3D AR directions.

## What it contains
Top page, Area list, Surrounding (map with shelter cards and a detail sheet), Attendance sheet
(register / confirm survivor information, saved on the device only), Disaster info placeholder,
3D AR directions (camera + compass arrows), and English / 日本語 / 中文 / 한국어.

## Design rules
- Palette: warm off-white `#F7F6F2`, charcoal `#202321`, safety red `#C74636`, muted green `#D9E4D6`,
  plus light blue, sand and clay tints for the Top page cards.
- Headings and numbers: Barlow Condensed. Everything else: Noto Sans JP. Sentence case, no all-caps.
- Corners 8–12 px, thin borders instead of shadows.

## Limits (this is a prototype)
- All shelters, capacities and the user's position (Nagoya University) are fictional demo data.
- 3D AR here is a compass arrow on the camera view, not ARCore geospatial tracking.
- The map, Leaflet and fonts load from the internet.
