# Floor Maps route interface on iPhone

The iOS Floor Maps screen uses a map-first directions layout. This is Contour's
interface over the existing Google Maps/offline providers, not an embedded Google
Maps app. No Android UI or backend changes are required.

## Use

- **From / To:** select saved floor locations in the floating card. Tap the blue
  start icon or red destination icon to choose which field a map-pin tap updates.
  The active field is highlighted and the map chip explains what a tap will do.
  In start mode, tapping a pin immediately sets the indoor position there and
  initializes motion tracking using the phone heading. Tap where you actually are.
  Destination-mode taps only change the goal. Dropdown selections and Swap remain
  planning controls; Map options can also explicitly set the chosen position.
  Numbered pins are 24 pixels wide with translucent fills to reveal printed labels.
- **Swap:** reverses the planning endpoints and automatically requests a new route.
  This changes the planned trip, not the phone's actual/confirmed position.
- **Floor:** the existing selector stays visible below the route card. Other
  reference floors remain available; routing fields appear for the saved overlay's
  floor only.
- **Route:** choosing both endpoints requests the existing wall-aware planner.
  The blue line is the calculated route; the orange initial-position suggestion
  line is hidden once that route is available. Distance and intermediate-stop
  count appear in the bottom card. No invented travel time or arrival estimate
  is shown.
- **Directions:** expands the bottom card to show one numbered walking step at a
  time. At the named location, tap **I've arrived — next step** to advance. The last
  walking step uses **I've arrived at my destination** and then shows completion.
  **Previous step** undoes an advance, including the final arrival confirmation.
  GPS and sensor updates never advance instructions. A changed or recalculated
  route starts again at step one. Arrival confirmation moves the indoor dot to
  the reached landmark pin and restarts step tracking there, preserving the current
  tracked heading. The original route endpoints remain unchanged. Previous step
  only undoes instruction progress; it does not move your position backward.
  While Directions is expanded, the From/To card hides and the floor controls move
  up to reveal more of the map. Collapse Directions to edit the endpoints again.
  The planner's trailing finish
  reminder is folded into completion rather than requiring another walking step.
  Drag the grab handle up/down or tap it to expand/collapse. AR stays separate.
- **Fit floor and route:** the floating fit button reframes the route, or the
  whole floor when no route is available. The map supports one-finger panning and
  pinch zoom. Fractional zoom avoids excessive zoom-out around small floor plans.
- **Map options (three dots):** edit/import the overlay, detect labels/walls, edit
  walking points/passages, clear a destination, preview walls, confirm/reset indoor
  position or adjust step length. Confirmation is still optional for static routes.
  It is required to initialize the separate motion/AR flow.

## Behavior and checks

The saved floor image renders at full opacity in Floor Maps for legibility. Its
geographic alignment and saved opacity in the native alignment editor/general map
are preserved. Top fields truncate long captions; the native option list retains
the complete names. Sensor readings no longer rebuild the starting-point options,
so a compass/GPS update does not disrupt an open picker.

The green indoor dot has a green arrow and translucent viewing cone. Fresh valid
phone compass readings rotate this indicator even when stationary or motion
tracking is paused. Unreliable compass readings are ignored; without a fresh
compass reading, active step/gyro heading is the fallback. Viewing direction is
separate from the step-tracking heading and never moves the dot. Indoor magnetic
interference can still affect the compass.

Map bounds include padding for the floating route card. The actual map viewport
resizes above the bottom drawer so provider attribution is not covered. Resize
observers handle viewport changes and drawer movement without resetting selected
endpoints or the saved route. Closing Floor Maps also closes the options menu.

Native WKWebView checks verify field bounds, a large map and the map/footer boundary.
Browser regressions cover source/destination pin modes, swapping and automatic
replanning, drawer expansion and drag collapse, narrow viewports, options access,
unchanged saved-overlay/PDR behavior, and layout snapshots using the bundled floor
image. Screenshot routes are explicitly illustrative UI fixtures. Real Google SDK
rendering and phone gesture feel still need device testing.
