# Static landmark directions on iPhone

Floor Maps can produce one numbered instruction list through known landmarks:
choose a starting point and a saved destination. The route is generated automatically;
**Recalculate route** retries the current selection. **Set my position here** is optional for this flow. Camera, motion
access, AR, live movement and progress confirmations are not required. The blue
route line and list stay fixed while GPS/step readings change.

## Set up a floor once

Open **Map options → Edit floor overlay / Detect labels**, then use **Detect walls**
in the native editor. Review the walls and door
openings, and save them once. Without reviewed wall barriers, planning shows a
setup message instead of an unchecked route.

Manual walking connections are optional. By default, the planner joins every pair
of known pins whose straight segment clears the reviewed walls. If a pin sits on
a caption/bookshelf or a passage needs bends, use **Map options → Edit walking
connections**. The same editor is available under **Walking connections** in Floor overlay.

1. Select **Move point**, choose a landmark and tap the aisle or doorway beside it.
   These walking approach points are separate from OCR caption/pin positions.
2. Select **Draw connection**, choose From and To, tap any bends needed around
   shelves or along corridors, then **Add connection**. Connections work in both
   directions. Adding an existing pair replaces its earlier path.
3. **Suggest nearby links** adds drafts to the existing network. It proposes the
   nearest two neighbours within 18 metres when the segment does not cross a
   reviewed wall. This does not establish actual access; remove any suggestion
   across furniture, a closed room or an inaccessible passage. Add missing bends
   and connections manually. If suggestions are unsuitable, Undo restores the
   earlier network.
4. Zoom/scroll the image to check the paths. Swipe a connection row to delete it.
   Red connections cross reviewed walls and prevent saving until corrected. Correct
   the walking points/path or review the wall/door geometry as appropriate.
5. Check **I checked these walking points and connections**, then Save. If editing
   an unsaved alignment, also press **Save alignment**. Cancel preserves the saved
   version. Back in Floor Maps, choose start/destination; the route appears automatically.

Saved, reviewed approach points override caption positions, and reviewed bent
connections add detour candidates. Removing a saved link does not prohibit an
automatic straight connection if the wall geometry allows it. Barriers must be
represented in the map to prohibit crossing them. Draft connections are ignored.
A disconnected pin graph shows no path instead of crossing a wall. Printed floor
labels such as 2F are excluded as intermediate passage landmarks.

## Implementation

The optional `walkingNetwork` field belongs to the saved overlay. It contains
image-relative approach points keyed by destination UUID, bidirectional connections
and optional bend coordinates. Limits: 120 points, 600 unique connections, 24 bends
per connection. Saving pins removes references to deleted/merged IDs and requires
reviewing affected connections again. Replacing the image starts without a network;
alignment changes transform its points with the image.

The native `FloorLandmarkPlanner` constructs a visibility graph from the pins and
reviewed wall barriers, then adds eligible reviewed bent passages. It checks the
entire segment of every connection against the walls, allowing reviewed door
openings. Dijkstra compares `(number of connections, total metres)` lexicographically:
fewer intermediate pins take priority, then shorter length breaks ties. Thus a
longer route can win if it uses fewer intermediate landmarks. A direct wall-clear
connection wins over a route through unnecessary pins. Reverse traversal reverses the bend sequence. Instructions
refer to the intermediate landmarks, approximate connection distances and turns
relative to the incoming passage, not the current phone heading. The initial
instruction names the first landmark to head toward. Start equals destination is a
separate no-walking state.

The native bridge reads the saved map on its storage actor. A SHA-256 routing
revision covers image, alignment, floor, pins, wall geometry and connections. It
rejects planning against an outdated revision. The page ignores stale responses
after a selection/floor/map change and clears the previous list and blue line.
Names/instructions are inserted as text, never HTML. Requests time out with retry
feedback. No route endpoint, server deployment or new credentials are needed.

## Limits and checks

This is a static route preview derived from the map, not automatic indoor
localization, turn timing, accessible-route certification, dynamic obstacle rerouting,
multi-floor/stairs routing or verified evacuation guidance. The user must interpret
landmarks and follow the marked passage; furniture and real conditions may differ
from the plan. Wall detection alone cannot establish walkability.

Native checks cover automatic visibility connections, pin-count priority and distance
tie-breaking, intermediate landmark order, reverse turns, scale, door openings,
blocked shortcuts, disconnected graphs, unreviewed walls, same-place, invalid IDs,
persistence, pruning, revision changes and draft
suggestions. Browser checks cover automatic generation after selection without confirmation/motion, stable
lists on GPS updates, text escaping, blue route rendering, setup/no-path/same-place
states, and stale response invalidation. Physical venue review remains necessary.
