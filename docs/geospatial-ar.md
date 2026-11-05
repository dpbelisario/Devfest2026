# Geospatial AR on Android

The Android app opens a native Kotlin/Compose AR screen from the map's **3D AR** button or the
place detail sheet. It uses ARCore Geospatial localization, a live camera texture, and terrain
anchors. The browser-only page retains its explicitly fictional camera/compass prototype.

## Configure a build

1. Enable **ARCore API** in a Google Cloud project.
2. Create an Android API key. Restrict it to package `com.contour.app` and the signing certificate's
   SHA-1 fingerprint, and restrict API access to ARCore API. Use `./gradlew :app:signingReport` to
   identify the development signing certificate. Distribution builds need their own matching
   restriction. Android keys are public in the APK; do not use a server credential here.
3. Set these values in the ignored `android/local.properties`:

   ```properties
   ARCORE_API_KEY=YOUR_RESTRICTED_ANDROID_KEY
   EVACUATION_AR_API_BASE_URL=https://YOUR_BACKEND/
   ```

   The build also accepts `-ParCoreApiKey=...`. No credential is checked into the repository.
   `http://10.0.2.2:8080/` works only for emulator-to-host backend access; use HTTPS on a phone.

4. Build and install a **new APK**. Updating hosted HTML alone cannot add native AR.
5. Use a supported physical Android device with Google Play Services for AR and device location
   enabled. The app offers ARCore installation when necessary, checks Geospatial support, and
   asks for camera and **precise** location only after the AR notice is accepted.

The implementation uses API-key authentication. Keyless authorization is not configured. No
backend deployment or API/schema changes are required by this feature.

## Destinations and routes

The HTML map's Nagoya locations have no backend IDs and remain fictional. Native AR therefore
opens a separate backend destination picker instead of translating a map-card index into an
unrelated destination. Both the bundled page and older hosted pages are supported: an
origin-restricted, main-frame WebView message opens the native screen. The message carries no
arbitrary native method, URL, coordinates, or destination ID.

After accurate localization, Android calls:

- `GET /destinations?lat=<actual latitude>&lng=<actual longitude>&disaster=earthquake`
- `GET /directions?originLat=<actual latitude>&originLng=<actual longitude>&destinationId=<backend ID>`

The repository's fixed-origin overloads remain available only for the original Compose route
preview. Native AR always uses the actual ARCore pose. It validates route coordinates and the
supported start area and does not replace a failed request with synthetic device coordinates.

The current backend contains only `demo-site-1`, with a synthetic route beginning near
`35.6800, 139.7670` in Tokyo, accepted within 40 metres of its start. It is not a usable pedestrian
or evacuation route. At most other locations the destination list will be empty, or route loading
will report that the origin is unsupported. **Do not travel to or follow this fictional route.**
For outdoor validation, replace the sample through a separate reviewed data change with a
surveyed, pedestrian-safe test course at your actual testing location, preserving provenance and
explicit prototype labels. Route generation, hazard-aware rerouting, and verified shelter data
are not supplied by ARCore and are not implemented here.

## Tracking and rendering

- Camera and Earth must both be tracking. Accuracy must remain at or below 3 m horizontal,
  5 m vertical, and 10 degrees yaw for two seconds before precise arrows can appear.
- Once localized, tracking drops when accuracy exceeds 5 m horizontal, 8 m vertical, or 15 degrees
  yaw. These are prototype thresholds, not a safety guarantee. Arrows disappear immediately on
  tracking loss and localization must stabilize again before they return.
- Up to three upcoming waypoints within 100 m are resolved asynchronously, 0.1 m above terrain.
  Their arrows use the east/up/south anchor frame and point toward the following segment. The
  final waypoint uses the incoming segment bearing. The app renders waypoint arrows, not a
  continuous traversable path; it has no depth-based obstacle avoidance or real-world occlusion.
- Failed terrain resolution is reported, and pending requests time out after 30 seconds. Retry AR
  to resolve again after fixing network access, authorization, quota, or coverage.
- The app hides arrows outside a 20 m route corridor. It advances one waypoint when an accurate
  pose comes within 5 m; completing the demo does not establish arrival at a safe site.
- On pause, the GL surface stops before anchor cancellation/detachment and ARCore pause. Closing
  the screen closes the session. Route progress is retained across ordinary camera pauses.

Consent includes Google's sensor-data processing notice and links to ARCore data handling and
Google's privacy policy. Permissions and consent are handled in the native screen. Native AR
labels are currently English, independently of the map's language setting.

## Verification

Run from `android/` with JDK 17 and SDK 35:

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Unit tests exercise accuracy dwell/hysteresis, immediate tracking loss, invalid accuracy values,
cardinal bearings, sequential waypoint progress, and route-corridor boundaries.

Local verification on 2026-11-05: debug assembly, all seven Android unit tests, and Android lint
passed using installed JDK 21 (JDK 17 was unavailable). Native launch, consent, permission-denial
recovery, Back navigation, and rejection of invalid/child-frame bridge requests were checked on
Pixel 8 API 35 and Medium Phone API 37. The missing-configuration recovery screen was also checked
on API 35. Backend type checking, lint, all five tests, and build passed. Whole-repository formatting
still flags unchanged `backend/scripts/copy-data.mjs`, `backend/src/services/webAppService.ts`, and
`docs/apk-distribution.md`; the documents changed for AR pass formatting. No physical-device
localization, terrain alignment, or configured ARCore authorization check was performed.

Manual checks:

1. From a bundled and hosted UI, tap 3D AR. Confirm the native notice opens and no browser camera
   stream starts. Back returns to the map. Map menu/language controls still work.
2. Decline consent or deny permissions: no AR session starts. Granting approximate location alone
   must not enable AR. Check the app-settings recovery flow after permanent denial.
3. A build without configuration shows a setup message. An unsupported device shows an error;
   it must not display simulated geospatial guidance.
4. On a configured physical phone outdoors, test low accuracy, recovery, network/auth failures,
   empty destinations, unsupported origin, route selection, and terrain-resolution success.
5. On a surveyed test course, verify arrow positions and bearings in the field. Lose tracking,
   move outside the corridor, replace the route, background/resume, rotate, and exit. Check that
   no stale arrows remain and the camera is released. Test gesture and three-button navigation.

Emulators can exercise launch/setup/permission UI, but do not establish Geospatial localization,
terrain alignment, or navigation correctness. Credentials and physical-device field testing are
required before claiming those checks pass.

## References

- [Enable Geospatial](https://developers.google.com/ar/develop/java/geospatial/enable)
- [ARCore authorization](https://developers.google.com/ar/develop/authorization?platform=android)
- [Terrain anchors](https://developers.google.com/ar/develop/java/geospatial/anchors)
- [Pose accuracy](https://developers.google.com/ar/develop/java/geospatial/obtain-device-pose)
- [Privacy requirements](https://developers.google.com/ar/develop/privacy-requirements)
