# Android relative direction demo

`ObstacleScanActivity` is a native ARCore camera screen. It uses the existing
ARCore 1.48 dependency and processes observations on the device. It does not call
Gemini, create Cloud Anchors or send camera frames to the backend. Google Play
Services for AR must be installed; the activity handles its install request,
camera permission, automatic camera fallback when Depth is unsupported, tracking failures and lifecycle
cleanup. It displays camera-relative arrows using observations in the current
view. This is an experimental direction check, not an autonomous navigation or
collision-prevention system. It can start without a floor-map checkpoint.

The screen enables `Config.DepthMode.AUTOMATIC` only after
`Session.isDepthModeSupported` succeeds. Android Depth combines depth from camera
motion with a hardware depth sensor when available; a dedicated depth sensor is
not required on every supported phone. Support varies by device. Unsupported Depth
automatically selects the camera-feature/vertical-plane path, with the same UI.
[Google's Depth guide](https://developers.google.com/ar/develop/java/depth/developer-guide).

The OpenGL preview uses an external camera texture. Both the camera quad and the
left/centre/right sampling grids are transformed from normalized display coordinates to
texture coordinates through `Frame.transformCoordinates2d`. This follows the
coordinate relationship in the
[official version 1.48 BackgroundRenderer](https://github.com/google-ar/arcore-android-sdk/blob/v1.48.0/samples/hello_ar_java/app/src/main/java/com/google/ar/core/examples/java/common/samplerender/arcore/BackgroundRenderer.java).
The depth reader respects each image plane's row and pixel strides and closes
every acquired image. Shader compilation/link failures return unavailable.

Three visible squares are sampled. A near-centre observation requires:

- Camera state `TRACKING` and a camera direction within approximately 20 degrees
  of horizontal. Looking at the floor does not generate a route obstruction.
- A fresh camera frame and a depth image no more than 200 ms behind it.
- At least 12 valid samples from the 25-point grid; at least a quarter of valid
  samples, and at least four samples, within 1.2 metres of camera-axis depth.
- Three distinct near-depth observations spanning at least 200 ms, without a gap
  longer than 300 ms. Repeated or stale frames cannot accumulate evidence.

The arrow points forward only after the centre sector has at least 18 valid
samples, no depth at or below 1.2 metres, and at least 80% of its valid samples at
or beyond 1.6 metres. The same three-observation stability gate applies. This
means farther surfaces were observed in that sector; it does not prove safe
body clearance or a complete route.

When the centre is near, a side meeting the farther-depth condition can produce
**Check left** or **Check right**. If both sides meet it, the lower depth percentile
selects the side with more observed clearance. If both sides are near, the arrow
shows **Stop**. Unknown or mixed depth asks the user to scan. A new close centre
observation immediately suppresses a previous forward arrow while the turn
suggestion stabilizes. There is no back arrow because the rear is unobserved.

These are conservative pilot heuristics, not measured safety thresholds or
vendor confidence scores. Smoothed Depth provides no per-pixel confidence image
in this path; Raw Depth's separate confidence API is a possible future refinement.
A camera-axis depth is not a measurement of the user's body clearance. Small,
low, overhanging, glass, reflective, fast-moving or out-of-view obstacles can be
missed. Missing data and no detected obstruction are always **unknown**, never
an assertion that the path is clear.

The user can tap **Review possible obstacle** only while the near-surface result
is current. The activity then returns `RESULT_OK` with `obstacle_status=blocked`
and `obstacle_reason=near-surface`. This means a sensor observation to review;
it does not identify a blocked map edge. Back returns `unknown`. The WebView must
release its camera before launching the activity, then receive the result via
`window.contourObstacle({status, reason})`. A mapped passage can be excluded only
after the user confirms their current checkpoint and the blocked passage.

Register `.ar.ObstacleScanActivity` as a non-exported portrait activity and launch
it with the existing Activity Result API. The scanner closes the AR session and
camera when leaving the screen. No ARCore API key or remote visual map is needed
for this local Depth feature.

The iPhone XS Max has no LiDAR and cannot use ARKit `sceneDepth` or scene
reconstruction. Its camera can support ARKit motion tracking and estimated planes,
but those sparse observations cannot establish a complete free-space model.
[Apple's scene reconstruction requirement](<https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/supportsscenereconstruction(_:)>).
Google's Scene Semantics API is explicitly designed for outdoor scenes; it should
not be installed as a library-shelf detector.
[Supported Scene Semantics use cases](https://developers.google.com/ar/develop/scene-semantics).

Pure Kotlin tests cover persistent observations, repeated/stale timestamps,
tracking loss, camera tilt, missing depth, noise and gaps. Android build and lint
checks do not validate physical sensing. Test preview orientation, actual device
depth support, scene lighting, wall/shelf observations, phone tilt, app background
and return, and the user-confirmed reroute flow on physical phones before relying
on this feature in the library.

## Automatic camera fallback

Without Depth support, enable ARCore horizontal/vertical plane detection. Sample
confidence-filtered point-cloud features in left/centre/right camera sectors
and tracked vertical-plane hit tests. Point clouds older than200ms are discarded;
repeated timestamps cannot accumulate feature-only evidence. Near means six
close points or a close plane (<1.2m). Farther requires six points >1.5m or a
farther plane, no observed close point, and no plane at/below1.5m. No observations
remain unknown. Directions share the depth classifier's timing/turn/stop gates.

This adapts the previous iOS camera fallback, retaining its conservative observed
surface policy. It cannot infer empty space from missing points and can miss
glass, blank walls, low objects or people. No extra SDK/model/cloud API is added.
