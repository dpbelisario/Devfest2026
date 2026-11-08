# Relative direction and obstacle-avoidance demo

The native camera view shows relative arrows based on observed nearby surfaces.
It can start without knowing a floor-map checkpoint. The demo checks the visible
area and changes the forward cue when an obstruction is observed. It does not
solve a maze, prove a complete route clear or locate the phone on the map.

## Implemented flow

1. Open **01 Central Library → 3D AR · Library exit**. Native camera permission
   and device capability checks are the only prerequisites. No extra setup UI.
2. On the first usable level camera pose, retain its world heading as the
   assumed exit direction. Animated chevrons appear immediately, amber while
   waiting for depth, then white when current observations support the cue.
3. Continuous depth updates suppress forward guidance at an observed blocker,
   choose left/right only with farther observations on the chosen side, and
   stop when sampled directions are blocked. Turning the phone updates the
   retained goal's relative direction. Unknown/stale/tilted tracking pauses
   walking guidance; interruptions reset the AR session and assumed heading.
4. Close to return. No checkpoint or per-obstacle confirmation is required.

The initial bearing is a user-authorized demo assumption, not a localization
result. The phone cannot know where the library entrance is from a floor image
or LiDAR alone. The chevrons reuse the normal AR design: five pulsing chevrons
on a camera-relative 3D plane on iOS and a perspective camera overlay on Android.
The local detector does not solve a maze or certify passage. No automatic rear
arrow is generated because the rear is unobserved.

The previous map/photo/checkpoint tools remain in **Details → Library floor
maps**, with optional obstacle review and server-validated blocked-edge reroutes.
That separate flow still needs a physically confirmed checkpoint and manually
calibrated heading. No code automatically fuses a photo candidate, IndoorAtlas's
Room221 pose or an uncaptured Cloud Anchor into the demo. A surveyed and registered
library pose would be needed to replace the startup assumption.

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

iPhone automatically selects LiDAR scene depth and mesh when supported. A
LiDAR phone with temporarily missing depth waits for that depth; it does not
silently downgrade mid-session. Other ARKit phones, including XS Max, use the
camera fallback restored from the earlier obstacle branch (`2d21c02`), with the
current continuous arrow UI. Sparse features are transformed into portrait camera
coordinates; close features or a detected close vertical plane suppress forward
guidance. Six farther features or a farther vertical plane can suggest a direction,
but any observed close feature keeps that sector unknown. A plane at or below
1.5m prevents a farther result. No feature/plane observation means unknown.

Android uses the same camera-evidence policy when Depth is unsupported. Its
point cloud requires confidence at least0.5 and a fresh timestamp; tracked vertical
planes must contain the ray hit. Features/planes share the depth path's sustained
observation, stale/repeated frame and tilt gates. Sensor selection happens at
session creation, with no extra user setup. The fallback is weaker: glass, blank
surfaces, low objects and people can be missed. It is an observed-geometry estimate,
not reconstructed clearance. Both modes retain the initial demo heading and
continuous chevrons, with no map tap or checkpoint confirmation.

Apple requires capability checks for scene depth and mesh reconstruction.
[Apple scene reconstruction capability](<https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/supportsscenereconstruction(_:)>),
[ARKit scene depth](https://developer.apple.com/documentation/arkit/arframe/scenedepth).

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
LiDAR iPhone and supported Android at the library: preview orientation, permission
denial, foreground/background transitions, a visible wall/shelf, a low obstacle,
glass, changes in lighting, and opening bearing consistency. These
checks remain required before depending on this feature in the field.
