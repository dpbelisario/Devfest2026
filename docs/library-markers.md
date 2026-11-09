# Library 2F location markers (QR relocalisation)

Status: prototype, image-inferred positions, untested on device at time of writing.

## Problem

There's no surveyed indoor position source for 01 Central Library. No IndoorAtlas survey
exists for the library, and compass, GPS and step counting drift indoors. Both iOS AR flows
used either an assumed start or a manually confirmed start.

## Approach

Printed QR **location markers** act as absolute fixes, and ARKit visual-inertial odometry
tracks movement between them. This is low cost: paper, tape and the floor image we already have.

- Payload: `CONTOUR-LOC|1|<floor>|<x>|<y>|<facing>|<label>`.
  - `x`/`y` are normalised on the exact 1178×817 saved 2F plan, the same frame as
    `LibraryWaypointGuidance`.
  - `facing` is degrees clockwise from map-up that a person faces when looking straight at the sheet.
- Detection: Vision `VNDetectBarcodesRequest` on the ARKit camera frame, about 3 times per second.
  A marker is accepted only when it is near the centre of the view and large, so the person is
  close and facing it.
- **Direct exit AR** (`ObstacleScanViewController`, 01 Central Library → 3D AR · Library exit):
  - The marker calls shared `LibraryWaypointGuidance.locate(...)`, which registers the true plan
    position and selects the next exit-path node.
  - The AR→map rotation is set from the marker's facing. This replaces the indoor compass and the
    assumed start.
  - The UI shows `Located · <label> · QR` and plays a success haptic.
  - Every marker you pass re-corrects drift.
  - Markers more than 2 m from the supported exit path are rejected.
- **Floor Maps destination AR** (`IndoorDestinationScanViewController`):
  - The marker calls `IndoorStepTracker.relocate(...)`, which restarts dead reckoning at the
    marker's latitude/longitude and facing.
  - The session, stride and wall map stay the same, so the map dot jumps to the marker position.

## Use

1. Run `pip install qrcode && python3 scripts/library-markers.py`, then open
   `docs/library-markers/index.html`.
2. Print one card per page, at least 15 cm wide, or show it full-screen on a spare device.
3. Tape each card where its instructions say. The standing spot is the fix, so stand 1–2 m
   from the sheet.
4. Open 01 Central Library → 3D AR · Library exit, point the camera straight at a marker and
   follow the arrow.

## Limits

- Marker positions and the 2F route are read off an unsurveyed, manually aligned image.
- Between markers, accuracy depends on ARKit tracking. Re-scan a marker if the arrow looks wrong.
- Android does not scan markers yet. Shared `locate(...)` is ready for `ObstacleScanActivity`.
- IndoorAtlas or another radio survey would remove the need for markers. It needs an on-site
  MapCreator survey, and none exists.
- This is not verified evacuation guidance.
