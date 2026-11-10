# Warning push notifications (Android, FCM)

SEA can send a phone notification when the Japan Meteorological Agency (JMA)
publishes a warning that matters for Nagoya. It is **off by default** on both
sides: the backend sends nothing until `FCM_DELIVERY_ENABLED=true`, and a phone
receives nothing until its user turns on **Warning notifications** in the app.

This is a scaffold feature. It is not an official alert service and does not
replace the phone's own emergency alerts (緊急速報). Messages can arrive late or
not at all.

## Flow

```
JMA Atom feeds ─▶ contour-jobs /jobs/jma/{weather,eqvol}/process ─▶ Firestore warningOutbox (pending)
                                                                         │
Cloud Workflows jma-warnings (every minute) ─▶ /jobs/outbox/deliver ─────┘
                                                   │  claim → send → mark sent/skipped
                                                   ▼
                                  FCM topic contour-aichi-warnings ─▶ Android app (subscribed users)
```

1. The JMA jobs store each new bulletin and queue a `warningOutbox` row
   (`pending`, or `excluded` for training/test reports). See
   [cloud-jobs.md](cloud-jobs.md).
2. The `jma-warnings` workflow calls `POST /jobs/outbox/deliver` every minute.
   With delivery enabled, the backend
   (`backend/src/services/jobs/outbox.ts`, `warningPush.ts`):
   - marks rows created more than 30 minutes ago `skipped` (`skipped:stale`), so
     turning delivery on never sends an old backlog;
   - reads the remaining pending rows oldest first and decides for each one;
   - claims each row in a Firestore transaction before sending, sends at most
     **3** messages per call, and marks each row `sent` (with the FCM message ID)
     or `skipped` (with a reason) and an `acknowledgedAt` time;
   - leaves a row `pending` when the send fails, so the next minute retries it
     (until it is 30 minutes old).
3. The app subscribes to the FCM topic only after the user turns warnings on.
   No device token is sent to the backend.

### What is sent

| Bulletin                                       | Sent when                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Aichi weather warnings (VPWW53)                | Nagoya (area `2310000`) has a warning or advisory that is issued, continuing or changed level |
| Earthquake information (VXSE53)                | `aichiMentioned` is true (an intensity was observed in Aichi)                                 |
| Tsunami warnings/advisories/forecasts (VTSE41) | `aichiMentioned` is true (愛知県外海 or 伊勢・三河湾 is listed)                               |
| Volcano warnings (VFVO50)                      | `aichiMentioned` is true (an Aichi municipality is listed)                                    |

`aichiMentioned` is an explicit mention only, not a risk assessment.

### What is skipped (`deliveryNote` on the row)

| Reason                     | When                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `skipped:training_or_test` | Control status is not 通常 (normally such rows are already `excluded` and never read)                    |
| `skipped:cancelled`        | InfoType 取消. The status is unknown after a cancellation; it is never sent as an all-clear              |
| `skipped:stale`            | The bulletin was published, or the row created, more than 30 minutes before the deliver call             |
| `skipped:not_relevant`     | Nagoya has no warning/advisory in effect (`発表警報・注意報はなし` or `解除`), or Aichi is not mentioned |
| `skipped:invalid_payload`  | The stored payload does not match the expected shape                                                     |

### Message

Text comes only from the stored bulletin fields; kind names are translated with a
fixed table of JMA terms, and unknown names stay in Japanese.

- Title, e.g. `名古屋市: 大雨警報・雷注意報 / Nagoya: heavy rain warning, thunderstorm advisory`,
  `名古屋市: 雷注意報（継続） / Nagoya: thunderstorm advisory (continuing)`,
  `地震情報: 愛知県で震度4 / Earthquake: intensity 4 in Aichi`,
  `津波注意報: 愛知県外海 / Tsunami advisory: Aichi outer coast`.
- Body: the JMA report time and source, e.g. `気象庁 10:05 発表 / Source: JMA, 10:05 JST`
  (earthquakes also show the epicenter and magnitude).
- Data: `deliveryKey`, `bulletinType`, `sourceUrl`, `publishedAt`, `source`,
  `alertKind`, `title`, `body`.
- Android: priority high, TTL 1 hour, collapse key and notification tag
  `jma-<bulletinType>` (a newer bulletin of the same type replaces the older one),
  channel `disaster_warnings` ("Disaster warnings", high importance).

Tapping a notification opens SEA. Warnings (警報/特別警報), tsunami and earthquake/volcano
bulletins open the existing alert screen with the nearest evacuation site;
advisories (注意報) only open the app. Sites' opening status stays unknown.

### Response of `/jobs/outbox/deliver`

