# IndoorAtlas positioning in Contour

Contour's Android menu includes **Indoor navigation**. It opens a native Compose
screen, separate from the outdoor walking route and camera AR screens. This is a
positioning preview: it displays a detected floor's image, estimated position,
reported accuracy circle and phone heading. It does not infer evacuation routes,
exits, door availability or assembly areas from an image.

## Prepare a venue

1. In the [IndoorAtlas web app](https://app.indooratlas.com/), create the venue and
   upload a separate image for each floor. Set the correct floor levels/heights
   and align the scale, rotation and geographic location. The app displays the
   configured floor level as-is; use consistent labels across your venue.
2. Survey the supported areas using MapCreator on a compatible Android phone.
   Generate the signal maps and validate positioning on site. Beacon Planner is
   unnecessary if you are not installing beacons. Existing Wi-Fi and magnetic
   signals still need surveying for this deployment approach.
3. Ensure the Positioning SDK credentials have access to that venue and your
   subscription/trial is active. A public PDF is not a signal map. Obtain reuse
   permission and verify its layout before publishing it in the app.

See the [vendor setup guide](https://www.indooratlas.com/get-started/).

## Configure and build

Add the following to ignored `android/local.properties` (also documented in
`android/local.properties.example`):

```properties
INDOORATLAS_API_KEY=your-client-sdk-key
INDOORATLAS_API_SECRET=your-client-sdk-secret
```

These are client SDK credentials, packaged into the APK through BuildConfig.
They are recoverable from an installed app; never use server/admin credentials.
Do not commit actual credentials or paste them into issue reports. Follow the
vendor's app credential controls and quota restrictions.

The dependency is pinned to `com.indooratlas.android:indooratlas-android-sdk:3.8.1@aar`
from IndoorAtlas's stable Cloudsmith Maven repository, restricted to that group.
No credentials are needed to resolve the public dependency. No backend API or
Cloud deployment is required for the integration.

From `android/`, with JDK 17 and Android SDK 35:

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Install a new APK. The native shell adds its menu entry to both bundled and older
hosted Contour HTML after page load, so updating the server is unnecessary.
The origin-restricted WebMessage listener accepts only the `open` command from
trusted main frames. No SDK credentials or position fixes are sent to JavaScript.
The feature requires WebView support for `WEB_MESSAGE_LISTENER`; update Android
System WebView if the entry is missing.

## Try it

1. Open the hamburger menu → **Indoor navigation**.
2. Review the positioning notice and tap **Start positioning**. Allow precise
   location and, on Android 12+, nearby-device scanning. Approximate location
   alone is insufficient for this integration. Enable system location services
   and available Wi-Fi/Bluetooth scanning. Camera permission is not needed.
3. Inside the prepared venue, wait for the SDK to detect a floor. The app obtains
   the image/metadata from IndoorAtlas and converts position coordinates using
   `IAFloorPlan.coordinateToPoint`. It uses the floor bearing to align the phone's
   heading cone with the image. The cone is phone direction, not gaze or walking
   direction. Pinch/drag to inspect the map; **Reset map** restores the full plan.
4. Walk a measured test course and compare against actual landmarks. Check floor
   transitions, accuracy, and convergence on several phones. An off-image,
   unknown-floor, mismatched-floor, invalid or stale fix hides the dot rather
   than clamping it to an edge. A matching reported floor is not independent
   verification that the detected floor is correct. Accuracy is an SDK estimate,
   not a guarantee that a route or nearby door is safe.
5. **Stop**, Back, switching apps or turning off the screen stops subscriptions
   and clears position/heading. Returning requires **Start positioning** again.
   The SDK manager is destroyed with its ViewModel. There is no background service.

## Failure states and limits

- Without local credentials the app remains usable, with an explicit unconfigured
  message. Invalid/revoked credentials, subscription/network problems or unsupported
  hardware show unavailable/limited states; raw SDK errors and credentials are not
  displayed or logged by this feature.
- Permission denial offers app settings and a retry through **Start positioning**.
- Unmapped floors show no substitute image, synthetic dot or outdoor GPS fallback.
- Failed image loads have an explicit retry. Downloads use HTTPS, time/size limits
  and sampled decoding. Floor transitions cancel old loads. Image requests do not
  follow redirects; if your configured image endpoint redirects, adapt this loader
  after inspecting the vendor's actual URL behavior.
- Fixes stop appearing after 15 seconds without updates; headings expire after
  10 seconds. A fresh update restores display. Low accuracy expands the reported
  uncertainty circle; it does not imply room-level confidence.
- No persistent floor-image cache or guaranteed offline cold start is implemented.
  Downloading SDK signal maps is separate from downloading floor images. Test
  airplane mode, process restart, expired credentials and first visit independently
  before claiming offline support.
- No routing, automatic safe-exit selection, floor override, camera AR, emergency
  detection or live blockage handling is added here. Configure and verify a route
  network and disaster procedures separately before adding evacuation guidance.
- Requires a physical compatible phone for positioning; an emulator can verify UI,
  permission denial, lifecycle and missing configuration only.

## Verification checklist

- Missing credentials: menu opens, explanation shown, no permission prompt.
- Permission denial/permanent denial: no crash; settings and retry work.
- Valid credentials + surveyed venue: floor image, position, accuracy and heading
  agree with known landmarks and image orientation.
- Wrong floor/outside venue/no fresh data: dot disappears; no fabricated position.
- Floor image failure/rapid floor change: retry works, old image never replaces new.
- Background, Back and rotation: subscriptions stop, dot clears, no background work.
- Untrusted frames/pages and unsupported commands cannot launch native positioning.

Reference implementation:
[IndoorAtlas official Android examples](https://github.com/IndoorAtlas/android-sdk-examples).
