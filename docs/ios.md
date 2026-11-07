# iPhone weekend demo

Contour keeps its HTML interface. Android and iOS share the Kotlin alert classifier;
UIKit/WKWebView handles iOS location, speech, camera permissions and foreground haptics.

## Install with a free Personal Team

1. Install Xcode. This Mac's macOS 15.4.1 supports Xcode 16.4; obtain it from
   https://developer.apple.com/download/all/ if the App Store version needs a newer macOS.
   Make enough disk space for the download, extraction and builds (aim for 40–50 GB).
2. Launch Xcode, finish its first-launch setup and install iOS platform support.
   In Xcode → Settings → Accounts, add your Apple Account yourself.
3. Connect and unlock the iPhone. Choose Trust on the phone if prompted.
   In iPhone Settings → Privacy & Security → Developer Mode, enable it and
   restart/confirm if prompted. It may appear after Xcode first pairs the device.
4. Open `ios/Contour.xcodeproj`. Select the blue Contour project, then the
   **Contour** app target → Signing & Capabilities. Enable Automatically manage
   signing, select your Personal Team, and change the bundle identifier to
   a unique value, such as `com.dpbelisario.contour.weekend`.
5. At the top of Xcode choose scheme **Contour**, then your physical iPhone as
   the run destination. Press **⌘R**. The first Kotlin build downloads its toolchain.
6. If the iPhone says Untrusted Developer, go to Settings → General → VPN &
   Device Management, select your developer profile, and trust it. Run again.
7. Allow notifications when requested. In Contour's menu open Emergency alerts
   and tap the test button. Keep Contour open and wait five seconds to test the
   alert screen and 12 strong foreground pulses. Dismiss it to stop the pulses.
   Also test with the phone locked: tap its notification to open Contour.

The project uses the existing Homebrew JDK 17 and Android SDK paths in its Kotlin
build phase. If building on another Mac, update those paths in Build Phases →
Build shared Kotlin. No Firebase iOS registration is needed for this local demo.

Free development provisioning expires after seven days; reconnect and press ⌘R
to install again. Apple limits Personal Team device/app registrations. There is
no TestFlight distribution or remote APNs support in this free-signing build.
See https://developer.apple.com/help/account/basics/about-your-developer-account/.

## Verification and limits

Run `node --test ios/tests/bridge.test.cjs` for the location/notification adapter.
With full Xcode installed, choose an iOS simulator and press ⌘U for XCTest.
A physical iPhone is required to verify haptics, location and camera.

The default page is the hosted HTML; native notifications and haptics work with
its existing bridge, but the new iOS-specific permission wording needs the
updated HTML deployed. When the host fails, the app loads bundled HTML. External
map assets, live data, routing and assistant still require internet. Camera
capture is denied for the bundled file page. Offline operation is not complete.

This build does not read government/carrier earthquake alerts on iOS or send
remote earthquake pushes. Local test notifications are demonstrations only.
Background vibration follows iOS notification settings; custom repeated haptics
run only while Contour is active. On-device name translation remains Android-only.
GPS/camera arrows and walking previews are not verified emergency routes.

The Xcode project has been structurally checked and Swift syntax parsed, but
an iOS compile and simulator/device run are still required before calling it ready.
