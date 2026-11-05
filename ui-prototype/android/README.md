# Contour UI prototype (Android Studio project)

A thin Android shell around `app/src/main/assets/contour.html`. The design and every feature
live in that one HTML file, so edit it directly, then run the app again.

Built with Android Studio 2026.2, AGP 9.5.0, Gradle 9.8.2, compile SDK 37 (needs JDK 17 or newer).

## Run it
1. Android Studio: **File > Open** and pick this `android` folder (inside `ui-prototype`). Let Gradle sync.
2. Pick a phone or emulator, press **Run**.
3. 3D AR: allow the camera when asked. Emulator virtual camera and sensors work.

## How it works
- The page is served from `https://appassets.androidplatform.net/assets/contour.html` by the app itself,
  a secure context, which the camera and compass need.
- The WebView user agent carries `ContourApp`; the page then fills the real screen instead of drawing its own phone frame.
- Back button closes AR / sheet / menu / page first, then returns to the Top tab, then exits.
- Links outside the app (Google Maps directions) open in the matching app.
- Map tiles, Leaflet and fonts load from the internet.
