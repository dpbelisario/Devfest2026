# Library deployment flow

One source page at `android/app/src/main/assets/contour.html` feeds Cloud Run's
`/app/`, Android's offline asset and Xcode's bundled resource. Backend routes and
catalog live under `backend/`; graph changes regenerate the page at build time.

## Build and commit

Use Node.js 24, JDK 17 and Android SDK 35. From the repo root:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run format:check
node --test ios/tests/bridge.test.cjs ios/tests/build-shared.test.cjs
```

Commit graph changes and the regenerated HTML together. Android Cloud Build and
the manual iOS workflow now build/test the shared catalog and refuse to package
a stale generated HTML file (Android compares its SHA256 before/after regeneration;
iOS uses `git diff --exit-code`). Changes to that HTML also
match the Android trigger's `android/**` filter. A push to the owner's `main`
triggers the existing Cloud Run deployment and Android App Distribution release.
Use SSH when pushing workflows: `git push git@github.com:dpbelisario/Devfest2026.git HEAD:main`.
Never force-push if main advances; integrate the new main first.

Project: `gen-lang-client-0467526025`; region `asia-northeast1`.
Hosted page: https://gen-lang-client-0467526025.web.app/app/ .
Android trigger: `android-apk-distribution`, config `android/cloudbuild.yaml`.
Tester group: `team-david`. Shared signing and monotonically increasing Android
version codes allow updates in place. Monitor Cloud Build until both backend and
Android distribution succeed; seeing a commit on GitHub alone is not a release.

## Free signed iPhone installation

The existing free Personal Team does not support Firebase OTA or TestFlight.
Connect/unlock/trust the iPhone and enable Developer Mode. Do not commit personal
signing settings or credentials. From the current checkout on the Mac:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export IOS_DEVICE_UDID=YOUR_CONNECTED_IPHONE_UDID
export IOS_TEAM_ID=YOUR_XCODE_TEAM_ID
export IOS_BUNDLE_ID=YOUR_PERSONAL_BUNDLE_IDENTIFIER
./scripts/install-ios-device.sh
```

The script builds/regenerates shared data, checks bridge behavior, signs with the
local Xcode account, byte-compares bundled HTML with the source, installs and
launches via `devicectl`. The default derived-data directory is `ios/DerivedData`;
set `CONTOUR_DERIVED_DATA` to reuse another checkout's existing build cache.
The phone must be unlocked to launch. Rebuild when free signing expires (usually
seven days). The script never asks for an Apple password.

## Paid iOS Firebase distribution

The existing `iOS build and Firebase distribution` GitHub workflow remains manual.
Run on the same main revision as Android. Choose `firebase` only after supplying
the paid team's ad hoc certificate and profile containing tester UDIDs, plus the
configured Google WIF variables. See [ios-firebase.md](ios-firebase.md).
Unsigned artifacts cannot be installed directly. No paid signing is provisioned
by the library feature.

## Verify a release

Open the library on the hosted page and each installed shell. Select every floor,
start a checkpoint route, confirm a stairs transition, deny motion permissions,
and test background/resume. Test airplane mode in both apps after closing the
online page so the bundled fallback is exercised. Compare hosted HTML and APK /
iPhone bundled `contour.html` byte-for-byte for the same commit. Record the commit,
Cloud Build IDs, Firebase release/version, iPhone build/install result and field
walk results on GitHub issue #3. An installed build does not prove route accuracy.

## Relative obstacle-arrow release

The standalone camera demo lives on `release/obstacle-avoidance-ar`. Open the
library card's **Indoor exit / obstacle AR** action, then **Relative obstacle
arrows · demo**. No checkpoint or cloud localization is needed for this local
experiment. The native shell must be rebuilt/installed; a hosted HTML update
alone cannot add ARKit/ARCore code. Both shells share the same entry and floor
preview. Three.js r128 is bundled with its MIT notice for offline 3D previews.
See [obstacle-avoidance-ar.md](obstacle-avoidance-ar.md) for sensing limits.

To launch the installed iPhone camera demo directly while Hosting is still
deploying, bypassing the older hosted UI without changing Wi-Fi settings:

```sh
xcrun devicectl --timeout 30 device process launch --terminate-existing \
  --device "$IOS_DEVICE_UDID" "$IOS_BUNDLE_ID" --bundled-obstacle-demo
```

This explicit launch uses the bundled page and opens the native scanner. Ordinary
launches continue using the hosted page with bundled fallback.
