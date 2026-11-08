# Central Library camera localization

Checked 8 November 2026. The implemented photo service suggests library
checkpoints for the user to confirm. **Automatic indoor camera positioning is
not implemented or calibrated.** Floor-plan images alone cannot supply an
absolute camera position. The proposed automatic implementation is Google
Cloud Anchors with native ARKit on iPhone and ARCore on Android, tied to a
surveyed library map.

## What Google supplies

| Technology                   | Documented capability                                                                                                                      | Decision for this library                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Maps Indoor Live View | Google's product uses visual localization; its indoor rollout adds understanding of altitude and objects inside selected buildings.        | This does not establish Central Library coverage or provide an API for uploading its drawings and immediately locating visitors.                                    |
| Maps SDK indoor levels       | Exposes a building's available display levels and floor selection.                                                                         | Display data is not a camera-to-floor-plan localization service.                                                                                                    |
| ARCore Geospatial / VPS      | Combines sensors, GPS and a Street View-derived visual map to estimate geographic pose.                                                    | Useful outside near supported campus entrances. An outdoor VPS availability result does not establish indoor or floor coverage.                                     |
| ARCore Cloud Anchors         | A developer scans an area, hosts its visual feature map and shares an anchor ID. Another device resolves its pose relative to that anchor. | The useful Google component for a library we map ourselves. Requires known anchor IDs, on-site capture, map registration and internet for hosting/resolving.        |
| ML Kit text recognition      | On-device Latin/Japanese and other supported-script OCR on Android/iOS.                                                                    | A useful later offline sign reader. OCR identifies text; a unique registered sign is still needed to identify a place.                                              |
| Gemini image understanding   | Accepts images and returns model-generated interpretations.                                                                                | Already fits the backend. Use it for candidate landmarks and readable sign text, with confirmation. Do not use its generated coordinates as a tracking measurement. |

