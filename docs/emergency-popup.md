# Emergency pop-up (Android)

When the phone receives an official emergency alert (緊急速報メール / ETWS cell broadcast: earthquake
early warning, tsunami, emergency warning or evacuation order), Contour opens by itself at the same
moment as the system alarm and shows an alert screen: what to do now, the official message, the nearest
evacuation site (designated for that hazard when known), and **3D AR directions** / **Open map** /
**Close**. Text follows the app language (English, 日本語, 中文, 한국어); the official message stays as sent.

## How it works

| Part | File |
| --- | --- |
| Which notifications count (urgent alert kinds only; drills and ordinary notifications ignored) | `android/app/src/main/java/com/contour/app/alert/EmergencyAlertClassifier.kt` (unit-tested) |
| Watches notifications from the phone's emergency-alert app | `alert/EmergencyAlertListener.kt` (NotificationListenerService) |
| Brings Contour to the front: full-screen notification + direct start when "display over other apps" is on | `alert/EmergencyPopup.kt` |
| Shows over the lock screen, passes the alert to the page, setup buttons | `WebUiActivity.kt` (`window.contourAlert`, `ContourBridge.alertSetupStatus/openAlertSetting/testAlert`) |
| Alert screen + setup page (menu → **Emergency pop-up**) | `android/app/src/main/assets/contour.html` |

Only notifications from an emergency-alert app (package name containing `cellbroadcast`, `areamail`,
`emergencyalert` or `etws`) are read; everything else is ignored at once. Nothing is stored or sent.

## One-time setup on each phone

Open the menu → **Emergency pop-up** (also shown once on first launch) and turn on:

1. **Notification access**: lets Contour notice the official alert.
2. **Display over other apps**: lets it open on top of the app in use.
3. **Notifications**: needed to open the alert screen on a locked phone.
4. **Full-screen alerts** (Android 14+).

APKs installed from outside the Play Store (Firebase App Distribution) get Android's **Restricted
setting** block for notification access. Fix: App info → ⋮ → **Allow restricted settings**, then turn
it on again. The setup page explains this and has an **Open app info** button.

**Test alert** (menu, below About Contour) or **Test the pop-up** (setup page) first asks **Yes / No**.
On Yes, lock the phone: about 8 seconds later the screen wakes, a test alert notification
(緊急地震速報（テスト）) appears on the lock screen with strong vibration and a test siren (generated in
`alert/TestSiren.kt`, alarm volume), and about 3.5 seconds later Contour pops up through the real pop-up
path.

The official message on the alert screen is translated into the app language for the usual 緊急速報
wording (earthquake area, 強い揺れに備えてください, tsunami and evacuation sentences, (気象庁)), with
the Japanese original underneath; other text goes to the device translator or stays Japanese.
Contour may show over the lock screen only for an alert: once it leaves the screen, the normal lock
applies again. Only the test
makes its own sound; a real alert is already loud from the phone's emergency-alert app. The screen is labelled "TEST · not a real emergency". If a setting is
still off, the menu item opens the setup page instead. In a browser, the test shows the alert screen at
once.

## Testing with adb (debug builds)

Debug builds also accept notifications posted from the shell:

```
adb shell cmd notification allow_listener com.contour.app/com.contour.app.alert.EmergencyAlertListener
adb shell appops set com.contour.app SYSTEM_ALERT_WINDOW allow
adb shell "cmd notification post -S bigtext -t 'Earthquake Early Warning' eew1 'Prepare for strong shaking'"
```

Checked on the `Medium_Phone_API_37.0` emulator: an ordinary notification does not open the app; an
earthquake warning opens it from the home screen; a tsunami warning wakes a sleeping, locked phone and
shows the alert screen over the lock screen; Back closes the alert, then leaves the app.

## Limits

- Not yet tested with a real 緊急速報 on a real phone. Alert apps differ by maker and carrier; if one is
  missed, add its package name hint in `EmergencyAlertClassifier`.
- Android only (iOS does not allow this).
- The first alert may ask for location permission if it was never granted, so the nearest site can use
  GPS.
- Planned next: a push from the backend (JMA data) for phones without the setup, or when the official
  alert is missed (needs Firebase Cloud Messaging).
