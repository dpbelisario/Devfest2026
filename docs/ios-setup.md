# Contour iOS setup and TestFlight

Contour keeps the HTML interface in a UIKit/WKWebView app. The Xcode build embeds
the `ContourShared` Kotlin framework from `android/shared`; it does not replace the
interface with Compose. Use `ios/Contour.xcodeproj`, scheme **Contour**.

Apple requirements checked on 7 November 2026. This guide describes manual setup;
the simulator build and four native XCTest tests have passed. A signed archive,
upload and physical-device run still need verification.

## Choose an installation method

| Method              | Account                             | Installation                                        | Expiry / review                                          |
| ------------------- | ----------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Personal Team       | Free Apple Account                  | Connect your own iPhone and run from Xcode          | Provisioning expires after 7 days; rebuild and reinstall |
| TestFlight internal | Active Apple Developer Program team | Invite App Store Connect users who have app access  | Up to 100 testers; no TestFlight App Review              |
| TestFlight external | Active Apple Developer Program team | Invite testers by email or a TestFlight public link | Up to 10,000 testers; TestFlight App Review required     |

Every TestFlight build expires after 90 days. A free Personal Team cannot upload
to TestFlight. Only use a paid team after the owner confirms active membership and
access; account enrollment and agreement acceptance are owner actions.
See [Apple account limits](https://developer.apple.com/help/account/basics/about-your-developer-account/)
and [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

## Enroll from your iPhone

For personal membership, complete this yourself in the
[Apple Developer app](https://apps.apple.com/jp/app/apple-developer/id640199958):

1. Enable two-factor authentication on your Apple Account, check its legal name,
   address and phone details, sign in to iCloud, and enable a device passcode,
   Face ID or Touch ID. Use the same iPhone throughout enrollment.
2. Install the latest Apple Developer app. Open **Account**, sign in, accept the
   Apple Developer Agreement if prompted, and tap **Enroll Now** → **Continue**.
3. Enter your legal name and phone number, complete the requested government photo
   ID verification, and choose **Individual** if enrolling personally. Your legal
   name becomes the App Store seller name. Organization enrollment has additional
   legal-entity and signing-authority requirements.
4. Review the Apple Developer Program License Agreement and accept it yourself.
   Review the annual subscription and tap **Subscribe** when you choose to pay.
   App enrollment renews automatically until cancelled.

Apple lists the fee as **US$99 per year**, with local currency where available.
The Japanese App Store currently lists **¥12,800** for the membership purchase;
check the price shown on your own purchase screen before subscribing. See
[Apple's enrollment instructions](https://developer.apple.com/help/account/membership/enrolling-in-the-app/)
and [annual fees](https://developer.apple.com/help/account/membership/program-enrollment/).

Continue to TestFlight setup only once membership is active and the paid team and
App Store Connect access are available. A purchase receipt alone is not proof of
that access. If enrollment is unavailable or still pending, follow the app's status
and [Apple Developer Support](https://developer.apple.com/contact/) instructions.

Code, project configuration, documentation and checks that need no Apple login can
be prepared while enrollment is pending. Identity verification, agreement acceptance,
payment and account sign-in remain owner steps. Building and uploading this Xcode
project require a compatible **Mac**; enrollment on iPhone does not replace it.

## Install the toolchain

- Full Xcode with iOS platform support is required; Command Line Tools alone cannot
  compile this app. Launch Xcode and complete first-launch setup.
- For local installation on the previously checked macOS 15.4.1 / iOS 18.1 setup,
  Xcode 16.4 is compatible. Download older releases from
  [Apple Downloads](https://developer.apple.com/download/all/).
- **TestFlight uploads require Xcode 26 or later and the iOS 26 SDK or later.**
  Apple has enforced this since 28 April 2026. Xcode 16.4 cannot produce a qualifying
  upload. Xcode 26 through 26.3 require at least macOS 15.6; newer Xcode releases
  can require a newer macOS. Upgrade macOS or use another compatible Mac before
  archiving for distribution. Check the
  [upload requirement](https://developer.apple.com/news/upcoming-requirements/?id=04282026a)
  and [Xcode compatibility table](https://developer.apple.com/xcode/system-requirements/).
- Use JDK 17 and Android SDK 35 for the shared Gradle build. The **Build shared
  Kotlin** phase invokes `:shared:embedAndSignAppleFrameworkForXcode`; the first build
  needs network access to download its dependencies. Inspect its environment setup
  when using another Mac. Keep machine-specific paths out of committed files.

Check the active tools from the repository root:

```sh
xcode-select -p
xcodebuild -version
xcodebuild -showsdks
xcodebuild -list -project ios/Contour.xcodeproj
```

Select the intended Xcode in Xcode → Settings → Locations → Command Line Tools.
The deployment target remains iOS 16.0; building with the iOS 26 SDK does not require
raising the minimum supported iOS version to 26.

## Run on your own iPhone with Personal Team

1. In Xcode → Settings → Accounts, sign in to your Apple Account yourself.
2. Open `ios/Contour.xcodeproj`. Select the **Contour** app target → Signing &
   Capabilities, enable **Automatically manage signing**, and select your
   **Personal Team**. Choose a unique bundle identifier, for example
   `com.dpbelisario.contour.weekend`. The committed `com.contour.app` is a placeholder.
3. If running XCTest, give **ContourTests** the same team and a matching unique
   identifier such as `com.dpbelisario.contour.weekend.tests`.
4. Connect and unlock the iPhone, accept Trust prompts, and select it as the run
   destination. Enable Settings → Privacy & Security → Developer Mode when prompted;
   restart and confirm. Press **⌘R**. Trust the developer profile under Settings →
   General → VPN & Device Management if iOS asks.
5. Follow the [device checks and demo limitations](ios.md). Rebuild and reinstall
   when the seven-day provisioning profile expires.

For free weekend testing with other people, repeat the connect/Trust/Run steps
for each iPhone on the same Mac and Personal Team. Apple's limit is **three
registered devices per platform total**, including your own phone, not three
additional testers. These are device registrations, not TestFlight invitations.
Every installation needs re-signing after seven days. Four phones cannot all
use one Personal Team's three-device allocation. A teammate can instead build
on their own Mac with their own Apple Account/Personal Team; each person signs
in themselves. This does not provide remote beta distribution.
[Personal Team device limits](https://developer.apple.com/help/account/basics/about-your-developer-account/).

This route needs neither an App Store Connect app nor Firebase iOS registration.
It has no APNs capability. Paid signing alone does not implement remote alerts.

### Older iPhones

The confirmed test phone is an iPhone XS Max running iOS 18.1. It can use the
basic app's iOS 16 deployment target but has no LiDAR. Personal Team testing
requires Xcode on a Mac, not the Apple Developer iPhone app. If the current
Apple Developer app requires a newer iOS version, use Apple's
[web enrollment](https://developer.apple.com/programs/enroll/) for paid membership.
The TestFlight upload's iOS 26 SDK requirement describes the Mac build toolchain;
it does not require every tester's phone to run iOS 26.

## Configure the paid team and App Store Connect app

The owner completes these steps in their own Apple account:

1. Confirm active Apple Developer Program membership and current agreements.
   Obtain the paid **Team ID** from the developer account membership page.
2. Choose a permanent, unique app bundle identifier owned by that team, for example
   `com.dpbelisario.contour`. Set it on **Contour** for Debug and Release, select the
   paid team and leave automatic signing enabled. Configure **ContourTests** under
   the same team with the app identifier plus `.tests`. Do not commit a personal
   Team ID or substitute someone else's identifier.
3. Ensure the matching explicit App ID exists under Certificates, Identifiers &
   Profiles. Xcode can register it through automatic signing when the account has
   permission. Distribution signing also needs the team's certificate/profile
   access; Xcode manages these when permitted.
4. In [App Store Connect](https://appstoreconnect.apple.com/), choose Apps → **+** →
   **New App**. Select iOS, an available name, primary language, the exact same
   bundle ID, and a unique internal SKU such as `contour-ios`. App creation requires
   Account Holder, Admin or App Manager access. Keep this record for future builds;
   the bundle ID cannot be changed after the first upload.
5. Set **Version** (`MARKETING_VERSION`, initially `0.1.0`) and **Build**
   (`CURRENT_PROJECT_VERSION`, initially `1`). Increase the build number for each
   new upload. Team, bundle ID and version/build settings can also be supplied as
   `xcodebuild` build-setting overrides instead of committing local signing changes.

See [create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
and [Apple's distribution workflow](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

## Archive and upload manually

1. Run the simulator tests (**⌘U**) and the physical-device checks in `ios.md`.
   Verify the hosted HTML/backend used by this build, permission denial recovery,
   camera, GPS, speech and notification/haptic behavior.
2. Select **Contour** and **Any iOS Device (arm64)**, then Product → **Archive**.
   The scheme's Archive action must use **Release**. Resolve Kotlin compilation,
   signing, app-icon and validation errors before uploading.
3. In Window → Organizer → Archives, select the archive and click **Distribute App**.
   Choose **App Store Connect** / the TestFlight distribution flow and upload using
   the paid team and automatic signing. For external testing, leave **TestFlight
   internal testing only** unchecked; a build uploaded with that restriction cannot
   later be used for external testing.
4. Wait for Apple to process the build and inspect its status in the app's
   **TestFlight** tab. An upload alone does not make it available to testers.
5. If it reports **Missing Compliance**, click **Manage** and answer Apple's
   encryption questions for the shipped app, including embedded web dependencies.
   HTTPS uses encryption even when the app has no custom cryptography. The owner
   determines any exemption/documentation requirement; do not blindly add
   `ITSAppUsesNonExemptEncryption = NO`. Add that key only after confirming the app
   uses no non-exempt encryption. Complete any required documentation before review.

See [upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
and [export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).

## Invite testers

For internal testing, create an internal group in the TestFlight tab, select a
processed/compliant build, and add eligible App Store Connect users with app access.
On the iPhone, install [Apple's TestFlight app](https://apps.apple.com/app/testflight/id899247664),
open the invitation email/link, accept it, and tap **Install** for Contour once its
build is available. Internal testers are members of the App Store Connect team;
ordinary friends are external testers.

For external testing, first create an internal group, then an external group. Fill
in Test Information, including a beta description, feedback email and review contact
details. Supply review notes and access instructions; this prototype has no required
app login. Describe alerts as local tests and routes as unsurveyed previews. Add the
build and submit it for **TestFlight App Review**. The first build requires full
review; later builds of the same version may also need review. After approval,
invite testers by email or enable the group's public link. Review timing is not
guaranteed. TestFlight installation does not require Xcode or Developer Mode.

See [internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/),
[test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/)
and [external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/).

## Credentials and remaining work

Apple login, two-factor codes, private signing keys, provisioning profiles and any
App Store Connect API keys stay with the owner in Xcode/Keychain or Apple's portal.
Do not paste them into chat, repository files or issue reports. This manual route
needs no automation API key or new CI pipeline.

Before calling TestFlight ready, verify paid-team access, compatible Xcode/macOS,
native compilation and device tests, a valid signed Release archive, required app
artwork/metadata, export compliance and Apple's successful build processing.
No account/app creation, membership purchase, signed upload, tester invitation or
beta review has been performed by writing this guide. Current feature limits are
documented in [ios.md](ios.md).

Tracked work: [iOS foundation #26](https://github.com/dpbelisario/Devfest2026/issues/26), [TestFlight #27](https://github.com/dpbelisario/Devfest2026/issues/27), [IndoorAtlas verification #28](https://github.com/dpbelisario/Devfest2026/issues/28).

For Firebase distribution and the already registered iOS app, see
[iOS on Firebase](ios-firebase.md). Firebase hosting does not replace Apple signing.
