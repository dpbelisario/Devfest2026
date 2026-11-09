# Camera-only obstacle AR on iPhone

Open **01 Central Library → 3D AR directions**. The native screen now always uses
the rear camera plus ARKit visual/inertial tracking. It does not request LiDAR scene
depth, smoothed depth, or mesh reconstruction, even on a Pro iPhone. No extra model,
cloud image upload, paid API or hardware is added. Android's sensor policy is unchanged.

Choose **Obstacle arrow** for a local directional preview without GPS or an exit
location. Choose **Library exit** to retain main's approximate Entrance Hall goal
from the aligned supported plan, fresh GPS/compass and subsequent AR movement.
Location permission is requested only for the library-goal mode. The floor editor opens from library **Details → Floor overlay**. The saved image remains displayed on the main map; reviewed OCR pins appear only
inside **Floor Maps**; its separate **Open AR navigation** entry uses those pins as
the goal, as described below.

Hold the phone upright and roughly level. Move it slowly side-to-side while
stationary so the camera sees parallax and textured surfaces. The panel reports
left/ahead/right observations. After three consistent fresh checks, five short
chevrons indicate **Check ahead**, **Check left**, or **Check right**. Side chevrons
are positioned along the side direction, rather than just rotating their symbols
on a forward path. They stay inside the detector's observed side-angle range.
Near evidence immediately removes a previous forward suggestion. All directions
near means Stop. Unobserved geometry hides the walking chevrons and asks for a
scan. In library mode, turn-in-place instructions orient to the approximate goal;
they do not draw an unchecked path around a corner.

## Saved destination AR

In **Central Library → Details → Floor Maps**, choose a numbered starting point
and tap **Set my position here** while physically there. Choose a different item in
**Saved destinations**, then tap the full-width **Open AR navigation** button directly
below that selector. It opens the native full-screen camera; Close returns to the
same floor map and selections. The button is disabled until a start is confirmed
and a distinct destination is selected. Camera permission is requested on opening.
Denied permission gives a Settings instruction.

This entry uses the native step/gyroscope pose shared with Floor Maps, seeded from
the confirmed origin and initial compass heading. It does not use GPS, later compass
readings or AR camera translation to update indoor position/direction. The camera
still runs ARKit for sparse geometry and plane-based obstacle observations. The
heading/distance/step counter all come from the same tracker; closing the camera
returns to the same map position. A paused/unavailable motion session disables the
AR action and requires reconfirmation. See [indoor-step-navigation.md](indoor-step-navigation.md).

A screen-space destination arrow appears immediately, before the first AR frame or
surface detection. The shared step-tracker heading provides its bearing immediately, and gyro turns
update it without waiting for ARKit surface tracking.
There is no scan-first step and no scan instruction in this entry. If heading is
not available yet, the arrow remains amber with an explicit direction-alignment
status rather than silently claiming forward is the destination. Camera tracking
initializes automatically. Background obstacle evidence may change the arrow to
an observed side-check direction or a red stop block when a close obstacle has no
supported detour. Unknown observations retain an amber destination preview, which
is not a clearance claim. The diagnostic sector panel is hidden in this entry.
Within approximately 1.5 m the screen asks the user to check the room sign, rather
than claiming entrance/arrival. These are local bearing/obstacle cues, not a global
path around walls, rooms, desks or dead ends. No walkable graph has been inferred.
Camera interruptions do not reset the step-based position; obstacle evidence becomes
unknown until camera tracking recovers. Backgrounding or a motion-sensor interruption
pauses the shared position tracker and requires reconfirmation.
No LiDAR, new ML model, image upload or building survey is added.

## Evidence and limits

The detector transforms ARKit sparse visual feature points into portrait camera
coordinates, splits them into three angular sectors and samples several screen
rays against existing vertical-plane geometry. A near plane or near points in at
least two distinct image cells marks a possible obstruction. An isolated near
point or a plane within the uncertain range prevents a farther suggestion. A
farther estimate needs at least six distinct cells spanning multiple columns and
rows; repeated points and a single distant plane cannot establish that estimate.
Points on a tracked, classified floor are excluded only within that floor's known
extent. Low regions are sampled, but unseen floor/low obstacles remain unknown.

Checks run at most five times per second. Poor tracking, excessive tilt, stale or
repeated frames reset the cue gate. A watchdog hides stale arrows if frames stop.
Backgrounding, dismissal and mode switches reset the AR session, location/compass
updates, cue history and timer. Detection runs locally; no raw camera images are
sent to the backend.

This is an observed-geometry hackathon preview, not dense monocular depth or
collision-free route planning. Distant features can sit behind an unobserved
object. Glass, blank walls, thin/low objects, fast-moving people, darkness and
occlusion can defeat camera geometry. No full walking corridor, body clearance,
stair detection, arrival or map localization is established. Test slowly in a
controlled area with visible textured boxes/walls and independent observation.

References: [ARKit visual feature points](https://developer.apple.com/documentation/arkit/arframe/rawfeaturepoints),
[world-tracking plane detection](https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration),
and [LiDAR scene depth](https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth).

## Verification

Native tests check that the configuration requests neither depth nor mesh, spatial
coverage/deduplication, near-over-far precedence, plane-only uncertainty, noisy/
repeated/stale frames and immediate suppression of a forward cue. The full iOS
suite also covers the retained OCR, alignment and bilingual pin behavior. Simulator
checks cannot validate physical camera geometry; real obstacle/lighting/tilt and
foreground/background checks remain necessary on the phone.