Sources: [Google's Indoor Live View explanation](https://blog.google/products-and-platforms/products/maps/redefining-what-map-can-be-new-information-and-ai/),
[Maps indoor display API](https://developers.google.com/maps/documentation/ios-sdk/reference/objc/Classes/GMSIndoorDisplay),
[Geospatial overview](https://developers.google.com/ar/develop/geospatial),
[Cloud Anchors overview](https://developers.google.com/ar/develop/cloud-anchors),
[ML Kit text recognition](https://developers.google.com/ml-kit/vision/text-recognition/v2),
[Gemini image input](https://ai.google.dev/gemini-api/docs/image-understanding).

The iPhone XS Max is explicitly in Google's supported-device list. Cloud Anchors
uses ARKit-compatible hardware on iOS 12 or later; LiDAR is not required. The
confirmed XS Max with iOS 18.1 therefore meets the documented device requirement,
but library accuracy still needs physical testing. Check Android support and AR
service availability at runtime. RoomPlan/LiDAR cannot be the baseline on this
phone. [Supported devices](https://developers.google.com/ar/devices/),
[iOS Cloud Anchors integration](https://developers.google.com/ar/develop/ios/cloud-anchors/developer-guide).

## Implemented photo suggestions

`POST /api/indoor/localize-photo` uses `LibraryLocalizationService` and the existing
`GenerateTurn`/Vertex AI credentials. The router must be mounted before the app's
16 KiB JSON parser; it has its own bounded 750 KiB parser. No new SDK, account,
storage service or model is required.

Request fields are `mimeType`, raw `imageBase64`, and optional `floor` from
`-1, 1, 2, 3, 4`. Accepted containers are JPEG, PNG and WebP, up to 512 KiB decoded.
The server checks canonical base64, declared container signatures and size; the
model provider decodes the actual image. The UI should resize a current camera
frame before sending it and must not send a whole stream. Only an explicit photo
identification action should cause a model request. Images are not written to
local files or included in application error logs by this service.

The service sends labels from the existing `nu-library` catalog, not invented
coordinates or the large embedded floor-map assets. It asks for visible sign text
and up to three checkpoint IDs. Invalid output becomes `unknown`; IDs outside the
library or an explicitly supplied floor are discarded. Returned labels and floor
numbers come from the catalog. It never returns x/y, geographic coordinates,
heading, a numeric confidence score or route instructions.

```json
{
  "status": "candidates",
  "buildingId": "nu-library",
  "requiresConfirmation": true,
  "candidates": [
    {
      "checkpointId": "lib-2-service",
      "label": "Service Desk · public side",
      "floor": 2,
      "observedText": "Service Desk"
    }
  ]
}
```

This example describes the response contract, not a measured recognition result.
Render model text using text content, not HTML. A user must confirm that they are
**standing at** the chosen checkpoint; merely seeing its sign across the room
does not establish their position. Generic staircases, bookshelves and EXIT signs
can occur on several floors. The model is instructed to return unknown for these,
for floor-map photos and for unreadable or ambiguous scenes. These instructions
are not a guarantee against model errors; confirmation remains mandatory.

The route reuses the existing `RateLimiter`. Its limits apply per running server
instance, not as a project-wide spending cap. Invalid bodies return 400, oversized
requests 413, exhausted limits 429, disabled assistant 503 and provider failures 502. Responses are not cached. Model usage is billed through the existing project
when a photo is analyzed; this is not a free camera positioning loop.

## Smallest automatic-positioning pilot

Start with one short, reviewed 2F route: entrance hall, service desk and one
identified stair landing. Expand only after the same physical points resolve
consistently on both phones. This section is an implementation design, not a
claim of field performance.

1. Verify permission to survey the venue and its current walking routes. Choose
   fixed, distinctive architectural areas; avoid movable books/displays and
   mirrors. Use the official plan as a drawing reference, and measure real
   distances. Existing catalog x/y values are drawing percentages, not metres.
2. Establish a local metric frame on 2F. Match at least three spread-out,
   non-collinear physical landmarks to their drawing points. Fit translation,
   rotation and scale, check the residual error at independent landmarks, and
   record the map revision. Check whether drawing distortion requires a more
   detailed mapping instead of assuming a uniform scale.
3. Run the official native Cloud Anchors sample or a minimal survey screen. Start
   camera tracking, choose a stable physical anchor origin, and scan its
   surroundings from multiple viewpoints under normal lighting. On Android,
   inspect `estimateFeatureMapQualityForHosting()` and prefer `GOOD`; this is
   hosting quality, not a position-error guarantee. Host only when tracking is
   stable and persist the successful cloud ID.
4. Register each anchor's full transform into the metric map frame. Survey its
   origin and direction, not just its floor. Two independently identified floor
   directions/points plus gravity can establish yaw and translation; additional
   check points expose misalignment. Record anchor height if the origin is not
   on the floor. One arbitrary tap on a drawing cannot determine yaw or scale.
5. Store `cloudAnchorId`, building ID, floor, map revision, metric
   `mapFromAnchor` transform, creation/expiry times and survey verification data
   together. Serve this small read-only catalog through the existing backend or
   bundled assets. Firestore can hold it if updates require persistence; a new
   Firebase Realtime Database is unnecessary just to share IDs.
6. Close and reopen the AR session, then resolve on a second physical device
   without reusing the first phone's session transform. Compare the displayed
   position and heading with marked ground-truth locations. Repeat facing the
   opposite way and approaching from each intended entrance. Only then enable
   automatic guidance within the verified area.

Official starting code:
[Android samples](https://github.com/google-ar/arcore-android-sdk/tree/master/samples),
[iOS CloudAnchorExample and PersistentCloudAnchorExample](https://github.com/google-ar/arcore-ios-sdk/tree/master/Examples),
[persistent-anchor codelab](https://codelabs.developers.google.com/codelabs/arcore-cloud-anchors).
The [Android guide](https://developers.google.com/ar/develop/java/cloud-anchors/developer-guide)
documents hosting quality, asynchronous host/resolve calls and cancellation.

### Native changes that are actually needed

On Android, reuse the app's native ARCore session/camera rendering and permission
handling. Enable `Config.CloudAnchorMode.ENABLED`, feed normal frame updates,
resolve the selected IDs asynchronously, and use the returned tracked anchor pose.
Keep this work separate from unmerged Android IndoorAtlas PR #24. On iOS, add
Google's [official ARCore package](https://github.com/google-ar/arcore-ios-sdk)
through the supported [SPM setup](https://developers.google.com/ar/develop/ios/enable-arcore),
create an `ARSession` and `GARSession`, and forward ARKit frames to GARSession.
Use the existing native shell's trusted bridge to open this dedicated AR screen.

The WebView camera and native AR session must not compete for the camera. Stop
the web video tracks before entering native AR and restore the web screen on
exit. Keep the native renderer responsible for world-anchored arrows; a CSS
compass arrow is not world tracking. No Unity or Cesium dependency is needed.

The iOS SDK explicitly does not support ARKit
`setWorldOrigin(relativeTransform:)`. Keep registration in application matrices
instead. The essential transform is:

```text
mapFromCamera = mapFromAnchor × inverse(sessionFromAnchor) × sessionFromCamera
sessionFromWaypoint = sessionFromAnchor × inverse(mapFromAnchor) × mapFromWaypoint
```

Here `AFromB` converts coordinates in B into coordinates in A. All transforms
must use consistent metre units, handedness, axis definitions and matrix layout.
For example, use local map X/Z for the floor and Y for height; the source image's
downward pixel axis needs an explicit conversion. Anchor floor identity comes
from the surveyed catalog. Do not derive a building floor from a model's guessed
height or GPS altitude. Source for iOS frame forwarding and the world-origin
limitation: [iOS developer guide](https://developers.google.com/ar/develop/ios/cloud-anchors/developer-guide).

### Camera-on lifecycle and correction

The visitor does not need to type an anchor ID. After the normal camera/data
processing permission flow, opening the native camera can load the library's
anchor catalog and start resolving automatically. Begin with the confirmed floor
and entrance area's anchors. If floor is unknown, use a small bounded group of
distinctive anchors across floors; cycle remaining groups after a deadline. A
photo candidate can prioritize this search but cannot establish the pose.

Show `Locating…` and a map/landmark prompt until an anchor resolves. A default
world direction would imply orientation we do not know. A route diagram can be
shown immediately, labelled as a plan. Render a live directional arrow only when
the anchor resolved successfully, the camera and anchor are tracking, the map
revision/registration is valid, and the route segment has been verified.

Check the transform for consistency over a short observation window and against
any other resolved anchor. Choose timing and movement tolerances from field
measurements; Google does not supply a universal Cloud Anchor horizontal-accuracy
number equivalent to Geospatial accuracy. Do not call hosting `GOOD` a runtime
accuracy measurement. Where two anchors disagree materially, stop precise
guidance and resolve again instead of averaging a possible wrong-floor match.

Continue with local visual/inertial tracking between anchors. Resolve another
surveyed anchor near a turn or floor transition to correct drift. Small validated
corrections can be smoothed visually. A large jump, tracking loss or floor conflict
must suppress the arrow and return to `Locating…`. Cancel pending work and release
anchors/sessions when the view closes or the app suspends. Restarting AR invalidates
its session coordinate frame; recompute registration after resolving again.

Internet is required to host and resolve Cloud Anchors. A resolved session may
continue local tracking during a network interruption, subject to normal drift
and tracking limits; this does not make offline cold-start localization available.
Retain manual checkpoints and offline floor maps. Repeated-looking stairwells
need distinct surveyed anchors and an explicit floor-transition check.

### Expiry, quota and cost

API-key-authenticated Cloud Anchors last at most 24 hours. Longer-lived anchors
require keyless authorization; the documented persistent-anchor maximum is 365
days. Implement the platform-specific authorization flow and keep signing/private
credentials server-side. Do not place a service-account key in either app. Store
expiry metadata, skip expired IDs, and plan renewal or a new survey if the physical
scene changes. The [management API](https://developers.google.com/ar/develop/cloud-anchors/management-api)
can inspect and extend expiry within its allowed maximum; it does not make a
changed scene accurate again.

The published limits include 30 host and 300 resolve requests per minute per IP
address and project; Android documents up to 40 concurrent Cloud Anchor
operations. The pilot should use substantially fewer concurrent resolves, cancel
unused requests, and back off after quota/service errors. The
[iOS quota documentation](https://developers.google.com/ar/develop/ios/cloud-anchors/developer-guide)
and [Android guide](https://developers.google.com/ar/develop/java/cloud-anchors/developer-guide)
were checked. They do not establish a blanket zero-cost guarantee for this whole
design. Existing Cloud Run, Firestore and Gemini usage still has its own pricing.
No new paid plan, quota increase or Cloud Anchor provisioning was performed in
this research. A Maps/3D Tiles subscription is not required for this proposed
local Cloud Anchor map.

## Floor plans, 3D models and the reference sites

An economical 3D viewer extrudes reviewed floor-plan wall polygons and adds known
floor heights. This can improve route presentation. It does not create the visual
feature map used to match a camera view. Geometry and camera localization are
separate inputs; a generated texture cannot substitute for observations of the
real library.

Public implementations worth examining are
[FloorplanToBlender3d](https://github.com/grebtsew/FloorplanToBlender3d) for drawing
conversion and [Plan2Scene](https://github.com/3dlg-hcvc/plan2scene) for floor plans
plus photos. For a custom visual-positioning pipeline,
[COLMAP](https://github.com/colmap/colmap) reconstructs photographed geometry and
[Hierarchical Localization](https://github.com/cvg/Hierarchical-Localization)
retrieves reference images, matches features and estimates pose against a map.
That would require an overlapping image survey, calibrated cameras, metric/map
registration and a maintained image database. It is much larger than a Cloud
Anchor pilot and is not implemented here.

Read-only inspection of [air-cargo-twin](https://air-cargo-twin.vercel.app/)
observed a Three.js canvas and an explicitly simulated operations mode. Its
public bundle defines walls, zones, assets, photo placements and a floor-plan
underlay. It tries `/demo.json` and falls back to a built-in 100 × 60 metre
terminal layout; the direct `/demo.json` request in this inspection returned
HTML, so it was not treated as live warehouse data.

The same bundle contains a useful AI editing pattern: it sends an existing
layout, a plan underlay and photos with manually supplied positions, heights,
headings and field-of-view values to `/api/suggest`; returned suggestions can be
reviewed/applied as layout edits. Unknown photo positions are explicitly
representable. This is static evidence of model-editing support, not an observed
successful API call or automatic camera-pose solver. The request was not invoked.

[Belli's warehouse page](https://www.belli.ai/software/operations/warehouse)
was a marketing page with warehouse shipment/zone features and a linked demo.
No original repository link was present in the inspected page/main app bundle,
and a public GitHub search for the exact `air-cargo-twin` repository name found
none. The original repositories, backend implementation and reuse licence remain
unknown. Publicly downloadable browser bundles are not equivalent to obtaining
the original source repository or permission to copy proprietary code.

REA evidence identifiers:

- Air demo navigation/canvas: `ev_84e85175fa98aa80471e672c7aa18138453ff48e10d8ffa915c1fc368145db59`.
- Belli warehouse page: `ev_8daa38dd9399bd4bca077df71eb3d2db173397b723894fbacdc578928202831b`.
- Captured script export: `ev_b8a8dee72e0573f0bc1f7d805a384f5b6acb97717d1a2f4324b424e9cbc49760`.
- Selected decoration module static analysis: `ev_a18a1c947b8348c1c9be456e69c67b1b105d3115fa68d29492aee87311eeddeb`.

The browser captures have incomplete network-event coverage; absent captured
requests do not prove absent APIs. The separately fetched main bundle was
`assets/index-Dnr4h0st.js`, 692081 bytes, SHA256
`89096afe860b377f4d4f08d471f46e6e15332941cbe9242a63cfe348697418c2`.
No source map declaration or repository URL was present in that bundle. Static
analysis was scoped and does not establish all runtime behavior.

## Verification and remaining work

Backend checks cover invalid/oversized images, catalog-only candidates, floor
filtering, duplicate IDs, malformed model output, no-position response shape,
rate limits, CORS, disabled service and private provider failures. These use model
stubs; they do not measure Gemini recognition of actual library photos.

Before automatic guidance, measure cold-start success/time, floor correctness,
position and heading error at held-out points, drift along the route, relocalizing
from the opposite direction, dim/rearranged scenes, repeated stairwells, lost
network, expired anchors and app suspension/restart. Set acceptable error from
the spacing of actual doors and turns. Route validity and emergency exit status
require separate venue checks. No real library anchor or pose-accuracy result has
been produced by this work.
