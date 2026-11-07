# Indoor navigation (demo)

Indoor navigation guides you through a **fictional** two-floor building ("Sample Hall"). No real
Nagoya University floor plans are in the app yet; every building uses this sample plan, and the
screen says so.

## Where it opens

| Mode | Entry point | Flow |
| --- | --- | --- |
| Student | Building **Details** → **Indoor navigation · find a classroom** | Indoor view for that building; pick a room |
| Student | During **3D AR** to a building, within **10 m** (GPS) | "You're near {building}. Find your classroom with indoor navigation?" Yes → indoor view. Asked once per building. Without GPS (demo position) the AR card shows **Demo: I'm near the building** instead |
| Evacuation | Starting **3D AR** to a site (card, Details, picker, alert screen) | "Are you inside a building right now?" Yes → indoor view to the nearest exit (elevators avoided), then 3D AR to the site starts by itself once you are out. No → 3D AR straight away |

GPS is often off by 5–10 m near buildings, so the 10 m prompt may come a little early or late.

Buildings that have a real floor plan in the indoor catalog (Engineering Building II, ILAS Building A; see
[indoor-pilot.md](indoor-pilot.md)) do not use the sample plan: their Details button and 10 m prompt open
**Ask** with that building's indoor directions (Engineering Building II starts the Room 221 demo).

## What it does

1. Pick a start point, a destination (Evacuation: nearest exit, elevators avoided) and where movement
   comes from: **Simulated walk** or **Phone sensors**.
2. The screen shows the next step ("Turn left in 6 m", "Take Stairs B down to 1F", "Room 201 on your
   left"), a 3D first-person view of the corridors with the route on the floor, a mini map, the
   remaining distance and how accurate the position is (±m).
3. Tap the mini map (or **Map**) for the full plan with the estimate, its uncertainty and, in the
   simulation, the true position (hollow circle). **I'm here** + a tap on the plan resets the
   position; the floor button (top right) sets the floor by hand.

All texts are in English, 日本語, 中文 and 한국어. Everything except the 3D library runs offline.

## How the position is estimated

No beacons or other hardware. The phone only measures movement, so the position is always an
estimate; the floor plan keeps it in check.

| Input | Source |
| --- | --- |
| Steps | Accelerometer peaks (`devicemotion` in the page), 0.70 m per step |
| Direction | Compass (`deviceorientationabsolute`); without a compass the start faces the first route direction |
| Floor | Barometer (Android `TYPE_PRESSURE`, sent by the app about 4×/s): about 0.12 hPa per metre, 4 m per floor. Steps while the height changes = stairs, none = elevator |

- **Particle filter**: 300 guesses (position, floor, step-length scale, compass bias). Each step moves
  every guess with a little noise; a guess that would walk through a wall is dropped; the rest give
  the estimate (weighted mean) and its spread (shown as ±m). If every guess hits a wall, it restarts
  around the last estimate.
- **Floor change**: guesses move to the matching stairs or elevator on the new floor. While the height
  changes inside a stairwell, steps are counted but do not move the position.
- **Route**: shortest path on a walking graph (corridor centre line, doors, rooms, stairs, elevator),
  recalculated after every step. Instructions come from the turns on that path.

## Simulation and self-test

**Simulated walk** moves a "true" walker along the route. The engine only gets what a phone would
report: noisy step headings with a compass drift of up to ±12°, a real step of ~0.72 m against the
assumed 0.70 m, and air pressure with noise. `ContourIndoor._runSim({ seed, from, to, student })` runs
it without timers and returns the error between the true and estimated position.

Results for 7 routes × 12 seeds (headless Chrome, 2026-11-07):

| Route | Mean error | Worst | Right floor at the end | Arrived |
| --- | --- | --- | --- | --- |
| Room 101 → exit (1 floor) | 0.4 m | 1.1 m | 12/12 | 12/12 |
| Room 203 (2F) → nearest exit | 0.8 m | 3.4 m | 12/12 | 12/12 |
| Room 204 (2F) → nearest exit | 0.8 m | 3.3 m | 12/12 | 12/12 |
| Room 205 (2F) → nearest exit | 0.8 m | 3.3 m | 12/12 | 12/12 |
| Main entrance → Room 205 (2F) | 1.1 m | 3.1 m | 12/12 | 12/12 |
| East exit → Room 201 (2F) | 1.1 m | 3.3 m | 12/12 | 12/12 |
| Office → Study room (2F) | 0.9 m | 5.9 m | 12/12 | 10/12 |

This is a simulation with the error model above, not a field test. Real phones held in a pocket or
while running, and magnetic disturbance from steel, will do worse.

## Code

- Page: the "Indoor navigation" block at the end of `android/app/src/main/assets/contour.html`
  (`window.ContourIndoor`: `open(mode, { building, after })`, `close()`, `back()`, `relang()`; `after.run()`
  starts once the exit is reached). The entry points are `goAR()`, `checkNear()` and the `#indoorBtn`
  handler in the main script. The 3D view uses three.js
  r128 from cdnjs, loaded when first needed; without the internet the map view is shown instead.
- App: `android/app/src/main/java/com/contour/app/indoor/IndoorSensors.kt` (barometer) and the bridge
  calls `ContourBridge.startIndoor()` / `stopIndoor()` in `WebUiActivity.kt`. The page receives
  `window.contourIndoor({ p: hPa })`. Readings stop while the app is in the background.

## Using a real building later

1. Get the floor plans and permission from the building's owner.
2. Trace walls, doors, rooms, stairs, elevators and exits into the same structure as `ROOMS` /
   `buildWalls()` (metres) and set `PLAN_NORTH` (the compass bearing of the plan's +y axis).
3. Walk the building and compare the estimate with known points before showing routes as guidance.
4. Optional improvements: snap to corners and stairs (landmarks), magnetic or Wi-Fi fingerprints,
   bundle three.js for fully offline use.

## Check on a phone

1. Install the APK, Student mode → a building's Details → Indoor navigation → Phone sensors → Start.
2. Hold the phone flat and walk; the step counter should go up about once per step, and the arrow on
   the mini map should turn with you.
3. On a phone with a barometer, go up one floor by stairs: the floor button should change after about
   2–3 m of height. On the emulator: Extended controls → Virtual sensors → Barometer.
