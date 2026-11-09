# Step-based indoor navigation on iPhone

Floor Maps and its **Open AR navigation** action use one foreground native
`IndoorStepTracker`, replacing GPS-offset movement after confirmation. This is a
basic pedestrian dead-reckoning implementation inspired by the papers' motion
estimation approach. It is not a reproduction of either paper, and does not yet
implement particle filtering, adaptive step-length learning or map matching.

## Use

1. Stand at a known saved pin. Face your walking direction with the phone held in
   front of you. Check the floor, then tap **Set my position here**.
2. Allow Motion & Fitness access. A current compass reading seeds the initial
   direction; the status reports when step tracking is active. Motion denial or
   missing hardware displays an unavailable state rather than using GPS instead.
3. Walk while keeping the phone facing your walking direction. New iOS pedometer
   counts move the dot; gyro turns rotate heading. Turning while stationary does
   not move the dot. GPS fluctuations and later compass changes do not move or
   rotate the confirmed indoor pose.
4. Choose a different saved destination and open AR. The immediate arrow, remaining
   distance and map use the same step-based position. Camera observations only
   provide local obstacle/side/stop cues. Closing AR preserves that position.
5. Reconfirm at a recognizable landmark to correct drift. Closing Floor Maps,
   backgrounding or losing motion updates pauses tracking; reconfirm on return.
   **Use uncorrected phone position** ends the indoor session.

The default step length is an assumed **0.72 m**, not a measured personal value.
Set **Step length for next confirmation (m)** to a value between 0.4 and 1.1 m, then
reconfirm to apply it. To calibrate, divide a known walking distance by your counted
steps, and test again at several paces. No automatic training is included.

## Implementation

`CMPedometer` supplies monotonic cumulative step counts. Core Motion supplies
bias-compensated rotation rates and gravity at 50 Hz. Projecting angular velocity
onto gravity measures clockwise yaw without treating raising/lowering the phone
as a walking turn. Heading is integrated from the initial compass alignment;
continuous magnetometer/GPS corrections are not applied. Position changes only
on new steps. Batches use historical gyro headings with evenly spaced estimated
step times. The native service publishes at up to 5 Hz while foregrounded, validates
session identity/floor/configuration, ignores stale callbacks, and stops its sensors
on pause/reset. Motion failure never silently falls back to outdoor positioning.

The camera's AR session can initialize or restart obstacle tracking independently
without resetting indoor position. The previous stand-alone library-exit demo
remains separate; use Floor Maps' saved-destination AR for this step-based flow.

## Limits and checks

Holding the phone sideways while walking straight, swinging it, walking backwards,
side-stepping, stairs and large step-length variation are not modeled correctly.
iOS batches step reports, so motion updates may lag; turn placement within a batch
is approximate. Gyroscope and stride errors accumulate. The printed pin may not
be a walkable standing point. The floor is selected manually. There is no wall or
corridor constraint, global obstacle rerouting, verified room entrance or precise
arrival guarantee. Camera-only obstacle checks can miss hazards.

Native tests cover straight steps, a turn in place, step-length scaling, duplicate/
old counters, invalid motion and sensor gaps, and shared-pose AR geometry. Browser
regressions verify that GPS cannot move a confirmed dot, later compass readings
cannot replace heading, step-pose messages update the map, and AR receives the
matching tracking session. Hardware permission, step latency and real-world error
still require an iPhone walking test against known positions.
