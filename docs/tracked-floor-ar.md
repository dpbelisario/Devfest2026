# Tracked floor-route AR on iPhone

The app keeps two independent AR entry points:

- **Central Library → Details → AR** opens main's hard-coded hackathon exit demo
  (`ObstacleScanViewController`, `exitDemo = true`). It does not require Floor Maps
  setup and retains the fixed exit/gate/arrival behavior from main.
- **Central Library → Details → Floor Maps → AR** opens the algorithm prototype
  (`IndoorDestinationScanViewController`). Choose your actual starting point and a
  saved destination, start tracking, then tap **AR**. Choose an exit pin when you
  want to leave the building; OCR captions do not establish a verified exit.

The route drawer keeps the tracking control visible: **Start tracking**,
**Starting…** while sensors initialize, **Tracking ✓** when active, or
**Resume tracking** after an interruption. Selecting a different From location
exposes **Start tracking** again; tap it only when you are at that location.
While AR is disabled, its explanation appears below the route actions.

The native bridge receives destination/start UUIDs, the saved routing revision and
the tracking-session ID. It reloads the native saved overlay, rejects outdated
requests, and resolves the actual destination from that data. Coordinates sent by
the page are not used to define the path. A transient copy of the planning origin
is placed at the current step-tracked pose, then the shortest reviewed-wall-clear
route is calculated. Saved pins and walking approach points are not edited.

The camera view follows consecutive turns of that route using the same personal
step length, cumulative steps and gyro heading as Floor Maps. Neither GPS nor AR
camera displacement moves this indoor position. AR displays approximate route
direction only. It does not request plane detection or depth, evaluate camera
obstacle evidence, stop for nearby objects, or suggest detours. Users watch the
actual surroundings while following the direction.

Waypoint progression is automatic and local to consecutive route segments. A pose
more than 3 m from the current segment stops the arrow and asks the user to check
Floor Maps. Interrupted/stale tracking and mapped-wall conflicts also stop guidance.
Near the selected destination, the app displays a nearby message; it does not
close automatically or claim verified arrival. Route geometry, initial position,
heading and step length still require venue validation.

The tracked Floor Maps flow does not use the fixed 2F door coordinate, assumed
library-centre fallback, gate-direction latch or 15 m AR-displacement exit rule.
Those remain exclusively in the separate hackathon demo. Android is unchanged.

Verification covers route bends/turns, live-pose planning, saved destination
resolution, obsolete revisions, off-route rejection and the setup/ready entry
flows. Actual walking accuracy needs device testing.

Step counts are gated by iOS walking/running activity at medium or high confidence.
Stationary, vehicle, cycling and unknown intervals do not move the dot; their raw
counts are consumed so they cannot be replayed after walking starts. Activity
classification and step batches are delayed; an extra two-second buffer lets the
classifier catch up. Initial/uncertain steps can be missed. Activity classification
is still an estimate and needs a seated-then-walking test on the physical phone.
