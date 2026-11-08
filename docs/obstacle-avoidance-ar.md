# Relative direction and obstacle-avoidance demo

The native camera view shows relative arrows based on observed nearby surfaces.
It can start without knowing a floor-map checkpoint. The demo checks the visible
area and changes the forward cue when an obstruction is observed. It does not
solve a maze, prove a complete route clear or locate the phone on the map.

## Implemented flow

1. Open the native direction demo from the library screen. No checkpoint is
   required for the local camera-relative experiment. A rough location such as
   “top right” is not treated as a calibrated camera pose.
2. Release the WebView camera and open the native view. The native
   view handles permission/support checks and displays the camera. Move the
   phone slowly while keeping it level and facing the passage in question.
3. Wait for usable observations. On supported Android, sustained farther centre
   depth allows a relative forward arrow. A near centre suppresses that arrow;
   farther side observations can suggest **Check left/right**. Near surfaces on
   both sides produce **Stop**. Unknown observations ask the user to scan. These
   cues suggest where to look, not a command to walk blindly.
4. Optionally return to the library map for a longer reroute. Confirm the actual
   current checkpoint and the passage that is blocked. The
   map request excludes that graph edge in both directions and searches the
   existing route graph again. The sensor cannot select the map edge for the user.
5. If an alternate plan exists, review it and recheck the directional alignment.
   If no route remains, keep navigation paused. An HTTP 422 no-path result does
   not justify following the excluded passage or inventing a connection.

The scan arrows are relative to the current camera view. They are not registered
to a world waypoint or library destination. They only react to the local view;
a turn may reveal another obstacle or a dead end. There is no automatic back
arrow because the rear is unobserved. Map-route direction resumes only through
the existing checkpoint/heading checks after returning. The official drawing
and graph edges remain plan previews until surveyed.

## What each phone measures

Android uses the existing ARCore SDK's `AUTOMATIC` Depth mode, enabled only when
the device reports support. It reads fresh 16-bit depth images, maps the visible
left/centre/right sample areas through ARCore's display transform, and requires sustained
near-depth observations with active tracking and a nearly level camera. The
result is a possible close surface, not a classified bookshelf, person or closed
door. Unsupported devices report unavailable. See
[Android implementation and thresholds](obstacle-scan-android.md).

Google documents that supported devices can estimate depth from camera motion
without a dedicated time-of-flight sensor. This does not mean all Android phones
support Depth, or that Depth detects every obstruction.
[ARCore Depth](https://developers.google.com/ar/develop/depth),
[Android Depth guide](https://developers.google.com/ar/develop/java/depth/developer-guide).

iPhone uses a native ARKit session. On a supported LiDAR device, scene depth can
provide denser measurements, gated by device capability, depth confidence and
freshness. The XS Max has no LiDAR, so its implementation uses sparse tracked
feature points and detected vertical-plane geometry as a weaker indication of
a nearby surface. Plain shelves, glass, small objects, moving people and surfaces
without reliable features may be missed. Sparse geometry is not a dense scan.
Apple requires a LiDAR-capable device for scene reconstruction and requires
checking support before enabling it.
[Apple capability requirement](<https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/supportsscenereconstruction(_:)>),
[plane-geometry raycast target](https://developer.apple.com/documentation/arkit/arraycastquery/target-swift.enum/existingplanegeometry).

On both platforms, the distance is relative to the camera, not the user's body
or a mapped door. An obstacle outside the sampled view, below the sampled region
or around the next corner is unobserved. Sensor absence, poor tracking and stale
frames remain unknown. No model-generated confidence percentage or guessed
free-space geometry is used to steer the arrow.

## Registration, network and costs

Neither scanner estimates absolute floor-map location or identifies the blocked
graph edge. Automated edge selection would require a surveyed metric map,
registered camera pose, measured passage widths, and a local occupancy model
tested against real obstacles. The
[Cloud Anchor localization design](library-localization.md) explains the missing
registration and survey work. No Cloud Anchors were installed or captured for
this release.

Native sensing runs on-device with no extra paid model or cloud positioning API
configured. Android may need connectivity to install or update Google Play
Services for AR before first use. Existing hosted backend calls still have their
normal infrastructure costs. Gemini photo landmark identification is a separate,
explicit action with model usage; it is not the obstruction detector.

Native scanning and bundled floor-plan previews can work without a route-network
request once their device prerequisites are available. The server-validated
blocked-edge reroute requires the backend. If that request fails, keep the
guidance paused and show the map/manual checkpoint controls; do not treat the
last route as an updated obstacle-free route.

## Lifecycle and verification

The native screen owns the camera while scanning. It stops AR updates when
suspended or dismissed, releases sessions on completion, and reports through
`window.contourObstacle({status, reason})`. WebView/native camera ownership must
switch explicitly. Reopening the scanner starts fresh observations rather than
reusing a stale obstruction result.

Automated checks cover the Android evidence gate, stale/repeated frames, missing
depth, tilt, noise, and gap resets. Backend/browser checks cover bidirectional
edge exclusions, an alternate library route and no-path handling. Direction tests
cover observed forward space, left/right checks, blocked sides, unknown depth,
and immediate removal of a forward arrow when a near surface appears. Build/lint and
simulator checks cannot establish physical obstacle detection. Test the actual
XS Max and supported Android at the library: preview orientation, permission
denial, foreground/background transitions, a visible wall/shelf, a low obstacle,
glass, changes in lighting, and confirmation of the correct map segment. These
checks remain required before depending on this feature in the field.
