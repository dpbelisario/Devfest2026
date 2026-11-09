# Automatic wall detection on iPhone

The native floor-overlay editor can detect likely wall lines from a PNG without
uploading the image or downloading a machine-learning model. This version uses
image processing, not CubiCasa or a trained architectural segmentation model.

## Try it

1. Open Central Library → Details → Floor Maps → **Map options → Edit floor overlay / Detect labels**.
2. In the native editor choose **Detect walls**. Existing saved walls are kept until
   a replacement draft is reviewed and saved. **Review walls** opens existing
   geometry without re-running detection.
3. Inspect the red lines over the original plan. Zoom up to 4× and scroll in either
   direction. Remove false detections by tapping them. **Add wall** uses two taps
   for the endpoints, including diagonal walls the detector may have missed.
4. Mark a door with **Opening**, tapping both ends along the wall across the actual
   doorway. Green lines remove the matching portion of a nearby parallel wall;
   they do not punch arbitrary perpendicular holes. Existing visible gaps are
   preserved by detection and need no extra opening if no wall was inferred there.
5. Use **Undo** for mistakes. **Detect again** replaces the current review draft;
   Undo restores the previous version. Auto ink prefers green architectural lines
   when enough thin green runs exist, otherwise dark lines. Select **Green walls**
   or **Dark walls**, then Detect again, to override this choice.
6. Check **I checked walls and door openings**, then **Save walls**. When editing
   an unsaved alignment, also press **Save alignment**. Cancel keeps the earlier
   saved geometry. Clear and save an empty wall set to disable constraints.
7. Back in Floor Maps, open **Map options → Show saved walls (red) and openings (green)** to preview the
   geometry on the same map. Confirm your start again to begin a session using the
   new geometry. Both Floor Maps and its AR action use the constrained position.

## How it works

Detection runs on the storage actor, away from the UI thread. Images are normalized
and downsampled to at most 1400 pixels on the longest side. The detector identifies
long, thin horizontal/vertical dark or green pixel runs, filters thick filled
regions, and collapses parallel pixel rows into centerlines. It does not merge
across gaps, infer door symbols or decide which side of a wall is walkable.

Walls/openings use normalized coordinates in the original image and are saved in
the optional `wallGeometry` field of the overlay. Existing saves without this field
remain compatible. Geometry follows image movement, rotation and scale. Importing
a different image starts without the previous geometry. At most 1000 wall segments
and 200 openings are supported. Draft detection never enables constraints by itself.

At position confirmation, reviewed geometry and alignment are passed to the native
step tracker. The tracker caches metric wall segments, subtracting reviewed
collinear door intervals. Each proposed step is checked over its entire length.
If it intersects a barrier, displacement is rejected while the step count is still
consumed. It does not snap to an arbitrary room, silently change heading, or apply
the rejected step later. A subsequent step away from the wall can proceed.

The map reports when movement is held at a wall. AR stops its directional arrow
until movement resolves the conflict or the user closes AR and corrects the start,
heading, stride or geometry. This is a geometric rejection constraint, **not a
particle-filter localization algorithm**. The AR goal remains a direct bearing;
the AR arrow does not use a wall-aware walking route. Separately, the static
[landmark directions](landmark-directions.md) feature automatically connects visible pin pairs and optional reviewed bent passages,
excluding any connection crossing these walls.

## Limits and verification

Text boxes, shelf edges and furniture can look like walls. Faded, curved, diagonal
or broken lines can be missed. Automatic ink selection may be wrong on unfamiliar
styles. Review the whole plan and every door before enabling constraints; the PNG
may also be outdated. No model confidence, surveyed accuracy, body clearance,
floor detection, along-corridor drift correction or reliable evacuation guidance
is claimed. A wrong map/alignment can reject a real step; missing geometry can
still allow an impossible movement.

Native tests cover coloured wall detection, doorway gaps, thick furniture rejection,
the bundled library image, persistence, rotated alignment, invalid geometry,
opening subtraction and step rejection/recovery. Browser checks cover review gating,
geometry transfer, wall/opening previews, blocked feedback and session invalidation
when geometry changes. Real Google Maps rendering, phone gestures and walking
accuracy still require device/venue testing.
