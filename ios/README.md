# Contour iPhone foundation

Open `Contour.xcodeproj`, scheme **Contour**. The current home remains the shared
HTML experience; this layout separates existing app code from planned indoor
features without adding an SDK or claiming LiDAR scanning is implemented.

- `Contour/App`: entry, lifecycle and alert handling.
- `Contour/Networking`: HTTPS origin validation for the native bridge.
- `Contour/Features/Home`: current WKWebView controller and device bridges.
- `Contour/Features/FloorPlanImport`, `Calibration`, `IndoorNavigation`:
  tracked feature boundaries; implementations are pending.
- `Contour/Positioning`, `Routing`: integration boundaries; existing GPS remains
  in Home and the indoor graph/demo remain in HTML/backend.
- `Contour/Resources`: privacy descriptions, bridge script and app icon. The
  Android HTML asset is referenced directly by the Xcode project.
- `ContourTests`: native tests; full Xcode is required to run them.

```sh
node --test ios/tests/*.test.cjs
```

The **Build shared Kotlin** phase runs `scripts/build-shared.sh`, honors
`JAVA_HOME` and `ANDROID_HOME`, and builds `ContourShared` through Gradle.
Use JDK 17 and Android SDK 35. Keep team IDs, signing keys and API credentials local.

[Firebase iOS distribution](../docs/ios-firebase.md) documents the registered app,
Google upload identity and manual build pipeline.

[Installation and TestFlight](../docs/ios-setup.md) distinguishes local Personal
Team installation from paid-team uploads. [IndoorAtlas and LiDAR planning](../docs/ios-indoor-navigation.md)
records documented requirements, proposed alignment checks and unresolved limits.
LiDAR stays optional and cannot establish safe routes or absolute position alone.

The native simulator build and four XCTest tests passed with Xcode 16.4.
Signed distribution and physical-device checks remain pending.
