# iPhone indoor navigation: IndoorAtlas pilot

Public documentation checked 7 November 2026. This is an integration plan, not an
installed SDK or a measured positioning result. The native iPhone scaffold does
not yet import IndoorAtlas. Its folder structure prepares separate work on floor
plans, calibration and navigation without changing the existing WKWebView flow.

## SDK and device requirements — documented

- The latest listed iOS release is **3.8.1, June 2026**. **iOS 12** has been required
  since 3.7.0. The 2021 setup article's iOS 9/iPhone 4S requirements are outdated.
  [iOS changelog](https://docs.indooratlas.com/technical/changelogs/ios/),
  [supported devices](https://support.indooratlas.com/support/solutions/articles/36000035908-what-are-the-supported-devices-).
- IndoorAtlas publishes an official
  [Swift Package Manager repository](https://github.com/IndoorAtlas/ios-spm).
  Its current [manifest](https://github.com/IndoorAtlas/ios-spm/blob/main/Package.swift)
  declares Swift tools 5.8, iOS 12, product/module `IndoorAtlas`, and a binary SDK
  3.8.1 archive with a checksum. Tag `3.8.1` exists. When integration is approved,
  add that repository through Xcode's package dependencies and pin the selected
  release. Do not add it merely to populate the scaffold. CocoaPods remains a
  documented alternative; `.xcframework` support arrived in 3.6.0.
- The [setup guide](https://support.indooratlas.com/support/solutions/articles/36000051274-setup-positioning-with-ios)
  requires application API key/secret configuration and location, motion and
  Bluetooth purpose strings for the sensors used. Confirm the current permission
  requirements against the selected binary before enabling it. The iOS changelog
  specifically records Motion & Fitness permission for barometer access on iOS
  17.4 and later. Foreground positioning is the initial scope; background access
  needs a separately justified feature. Camera permission belongs to a camera/AR
  feature, not floor-plan import.
- The changelog includes Apple silicon simulator support since 3.6.2. This permits
  build/UI checks; a physical iPhone at the mapped venue is still necessary to
  measure positioning. Simulator success cannot establish indoor accuracy.
- The public API reference currently identifies itself as **3.8.0**, although the
  changelog and package are 3.8.1. Use the selected SDK headers to resolve any
  mismatch. [iOS API](https://docs.indooratlas.com/ios/latest/).

## Venue preparation and calibration — documented

Create a venue, upload floor-plan images, align each plan geographically, and use
**Android MapCreator** to walk the venue and record magnetic/radio fingerprints.
The recordings are uploaded and signal maps generated in the cloud. A floor-plan
image imported into the iPhone app does not perform these steps. BLE beacons are
recommended, especially for a fast first position on iPhones; install any planned
beacons before mapping. The older overview says reliable multi-floor iOS deployment
generally needs BLE. Confirm the chosen building's infrastructure instead of
assuming Android and iPhone perform equally.
[Current getting-started workflow](https://www.indooratlas.com/get-started/),
[positioning overview](https://support.indooratlas.com/support/solutions/articles/36000079590-indooratlas-positioning-and-augmented-reality-ar-overview).

MapCreator calibration first holds the Android phone still on a stable non-metal
surface for the gyroscope, then rotates it around its axes for the magnetometer.
Repeat when MapCreator requests it. Mapping devices require hardware magnetometer
and gyroscope sensors with access to uncalibrated data. These survey steps are
distinct from aligning an imported drawing and from confirming the user's current
landmark. [Calibration](https://support.indooratlas.com/support/solutions/articles/36000050488-calibration-for-fingerprinting),
[mapping-device check](https://support.indooratlas.com/support/solutions/articles/36000054948-is-my-device-good-for-fingerprinting-).

Validate map quality and then record ground-truth test paths. The vendor's workflow
uses Session Viewer to compare estimated positions with those paths. Quality views
help find bad fingerprint coverage; they do not prove that routes or exits are safe.
[Validation workflow](https://www.indooratlas.com/get-started/),
[map quality](https://support.indooratlas.com/support/solutions/articles/36000050540-checking-and-improving-map-quality).

## Coordinate frames and routing — documented API, proposed checks

`IAFloorPlan` exposes image dimensions, scale in pixels/metres, true-north bearing,
geographic corners and coordinate/point conversion methods. SDK wayfinding uses
latitude/longitude **and a floor number**, with a graph created in the vendor editor.
It can return an empty route. Its accessibility support depends on graph tags.
[Floor-plan API](https://docs.indooratlas.com/ios/latest/classes/iafloorplan),
[iOS wayfinding](https://support.indooratlas.com/support/solutions/articles/36000095436-using-wayfinding-with-ios).

For this app, preserve four distinct frames: source image pixels, surveyed local
metres, WGS84 latitude/longitude plus floor, and the current ARKit session's local
coordinates. Record the scale, rotation, geographic alignment, floor identity and
map revision that connect them. A room number is not a floor identifier. Confirm
SDK floor numbering against building signs. Compare converted points with several
surveyed landmarks before displaying live positions. Restarting AR can change its
local origin; a drawing's top edge does not imply true north.

These checks are project design decisions. Keep any existing route preview marked
as unsurveyed; arbitrary graph weights are not metres. A positioning SDK does not
verify walls, doors, exit opening, lifts, closures or emergency suitability. Use a
reviewed graph with floor transitions and authorised paths before live guidance.
The [campus pilot](https://github.com/dpbelisario/Devfest2026/blob/main/docs/indoor-pilot.md)
still describes manual progress and unsurveyed edges; vendor integration does not
automatically validate them.

## Folder ownership — proposed, not implemented

Paths below are within `ios/Contour/`. Add concrete code only when the feature is
implemented; no positioning protocol or routing wrapper is required now.

| Folder                       | Intended responsibility                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `App/`                       | App entry and lifecycle; start/stop feature sessions.                                               |
| `Networking/`                | Existing backend calls and errors; keep backend credentials out of the app.                         |
| `Features/Home/`             | Entry to the current experience.                                                                    |
| `Features/FloorPlanImport/`  | Select and preview a permitted local drawing; no automatic vendor upload.                           |
| `Features/Calibration/`      | Confirm drawing alignment and surveyed landmarks; explain required external survey steps.           |
| `Features/IndoorNavigation/` | Present floor, position confidence, route steps and recovery; allow manual fallback.                |
| `Positioning/`               | Future IndoorAtlas lifecycle/callback handling, permissions, status, timestamp and floor certainty. |
| `Routing/`                   | Reviewed graph and route selection; reject invalid, inaccessible or blocked paths.                  |
| `Resources/`                 | Approved floor-plan assets and attribution; retain required vendor notices when adding the SDK.     |

SDK application keys are recoverable from a distributed client. Keep local values
out of Git and confirm vendor application restrictions and credential rotation.
Do not put administrative/vendor backend credentials in the app. Check session
logging and vendor data handling before recording participant movement.

## Trial and offline limits — documented, with unresolved contract details

The public trial is **30 days, no credit card**, **one venue**, **10 end users**, and
**non-production**. The pricing comparison lists unlimited mapped area for Trial
and 14-day data retention after the licence ends. Plan scope can change; confirm
AR, wayfinding, offline options and the meaning of an end user before enrolling.
No trial has been activated by this work.
[Trial](https://www.indooratlas.com/get-started/),
[pricing and comparison](https://www.indooratlas.com/pricing/).

The overview describes on-device positioning after signal maps download. SDK map
data lives in the application cache. The **historical 3.1.0 changelog** describes
first-use and approximately monthly reconnection for cached operation, and a
separate sales-activated fully offline mode. This is not a verified current trial
entitlement. Confirm authentication refresh, cache eviction, map preloading,
licence expiry, route availability and offline cold start for SDK 3.8.1.
[Overview](https://support.indooratlas.com/support/solutions/articles/36000079590-indooratlas-positioning-and-augmented-reality-ar-overview),
[cache location](https://docs.indooratlas.com/ios/latest/),
[historical offline notes](https://docs.indooratlas.com/technical/changelogs/ios/).

## LiDAR — one future optional iPhone feature

The confirmed development phone is an iPhone XS Max; it has no LiDAR. Keep basic
import/manual navigation available on this phone and use supported hardware for
LiDAR capture testing. Verify support at runtime instead of relying on model names.

RoomPlan could capture room geometry on supported hardware. Check
`RoomCaptureSession.isSupported`; for ARKit scene depth check
`ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)` before enabling
it. Keep floor-plan import and manual landmark confirmation available when the
feature is unsupported or fails. Do not require LiDAR for the basic navigation UI.
[RoomPlan](https://developer.apple.com/documentation/roomplan),
[RoomPlan capability](https://developer.apple.com/documentation/roomplan/roomcapturesession/issupported),
[ARKit capability](<https://developer.apple.com/documentation/arkit/arconfiguration/supportsframesemantics(_:)>).

A LiDAR room scan supplies geometry, not a guaranteed geographic position, floor
identity or reliable relocalization. It does not replace IndoorAtlas's signal
mapping, beacon planning or validation. Connecting a scan to a campus floor plan
would require surveyed alignment and device tests. No LiDAR code is included now.

## Issue-ready verification checklist

- [ ] Confirm SDK 3.8.1 package/Xcode compatibility, iPhone models and required permissions using the [official package](https://github.com/IndoorAtlas/ios-spm) and [changelog](https://docs.indooratlas.com/technical/changelogs/ios/).
- [ ] Confirm the [trial](https://www.indooratlas.com/pricing/) covers the pilot's 10 or fewer testers, one venue, intended features and data retention; document what stops at expiry.
- [ ] Obtain venue/survey permission and current authorised floor plans; verify [alignment and Android mapping](https://www.indooratlas.com/get-started/).
- [ ] Ask whether the venue's existing BLE is sufficient for iPhone first fix and multi-floor detection; record a beacon plan and [mapping-device calibration](https://support.indooratlas.com/support/solutions/articles/36000050488-calibration-for-fingerprinting).
- [ ] Confirm coordinate conversion, SDK floor numbering and graph accessibility tags against surveyed landmarks and [iOS wayfinding](https://support.indooratlas.com/support/solutions/articles/36000095436-using-wayfinding-with-ios).
- [ ] Confirm SDK 3.8.1 offline licensing, preloading, cache lifetime, refresh and cold-start guarantees; distinguish [historical cached/full offline modes](https://docs.indooratlas.com/technical/changelogs/ios/).
- [ ] Test physical iPhones at known doors and floor transitions: error in metres, first reliable fix time, correct floor, stale/lost tracking, permission denial, Bluetooth off and background/foreground recovery. Set acceptable error from actual door spacing.
- [ ] Test connectivity loss mid-session separately from force-stop/relaunch offline, reboot offline, cache loss and licence expiry. A passing cached route preview does not prove offline positioning.
- [ ] Test unsupported LiDAR and scan failure with manual/import fallback; verify precise directions stop when position, floor or route validity is uncertain.

No SDK binary was installed, account created, key obtained, plan uploaded, vendor
message sent or device tested. Public-document checks do not establish building
coverage or safe navigation; those remain pilot acceptance gates.

Tracked work: [iOS foundation #26](https://github.com/dpbelisario/Devfest2026/issues/26), [TestFlight #27](https://github.com/dpbelisario/Devfest2026/issues/27), [IndoorAtlas verification #28](https://github.com/dpbelisario/Devfest2026/issues/28).

## Central Library exit / stairs

The shared page now offers manually confirmed routes across B1–4F to the 2F
entrance, or to stairs on the current floor. Compass calibration is per walking
segment; no native localization or LiDAR is required for this preview. See
[library-demo.md](library-demo.md), [library-localization.md](library-localization.md)
and [library-deployment.md](library-deployment.md).
