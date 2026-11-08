# Continuous 2F waypoint demo

The native camera demo targets the next aisle waypoint rather than aiming a
vector through all fixtures toward the final exit. It reuses the existing library
NE → SE → Entrance Hall → exit topology, but replaces its schematic percentages
with image-inferred pixels on the exact saved 1178×817 image. The default start is
**guessed**, not localized. The ordinary camera screen adds **Start guess · Edit**;
choose north-east aisle, south-east aisle, Service Desk public side or Entrance
Hall without per-waypoint confirmation buttons.

The prior catalog's direct NE(65%,41%) → SE(65%,62%) segment crosses the region
marked OPAC/Newly Arrived Books. Its labels do not establish fixture boundaries
or clearance. This iteration instead sketches the passage beside the east
stair/lift enclosure and the upper gate indicated by the rightward plan arrow.
Even that passage and its widths must be checked on site. The saved image and
catalog depict the same floor with different padding; percentages cannot be
transferred blindly between them.

Coordinates below refer exclusively to the saved image. The shared
`LibraryWaypointGuidance` uses the same rotation/aspect/width projection as
`LibraryExitGeometry`; the last point is the existing digitized Entrance Hall
door, not Peer Support.

```text
                           east stair/lift enclosure
  guessed NE (780,315)      +-------------------+
           |               |                   |
           |               |                   |
           v               +-------------------+
  SE (780,480) ------> gate (850,495)
                                   \
                                    Hall (945,520) ---> door (1034,528)
```

| Point                         | Exact saved-image pixel | Status                              |
| ----------------------------- | ----------------------- | ----------------------------------- |
| North-east aisle near OPAC    | 780,315                 | Assumed default start               |
| South-east aisle before gates | 780,480                 | Image-inferred passage point        |
| Upper gate                    | 850,495                 | Image-inferred gate point           |
| Entrance Hall                 | 945,520                 | Image-inferred interior point       |
| Exit door                     | 1034,528                | Existing digitized door centre      |
| Service Desk public side      | 760,565                 | Optional assumed start via SE point |

At startup a usable compass can register map orientation. Otherwise the initial
camera is assumed to face the first segment. **Next guess · Edit** changes the
rotation of the whole remaining path around the current estimated camera point;
it no longer overrides only the final exit vector. AR displacement estimates
progress. A waypoint advances only at estimated distance ≤1.5m and lateral distance
from its incoming segment ≤0.75m, without checkpoint buttons. A nearby obstacle
detour outside that segment does not advance it. The image's ground width and all starts remain assumptions. End-of-path
shows **Check exit doors**, never an arrival or safe-exit claim.

Existing sensor/tracking gates and obstacle decisions remain active. An unknown
sector shows **Hold** with a visible amber preview rather than a walking-clearance arrow. The follower does not infer an
obstacle-free passage, create a maze solver or identify blocked graph edges.
Changing a start or restarting tracking resets relative progress. Changing floor
also resets it; any floor other than 2F shows **2F demo only** and pauses this
iteration. The prior separate map preview retains its exit/stairs routes.

No automatic floor detection, stair selection, surveyed camera localization or
room routing is added. Tests simulate motion, heading corrections, start resets,
unknown input and the exact existing final door projection; they do not verify
these image-inferred passages in the library.
