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
  The shortest wall-clear route is selected, with fewer intermediate pins as a tie-breaker.
  The blue line is the calculated route; the orange initial-position suggestion
  line is hidden once that route is available. Distance and intermediate-stop
  count appear in the bottom card. No invented travel time or arrival estimate
  is shown.
- **Directions:** expands the complete numbered instruction list. The From/To
  card hides and the floor controls move up to reveal more of the map. Collapse
  Directions to edit endpoints again. No arrival buttons or landmark-based position
  resets are used. The route stays visible while the green dot follows step tracking.
- **Fit floor and route:** the floating fit button reframes the route, or the
  whole floor when no route is available. The map supports one-finger panning and
  pinch zoom. Fractional zoom avoids excessive zoom-out around small floor plans.
- **Map options (three dots):** edit/import the overlay, detect labels/walls, edit
  walking points/passages, clear a destination, preview walls, confirm/reset indoor
  position or adjust step length. Confirmation is still optional for static routes.
  It is required to initialize the separate motion/AR flow.

## Personal step length and tracking

Open **Map options → Calibrate my steps → Use Apple Health step length** to import
an existing estimate. The iPhone asks for read access to **Walking Step Length**
only when this button is tapped. Contour does not request write permission or
other Health data types. It reads at most 50 samples from the last 30 days and uses
the median of values in the tracker's supported 0.4–1.1 m range. The status shows
the estimate, sample count and most recent sample date. Only the derived estimate
is saved locally for navigation; raw samples are not sent to the page or backend.

HealthKit deliberately does not reveal whether read permission was denied. If
no readable recent samples exist (or none are usable), Contour keeps the previous
step length and offers manual calibration. Check Health permissions for Contour
or generate walking step length samples through normal pocket-carried walking.
Imported values apply on the next starting-position selection and never reset
the current indoor pose. Requests cancelled by leaving the floor cannot overwrite
newer settings. HealthKit entitlement and `NSHealthShareUsageDescription` are
configured in the iOS target; signing requires a profile supporting that capability.

Open **Map options → Calibrate my steps** before choosing your physical starting
pin. Enter an independently measured distance (5–100 m; 10–20 m recommended), tap
**Start calibration**, walk it holding the phone in front of you, stop, then tap
**Finish calibration**. The native pedometer queries steps through the finish time
so delayed live counts do not truncate the measurement. At least eight steps and
an average length of 0.4–1.1 m are required; invalid results keep the previous value.

The average step length is distance divided by steps and is saved locally. It is
used the next time you set a starting position, not retroactively applied to an
active tracking session. Manual step-length entry is also retained. Calibration
is independent of the map tracker, never uses GPS distance, and never relocates
the dot. Cancel, leaving the floor, or backgrounding cancels an unfinished trial.

Then set your physical start by tapping its pin in start mode (or use Set my
position here), and choose your destination. The existing foreground tracker uses
cumulative iPhone steps, the calibrated step length, an initial compass heading,
and gyro turns. Hold the phone facing your walking direction. No intermediate
arrival confirmations are required. GPS cannot move the anchored dot; reviewed
walls reject steps that would cross a barrier. Missing wall geometry prevents route
planning. This remains dead reckoning: stride variation and heading drift accumulate,
and the app does not automatically identify your indoor position or floor.

The bottom card displays live tracking status and step count. Choosing a From
dropdown value plans a route; tap **Start tracking** to anchor the dot there (a
start-mode map-pin tap also starts it). Delayed pedometer batches are reconciled
against retained gyro headings, keeping pose timestamps monotonic. Early step
updates wait for the first motion sample instead of immediately pausing.
**Resume tracking** restarts from the last live dot using a fresh compass heading,
without jumping back to the original pin. Counts restart for the resumed session;
movement during a real interruption is not reconstructed. **Held at mapped wall**
means steps are arriving but geometry blocks displacement; review the starting
point, heading and wall/door geometry. **Motion access needed** requires checking
Motion & Fitness permission in Settings. A stalled startup times out instead of
remaining silently stuck indefinitely.

The library 3D AR entry now uses this tracking session and a natively planned route
to the saved destination. See [tracked-floor-ar.md](tracked-floor-ar.md).

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