```json
{
  "deliveryEnabled": true,
  "pending": 0,
  "attempted": 1,
  "sent": 1,
  "skipped": 4,
  "failed": 0
}
```

With delivery disabled, `deliveryEnabled` is false, `pending` is the backlog and
the other counts are 0. Nothing is read or changed besides the count.

## Turning it on

You need all three. Each step can be done independently, in any order.

### 1. Android: add `google-services.json`

1. [Firebase console](https://console.firebase.google.com/project/gen-lang-client-0467526025/settings/general)
   → Project settings → **Your apps** → the Android app `com.contour.app`
   (register it with that package name if it is missing) → download
   `google-services.json`.
2. Save it as `android/app/google-services.json`. Gradle applies the
   google-services plugin only when this file exists.
3. Restrict the Android API key in the file (Google Cloud console → APIs &
   Services → Credentials): Android apps `com.contour.app` with the signing
   certificate SHA-1 of the shared debug keystore and any release key, and only
   the APIs the app needs (Firebase Installations API and FCM Registration API).

The file is **public client configuration**, like any key shipped inside an APK
(AGENTS.md treats client keys as public). Committing it is fine. Without it the app
builds and runs normally; the Warning notifications row says it is not available
in this build, and Logcat shows `WarningPush: Warning push unavailable` once.

CI alternative: instead of committing the file, set the optional Cloud Build
substitution `_GOOGLE_SERVICES_JSON_B64` on the APK trigger to
`base64 -w0 google-services.json`. `android/cloudbuild.yaml` writes it to
`android/app/google-services.json` only when the substitution is set and the file
is not already in the checkout.

The app topic is `contour-aichi-warnings` (Gradle property `warningTopic`). It
must match the backend's `FCM_TOPIC`.

### 2. Google Cloud: rerun the setup script

```sh
gcloud config set project gen-lang-client-0467526025
bash infra/setup-cloud-jobs.sh
```

It is safe to rerun. For push it enables `fcm.googleapis.com` (sending) plus
`fcmregistrations.googleapis.com` and `firebaseinstallations.googleapis.com`
(used by the app to subscribe), grants
`contour-jobs-runtime` the role `roles/firebasecloudmessaging.admin`, and creates
the Firestore composite index `warningOutbox (deliveryStatus ASC, createdAt ASC)`.
Wait until the index is `READY`:

```sh
gcloud firestore indexes composite list --database='(default)'
```

The Firebase project must be the same Google Cloud project that runs
`contour-jobs` (here `gen-lang-client-0467526025`). The sender uses Application
Default Credentials, so no key file is involved.

### 3. Backend: enable delivery

```sh
gcloud run services update contour-jobs --region asia-northeast1 \
  --update-env-vars FCM_DELIVERY_ENABLED=true
```

Turn it off with `FCM_DELIVERY_ENABLED=false`. The value is strict (`true` or
`false`); anything else stops the service from starting. Rerunning the setup
script and Cloud Build deploys keep the current value. Locally, set the same
variables in `backend/.env` (see `backend/.env.example`).

## Trying it

1. Install an APK built with `google-services.json`. Open the menu → Emergency
   pop-up → **Warning notifications** → Turn on. Android 13+ asks for the
   notification permission at this point (not at app start).
2. Send a test message to the topic from the Firebase console (Messaging → New
   campaign → Notifications → target topic `contour-aichi-warnings`), or wait for a
   real JMA warning for Nagoya with the `jma-warnings` schedule running.
3. Check the outbox rows in Firestore (`warningOutbox`: `deliveryStatus`,
   `deliveryNote`) and the workflow execution result (`outbox` summary).

## Limits

- **Android only.** iOS is not covered: it needs an APNs key, a paid Apple
  Developer team and the Firebase iOS SDK in `ios/`.
- Not tested end to end on a device yet; no real `google-services.json` was used to
  build. The backend logic is covered by tests with a fake sender.
- One topic for everyone who opts in; there is no per-user location filter. A
  bulletin is chosen by Nagoya/Aichi mention, not by the user's position.
- Continuing (継続) advisories are sent again each time JMA republishes the Aichi
  bulletin; the notification tag replaces the previous one on the phone.
- Delivery is at least once in rare cases: if the service stops between sending
  and recording `sent`, the row can be sent once more after the 5-minute claim
  lease, while it is still within 30 minutes.
- At most 3 messages per minute. A burst of relevant bulletins can delay later ones
  by a few minutes; anything older than 30 minutes is skipped.
- FCM delivery itself is best effort (Doze, battery savers, no network). It does
  not replace 緊急速報 or official evacuation instructions.
