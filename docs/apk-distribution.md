# App updates: hosted UI + automatic APK builds

The distributed app is the Contour WebView shell in `android/app`
(package `com.contour.app`). How a change reaches phones depends on what changed:

| What changed                                          | How it reaches phones                                                                            | New APK? |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| UI: `android/app/src/main/assets/contour.html`        | Backend redeploys and serves it at `/app/`; the app loads it on next launch                      | No       |
| Backend: `backend/**`                                 | Backend redeploys                                                                                | No       |
| Shell: Kotlin, manifest, permissions in `android/app` | Cloud Build builds an APK and sends it to App Distribution; testers tap **Update** in App Tester | Yes      |

The shell loads `<API base URL>/app/`. If that page fails or takes more than 8
seconds, it shows the copy of `contour.html` bundled in the APK, so the app still
opens offline. That copy is only as new as the last APK. The two copies keep separate
local storage (language, attendance sheet).

For UI changes to go live without a new APK, the backend's auto-deploy trigger must
also run when `contour.html` changes. If that trigger has an included-files filter
such as `backend/**`, add `android/app/src/main/assets/contour.html`.

Every push to `main` that changes `android/**` builds a debug APK with
[`android/cloudbuild.yaml`](../android/cloudbuild.yaml) and
uploads it to Firebase App Distribution. Testers get an email and update through the
Firebase App Tester app.

The app shows fictional demo data and is not real evacuation guidance.

## One-time setup (about 15 minutes)

**Quick path:** in Cloud Shell, with the project selected, run
[`android/setup-apk-pipeline.sh`](../android/setup-apk-pipeline.sh)
with the Firebase App ID from step 1 below. It does steps 2–5 for you (new signing key,
APIs, service account roles, trigger, first build) and is safe to rerun. The
manual steps below do the same thing.

Use the Google Cloud project that already hosts the API. Run the commands in Cloud
Shell, or in any terminal where `gcloud` is logged in, after
`gcloud config set project YOUR_PROJECT_ID`.

### 1. Register the Android app in Firebase

1. Firebase console → Project settings → **Add app** → Android.
   Package name: `com.contour.app`. Skip the `google-services.json` download, because
   the app does not use the Firebase SDK.
2. Copy the **App ID**. It looks like `1:1234567890:android:abc123`.
3. Open **App Distribution** and select Get started. Under **Testers & Groups**,
   create a group with the alias `team` and add the teammates' emails.

### 2. Store a shared debug signing key

Every build must be signed with the same key, or testers have to uninstall before
each update. Use the debug keystore from the machine that builds APKs locally, so
local builds and CI builds can update each other:

```bash
base64 -w0 ~/.android/debug.keystore | gcloud secrets create android-debug-keystore --data-file=-
```

On macOS use `base64 -i ~/.android/debug.keystore` in place of `base64 -w0 …`. If
that file does not exist, create one with
`keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -validity 10000`.
Never commit the keystore. `*.keystore` is ignored by git.

### 3. Enable APIs and grant the build service account access

```bash
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com firebaseappdistribution.googleapis.com
```

Find the service account the trigger will run as: Cloud Build → Settings, or the
trigger's **Service account** field. It is usually
`PROJECT_NUMBER-compute@developer.gserviceaccount.com`. Then:

```bash
SA=PROJECT_NUMBER-compute@developer.gserviceaccount.com
```

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:$SA" --role=roles/firebaseappdistro.admin
```

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="serviceAccount:$SA" --role=roles/logging.logWriter
```

```bash
gcloud secrets add-iam-policy-binding android-debug-keystore --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

### 4. Create the trigger

Cloud Build → Triggers → **Create trigger**:

| Field                 | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Name                  | `android-apk-distribution`                                           |
| Event                 | Push to a branch                                                     |
| Repository            | `dpbelisario/Devfest2026` (the same connection the API trigger uses) |
| Branch                | `^main$`                                                             |
| Included files filter | `android/**`                                                         |
| Configuration         | Cloud Build configuration file, `android/cloudbuild.yaml`            |
| Service account       | the `$SA` from step 3                                                |

Add these substitution variables:

| Variable           | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| `_FIREBASE_APP_ID` | the App ID from step 1                                              |
| `_API_BASE_URL`    | the deployed backend URL, ending in `/`; the app loads `<that>app/` |
| `_TESTER_GROUPS`   | `team`, or a comma-separated list of group aliases                  |

### 5. Test it

Select **Run** on the trigger, with branch `main`. A build takes about 8–12 minutes,
mostly downloading the SDK and Gradle dependencies. When it finishes, testers in the
group get an invite email.

## Tester install

1. Open the invite email on the Android phone and accept it.
2. Install **Firebase App Tester** when prompted, and allow installs from it.
3. Install the release. Later releases show up in App Tester as updates.

An APK installed earlier from another machine's debug key cannot be updated by a CI
build. Uninstall it once, then install from App Tester.

## Troubleshooting

- `Set _API_BASE_URL and _FIREBASE_APP_ID`: a substitution is missing on the trigger.
- Secret permission denied: repeat the secret binding in step 3 for the trigger's
  service account.
- `403` or "permission denied" from `appdistribution:distribute`: the service account
  lacks `roles/firebaseappdistro.admin`, or the App ID belongs to another project.
- "App not installed" on the phone: the APK was signed with a different key.
  Uninstall the old app once.
- A UI change does not show up: check that the backend redeployed and that
  `<API base URL>/app/` shows the new page in a browser, then close and reopen the app.
