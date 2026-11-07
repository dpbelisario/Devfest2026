# Contour iOS on Firebase

The Firebase iOS app is registered in the existing project:

- Project: `gen-lang-client-0467526025`
- App: **Contour iOS**
- Bundle ID: `com.contour.app`
- Firebase App ID: `1:223430657240:ios:4602c150530d1b6f4e83ad`
- Tester group: `team-david`

Open [Project settings](https://console.firebase.google.com/project/gen-lang-client-0467526025/settings/general)
or [App Distribution](https://console.firebase.google.com/project/gen-lang-client-0467526025/appdistribution).
Select **Contour iOS** rather than the Android app. Registration does not mean a
build has been uploaded or installed; no iOS release has been distributed yet.

## Same repository and Firestore backend

Keep the existing `ios/Contour.xcodeproj` shell. It loads
`https://gen-lang-client-0467526025.web.app/app/`, just like Android. Firebase Hosting
forwards to Cloud Run `api`, whose existing live-data services read Firestore.
The live Hosting rewrite was checked and still targets `api` in `asia-northeast1`.

The client uses those HTTP APIs; no direct Firestore SDK or client database rules
are added here. Registering an iOS app does not require putting backend credentials
on the phone. App Distribution itself does not require installing the Firebase
SDK or bundling `GoogleService-Info.plist`. UI/backend updates follow the existing
backend deployment; native Swift/Kotlin changes require a new iPhone build.

Android IndoorAtlas work stays on `david/indooratlas`, PR #24. That branch's native
Android bridge is separate from iOS. This pipeline does not claim to implement an
iOS IndoorAtlas adapter or convert Android camera/floor estimation code to Swift.
See coordination [#25](https://github.com/dpbelisario/Devfest2026/issues/25).

## What Firebase can and cannot install

Firebase App Distribution is a no-cost distribution service. iOS installation via
its links still requires a correctly signed IPA and a provisioning profile that
includes each tester's device. This workflow uses paid-team **ad hoc** signing.
Free Personal Team profiles are not supported for this distribution mode.
An unsigned IPA artifact must be signed locally, for example using a free Apple
Account with a sideloading tool; Firebase cannot make it installable by itself.

A free browser demo is already available at `/app/` through Safari. It cannot run
native LiDAR or the Swift Core Haptics alert implementation. Web push would need
separate implementation. Firestore storage does not change these platform limits.

Sources: [Firebase tester-device registration](https://firebase.google.com/docs/app-distribution/register-additional-devices),
[Firebase's iOS prerequisites](https://firebase.google.com/codelabs/appdistribution-ios),
[Apple ad hoc profiles](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile).

## Repeat registration in Cloud Shell

Registration has already succeeded; these commands reuse the existing app rather
than creating a duplicate. Run in a checkout of this branch with Google Cloud login:

```sh
gcloud config set project gen-lang-client-0467526025
python3 ios/scripts/setup-firebase.py
```

The script supplies `x-goog-user-project` for local user credentials. The initial
403 was a missing quota-project header, not evidence that the project lacks an
iOS option. The resulting public metadata is in `ios/firebase-app.json`.
Cloud Shell can register/upload apps, but cannot build iOS: Xcode needs macOS.

## Google upload identity

A dedicated service account `contour-ios-distribution` is configured with
Firebase App Distribution administration and quota-use permissions, without
Firestore access. GitHub uses Workload Identity Federation instead of a downloaded
Google service-account key.

Trust is restricted to this repository's immutable repository and owner IDs,
manual `workflow_dispatch` runs, and `main` or `david/kmp-ios`. GitHub repository
variables have been set:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`:
  `projects/223430657240/locations/global/workloadIdentityPools/contour-ios-ci/providers/github`
- `GCP_SERVICE_ACCOUNT`:
  `contour-ios-distribution@gen-lang-client-0467526025.iam.gserviceaccount.com`

To recreate/update this configuration with appropriate project IAM permissions:

```sh
bash ios/scripts/setup-firebase-ci.sh
```

The script prints those two variable values. Set them under GitHub repository
Settings → Secrets and variables → Actions → **Variables** if using another copy.
It does not purchase Apple membership, register tester devices or upload a build.

## Build and distribution workflow

[The manual workflow](../.github/workflows/ios-firebase.yml) has two modes:

- **unsigned**: build the native app and retain an unsigned IPA artifact for seven
  days. It requires local re-signing before an iPhone can install it.
- **firebase**: validate owner-provided ad hoc signing material, build/export a
  signed IPA and upload it to the selected Firebase tester groups.

It has no automatic push trigger. The workflow must reach the repository's default
branch through review before GitHub exposes its manual dispatch. Then open Actions
→ **iOS build and Firebase distribution** → Run workflow, select the intended ref
and mode. The permitted refs are `main` and `david/kmp-ios`. Alternatively:

```sh
gh workflow run ios-firebase.yml --repo dpbelisario/Devfest2026 \
  --ref david/kmp-ios -f distribution=unsigned
```

For Firebase mode, the owner supplies these in GitHub Settings → Secrets and
variables → Actions:

| Type     | Name                                    | Value                                                                       |
| -------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Variable | `IOS_TEAM_ID`                           | Active Apple Developer Program Team ID                                      |
| Secret   | `IOS_DISTRIBUTION_CERTIFICATE_BASE64`   | Base64 of an Apple Distribution `.p12` with its private key                 |
| Secret   | `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | That `.p12` export password                                                 |
| Secret   | `IOS_AD_HOC_PROFILE_BASE64`             | Base64 of the ad hoc profile for `com.contour.app`, containing tester UDIDs |

Apple signing files/passwords stay with the owner; do not paste them into issues or
commit them. Provisioning profile creation requires device registration in Apple's
portal. Firebase can collect tester UDIDs, but the owner must add them to the Apple
profile and rebuild. Select `team-david` or another authorized tester group at run
time. A Firebase-mode run sends release invitations/updates to those testers.

The Linux preflight rejects missing, expired, development, enterprise and mismatched
profiles before starting a macOS runner. The build imports signing material into a
temporary keychain, archives/exports and removes it afterward. The workflow uses
JDK 17, Android SDK 35 and the existing shared Kotlin build; it retains IPA artifacts
for seven days and caps build duration at 45 minutes. macOS runner usage counts
against the private repository's Actions quota and may incur charges beyond it.
No workflow has been dispatched as part of setup.

Firebase ad hoc distribution does not upload to App Store Connect, so its path does
not inherit TestFlight's current Xcode26/iOS26-SDK upload requirement. Build with a
compatible Xcode and SDK for the app and test phones. TestFlight remains a separate
paid-team distribution option in [ios-setup.md](ios-setup.md).

## Verification

```sh
python3 -B -m unittest discover -s ios/tests -p '*_test.py'
node --test ios/tests/*.test.cjs
```

Registration and Google IAM/federation configuration succeeded. The full native
simulator build, all four XCTest tests and an unsigned iPhone release archive passed
with Xcode 16.4. The target is iPhone-only; physical-device
validation, an actual GitHub workflow run, signed export and tester installation
remain pending. Simulator
screenshots cannot establish physical haptics, compass accuracy or safe evacuation
routes. No Firestore rules, production Hosting routes or Android release pipeline
were changed by this setup.
