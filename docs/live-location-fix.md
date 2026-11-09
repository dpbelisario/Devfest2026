# Live map position and selection line

The map requests location on entry and starts an ongoing watch. Allow location
access on the phone. The first valid fix centers the map; later fixes move the
position marker and refresh the selected destination's dashed bearing line,
distance and bearing. The user's chosen destination is retained. Panning the map
manually does not disable location updates; Locate recenters it.

The fixed campus coordinate remains an initial preview viewport. It is not drawn
as the user's location or used to draw a destination bearing before a valid fix.
Waiting/unavailable location status is shown. Denial leaves the dot and line hidden
on initial load. Fresh fixes outside Nagoya are accepted; the official evacuation
dataset and supported walking-route area remain Nagoya-specific. The dashed line
is a straight bearing, not an obstacle-aware or street-following route. Existing
walking routes retain their recalculation behavior after movement.

Positions require finite coordinates, nonnegative reported accuracy and timestamps
within 30 seconds (with up to 5 seconds of future clock tolerance). The iPhone
bridge keeps watches alive after temporary errors/timeouts and replays a fresh real
Core Location fix if it arrived before the page became ready. Permission denial
releases the watch. No test coordinates are injected into production location data.

## Verification

The browser regression uses controlled fixes to verify startup requests, initial
placeholder suppression, moving dot and both line origins, stable destinations,
positions outside Nagoya, invalid/stale rejection, Locate, and denial. Run with
Playwright/Chrome available and the official Leaflet 1.9.4 fixture:

```sh
LEAFLET_TEST_FILE=/path/to/leaflet.js node ios/tests/live-location.browser.cjs
node --test ios/tests/bridge.test.cjs ios/tests/build-shared.test.cjs
```

The hosted site requires deployment to receive the HTML fix. The local iPhone test
build overrides the Xcode setting `CONTOUR_UI_URL=` to use the updated bundled
page immediately, while backend data still uses the configured public API. The
repository's default `CONTOUR_UI_URL` remains the production hosted page. Opening
the app from its icon preserves this local build configuration. Hosted and bundled
pages have separate WebView localStorage; native saved floor overlays remain in
the same app storage and are transferred to either page.

Verification completed: live-location browser regression passed; 72 backend tests,
typecheck, lint, formatting and build passed; seven Node iOS bridge/build checks
and all 17 iOS XCTest tests passed. Android debug assembly, unit tests and lint
passed with JDK 21 (JDK 17 unavailable). Final bundled iPhone HTML matches the
source byte-for-byte. Startup overlay restoration no longer overrides live GPS
centering; saving or returning from the native editor still focuses the floor plan.
Physical GPS accuracy and movement behavior remain a device/venue check.

## Details reading position

Live fixes update the open Details sheet's distance and walking-time fields only.
They do not recreate its photo/content or measure its height again. Necessary
relayout and full language/name refreshes preserve the current reading offset.
Opening a destination intentionally still starts at the top. Upward touch gestures
scroll content instead of entering the downward swipe-to-dismiss gesture.

The iPhone bridge also preserves a visible Details sheet's scroll position across
native GPS callbacks, supporting older hosted HTML before deployment. It does not
restore an old offset if the callback changes the destination or closes the sheet.
This lets the native update fix continuous GPS scroll resets without switching the
phone away from its normal hosted Google Maps page.

`ios/tests/details-scroll.browser.cjs` checks repeated live fixes, static photo
identity, live distance updates, relayout, upward swipes and reopen behavior. The
native XCTest suite also exercises real WKWebView scrolling with native location
callbacks, including the older hosted layout-reset behavior. Run the browser test
with the same Playwright/Chrome setup used by the other iOS UI regressions.
