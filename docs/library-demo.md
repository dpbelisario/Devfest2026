# Central Library exit and stairs preview

Central Library is building **01**. Its ordinary **3D AR directions** card button
opens the native exit-arrow view directly, without a floor picker or checkpoint.
AR buttons align at the bottom of every card even when names wrap.

The native 2F iteration follows image-inferred aisle waypoints to the pictured
**Entrance Hall doors**, instead of pointing straight at the exit through
fixtures. Its top **Start guess · Edit** control defaults to the north-east aisle
and can be changed to the south-east aisle, Service Desk public side or Entrance
Hall. These are assumed starts, not camera/GPS localization. The final door stays
at the existing digitized point on the exact saved image. The older catalog's
schematic percentages are not used as native physical aisle positions.

A usable compass can register the map heading. Otherwise the opening camera is
assumed to face the first segment; **Next guess · Edit** corrects the whole path's
rotation. GPS accuracy rejection no longer prevents the assumed-start demo from
initializing. AR displacement estimates progress without per-checkpoint buttons.
Advancement requires estimated target distance ≤1.5m and lateral distance to the
incoming segment ≤0.75m; a sideways obstacle detour does not advance a nearby
waypoint. Image scale, starts, gate openings and passages remain unsurveyed.
**Check exit doors** at the path endpoint does not establish arrival.

Movement labels remain **Move straight**, **Move left**, **Move right**,
**Turn around**, **Stop**, and **Hold**, with the existing sensor/obstacle guards.
Unknown or stale geometry shows **Hold** with no walking arrow. The floor control
still starts at the hardcoded **2F guess**. Other selected floors pause this native
iteration with **2F demo only**; no native stairs guidance is added. See
[library-waypoint-demo.md](library-waypoint-demo.md) for exact pixel coordinates
and assumptions. The separate map flow below still supplies stairs previews.

The surrounding main map has no automatic floor-plan overlay. On iOS,
**Central Library → Details → Floor overlay**, or double-tapping its **Details**
button, opens the separate saved-plan editor. The native bottom bar is removed.
The saved alignment remains local and is used by AR; editing an image does not
make GPS accurate or establish a camera pose. See [native-floor-overlay.md](native-floor-overlay.md).

Previous localization and map tools remain separate: **Details → Library floor
maps** opens official maps, manually confirmed exit/stairs paths, photo landmark
suggestions and the 3D image/graph preview. No valid registered library pose is
available to automatically replace the demo assumption. Room221 IndoorAtlas
work and the Cloud Anchor design are not silently used as library localization.
The 3D preview reconstructs no walls/shelves and is not camera-registered.
See [obstacle-avoidance-ar.md](obstacle-avoidance-ar.md).

## Optional map and localization flow

1. Select your current floor: B1, 1F, 2F, 3F or 4F.
2. Optionally tap **Identify a landmark · take photo**. The photo is sent to
   Google Gemini using the existing Vertex AI service, with no image saved by
   Contour. Readable named signs may suggest a checkpoint and floor; indistinct
   shelves/stairs should return unknown. Suggestions never start a route.
   Choose a named checkpoint, or tap its blue dot on the map. Move to that exact
   point and confirm **I am at this checkpoint**. A seat elsewhere is not a known
   position, and GPS cannot establish a floor or aisle.
3. Select **Exit · 2F entrance** or **Nearest stairs · this floor**. Exit previews
   use stairs between floors, never lifts. Stairs previews stop at a stairwell on
   the current floor. “Nearest” means lowest schematic graph cost, not surveyed
   walking distance. Neither destination establishes that doors/stairs are open.
4. Follow the dashed map route and named checkpoint instructions. To enable a
   phone-relative arrow, face the next checkpoint with the phone held flat, grant
   motion access, and tap the calibration button again after a reading arrives.
5. Confirm **I reached the next checkpoint** only when you reach it. For a floor
   change, this means reaching the indicated stair landing on the new floor.
   The displayed floor changes only after that confirmation. Calibrate again for
   the next walking segment. No steps or automatic floor guesses move you.
6. If unsure or a path is blocked, reset your position. Do not follow an inferred
   path through a closed door. A heading older than two seconds hides the arrow;
   a checkpoint confirmation older than one minute requires reconfirmation.
   Backgrounding the app clears heading calibration.

The official images, inferred graph and precomputed exit/stairs routes are
embedded together in the shared HTML. They work offline in both shells; camera
landmark suggestions need a network connection. The map and checkpoint dropdown
remain usable when motion access is denied. The arrow reflects compass rotation
from a manual alignment; it is not a camera-registered AR arrow or live position.
English, Japanese, Chinese and Korean guidance shares the same routing flow;
checkpoint names match the English labels on the published maps.

## What is documented and what is inferred

**Documented:** the university publishes five floor maps; the 2F map labels the
Entrance Hall and service/learning areas. The maps show staircase symbols.
**Inferred:** checkpoint pixel coordinates, aisle links, corresponding stair
connections between floors and the path to the pictured 2F entrance doors.
All graph edges have `surveyed: false`. Pixel-based costs are relative units,
never metres, ETAs or measured accuracy. This is a route preview pending on-site
validation, not reliable emergency evacuation guidance. In an emergency follow
posted signs and staff directions. Confirm permitted public access and door
operation before using any path.

Source: [Nagoya University Central Library floor maps](https://www.nul.nagoya-u.ac.jp/central/floormap_e.html),
retrieved November 8, 2026. Original images:
[B1](https://www.nul.nagoya-u.ac.jp/central/images/b1.jpg),
[1F](https://www.nul.nagoya-u.ac.jp/central/images/1f.jpg),
[2F](https://www.nul.nagoya-u.ac.jp/central/images/2f.jpg),
[3F](https://www.nul.nagoya-u.ac.jp/central/images/3f.jpg),
[4F](https://www.nul.nagoya-u.ac.jp/central/images/4f.jpg).
The images are schematics without surveyed scale or magnetic north. Opening
hours remain unknown.

## Repeatable implementation and survey

Edit `backend/data/indoor.json` for checkpoint/edge corrections. Floor -1 means
B1; floor 0 is invalid. `npm run build` validates the catalog and regenerates
`indoorCatalog` and `libraryRoutes` inside `contour.html`, using the existing
Dijkstra service for both API and offline paths. Commit the regenerated HTML.
Keep all unsurveyed edges false until individually walked and documented.
Future room routes can add confirmed door nodes to this same graph; none are
provided for the library yet. Existing Engineering II/Room 221 work is separate.

For each floor, walk every inferred aisle segment and both stairwell transitions.
Record checkpoint photos, exact door/access conditions, route deviations and
measured distances. Test the exit from each checkpoint on iOS and Android,
including denied sensors, offline mode, background/resume, magnetic disturbance,
blocked paths and a wrong floor. Record results in the coordination issue before
claiming reliability. See [library-localization.md](library-localization.md) for
camera localization research and [library-deployment.md](library-deployment.md)
for the reproducible deployment flow.

Arrow rendering uses the same five camera-relative chevrons on iOS and Android.
The preview is visible while tracking/GPS/nearby surface observations initialize;
it stays amber with Hold and does not claim walking clearance. Supported movement
cues turn it white. A detected close obstruction with no supported detour suppresses
it. iOS draws in screen coordinates so camera tilt or floor-plane projection cannot
place all chevrons off screen. Heading/start remain explicitly editable assumptions.
