# Relative direction and obstacle-avoidance demo

The native camera view shows relative arrows based on observed nearby surfaces.
It can start without knowing a floor-map checkpoint. The demo checks the visible
area and changes the forward cue when an obstruction is observed. It does not
solve a maze, prove a complete route clear or locate the phone on the map.

## Implemented flow

1. Open **01 Central Library → 3D AR directions**. Camera permission and native
   tracking are required. The start is explicitly assumed; a usable compass is
   optional and a heading guess can be edited.
2. The top **Start guess · Edit** defaults to the image-inferred north-east
   aisle on 2F. It can be corrected to the south-east aisle, Service Desk public
   side or Entrance Hall. Shared Kotlin guidance targets the next passage point,
   then the same digitized final Entrance Hall doors. iOS uses this phone's saved
   image width/aspect/rotation; Android uses the exported snapshot.
3. A usable compass registers map orientation; otherwise the opening camera is
   assumed to face the first segment. **Next guess · Edit** corrects the route's
   rotation. GPS is not required to initialize this explicitly assumed start.
   AR displacement estimates progress; advancing requires both proximity and
   lateral alignment to the incoming segment, not just guessed distance.
4. The floor still starts at hardcoded **2F guess**. A different selected floor
   pauses this native iteration; changing its label does not create a stairs
   route. See [library-waypoint-demo.md](library-waypoint-demo.md) for the exact
   unsurveyed path and coordinate assumptions.
5. The movement label uses **Move straight**, **Move left**, **Move right**,
   **Turn around**, **Stop**, or **Hold**. Verbose technical depth messages are
   hidden during normal scanning; camera/service startup failures remain visible.
   An observed farther front sector keeps the arrow straight when the desired
   side is near or unknown. A turn toward the exit requires farther evidence in
   that side sector as well as the front. A close front surface overrides forward
   and can suggest an observed farther side. Missing observations show **Hold**
   with an amber, camera-relative arrow preview. A turn-around is rotation in place, not a checked path.
   Chevrons stay centred and point straight while following the aisle.

The goal is an image-inferred waypoint from an assumed start, not a verified
indoor localization result. The image door position and geographic alignment are unsurveyed. Opening
on a different floor, a wrong guessed start, magnetism, unobserved obstacles or closed doors
can make it wrong. No full route, maze, floor, stairs or arrival is established.
A turn-around cue asks you to rotate in place; it does not indicate a checked
walking route behind you. Readable repeated room signs and ordinary shelves do
not establish a unique camera pose and are not used as point localization.

The previous map/photo/checkpoint tools remain in **Details → Library floor
maps**, with optional obstacle review and server-validated blocked-edge reroutes.
That separate flow still needs a physically confirmed checkpoint and manually
calibrated heading. No code automatically fuses a photo candidate, IndoorAtlas's
Room221 pose or an uncaptured Cloud Anchor into the demo. A surveyed and registered
library pose is still needed for reliable absolute indoor guidance.

## What each phone measures

Android uses the existing ARCore SDK's `AUTOMATIC` Depth mode, enabled only when
the device reports support. It reads fresh 16-bit depth images, maps the visible
left/centre/right sample areas through ARCore's display transform, and requires sustained
near-depth observations with active tracking and a nearly level camera. The
result is a possible close surface, not a classified bookshelf, person or closed
door. Devices without Depth support automatically enable ARCore plane detection
and use sparse camera features plus tracked vertical-plane hit tests. Devices
without ARCore tracking remain unavailable. See
[Android implementation and thresholds](obstacle-scan-android.md).

Google documents that supported devices can estimate depth from camera motion
without a dedicated time-of-flight sensor. This does not mean all Android phones
support Depth, or that Depth detects every obstruction.
[ARCore Depth](https://developers.google.com/ar/develop/depth),
[Android Depth guide](https://developers.google.com/ar/develop/java/depth/developer-guide).

iPhone now explicitly uses **camera-only** visual/inertial ARKit tracking on every
model, including LiDAR-capable Pro phones. No scene depth or mesh is enabled.
Spatially distributed visual features and multiple tracked-plane probes drive a
local arrow; the screen can switch between **Obstacle arrow** and the approximate
**Library exit** goal. See [camera-only iPhone implementation](camera-obstacle-arrow-ios.md)
for evidence gates, lifecycle and phone test instructions.

Android retains its existing camera-evidence policy when Depth is unsupported. Its
point cloud requires confidence at least0.5 and a fresh timestamp; tracked vertical
planes must contain the ray hit. Features/planes share the depth path's sustained
observation, stale/repeated frame and tilt gates. Sensor selection happens at
session creation, with no extra user setup. The fallback is weaker: glass, blank
surfaces, low objects and people can be missed. It is an observed-geometry estimate,
not reconstructed clearance. Both modes use the image-inferred next-waypoint goal and continuous chevrons, with no
map tap or checkpoint confirmation. Unknown geometry never permits forward walking.

Apple requires capability checks for scene depth and mesh reconstruction.
[Apple scene reconstruction capability](<https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/supportsscenereconstruction(_:)>),
[ARKit scene depth](https://developer.apple.com/documentation/arkit/arframe/scenedepth).

On both platforms, the distance is relative to the camera, not the user's body
or a mapped door. An obstacle outside the sampled view, below the sampled region
or around the next corner is unobserved. Sensor absence, poor tracking and stale
frames remain unknown. No model-generated confidence percentage or guessed
free-space geometry is used to steer the arrow.

## Registration, network and costs

Neither scanner establishes a surveyed absolute floor-map pose or identifies
the blocked graph edge. Automated edge selection would require a surveyed metric map,
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
depth, tilt, noise, and gap resets. Corridor-first cases cover a goal to the right
with a blocked/unknown right side, then an observed farther right side; equivalent
iOS cases cover left and right openings. Backend/browser checks cover bidirectional
edge exclusions, an alternate library route and no-path handling. Direction tests
cover observed forward space, left/right checks, blocked sides, unknown depth,
and immediate removal of a forward arrow when a near surface appears. Build/lint and
simulator checks cannot establish physical obstacle detection. Test the actual
LiDAR iPhone and supported Android at the library: editable initial direction,
straight-to-opening transition, permission
denial, foreground/background transitions, a visible wall/shelf, a low obstacle,
glass, changes in lighting, and opening bearing consistency. These
checks remain required before depending on this feature in the field.

Arrow rendering uses the same five camera-relative chevrons on iOS and Android.
The preview is visible while tracking/GPS/nearby surface observations initialize;
it stays amber with Hold and does not claim walking clearance. Supported movement
cues turn it white. A detected close obstruction with no supported detour suppresses
it. iOS draws in screen coordinates so camera tilt or floor-plane projection cannot
place all chevrons off screen. Heading/start remain explicitly editable assumptions.
