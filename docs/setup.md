# Local setup

## Backend

Use Node.js 24 and npm. Run `npm ci` at the repository root, then `npm run dev`.
The root npm workspace owns the lockfile. Express listens on `HOST` (default
0.0.0.0) and `PORT` (default 8080). Backend dependencies live in backend/package.json.

The backend is a public, read-only prototype. There is no account system or database.
The Android native client does not need browser CORS configuration.

## Android

1. Install Android Studio, JDK 17, SDK Platform 35, and its build tools.
2. Open android/ as the project. Use JDK 17 for Gradle (not the host's newer Java).
3. Copy local.properties.example to local.properties; Android Studio normally sets
   sdk.dir. Set EVACUATION_AR_API_BASE_URL to your backend URL with a trailing slash.
4. Start an emulator and the backend. The emulator reaches the host through
   http://10.0.2.2:8080/. A debug-only network security exception permits that host.
   Release configuration requires HTTPS.
5. Build/install through Android Studio, or use the committed Gradle wrapper.

The wrapper uses Gradle 8.11.1, Android Gradle Plugin 8.9.2, Kotlin 2.1.20, and SDK 35. It downloads the official Gradle distribution on first use. Dependencies and
SDK components also require internet during initial setup.

```sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

## Geospatial AR

The native AR screen implements ARCore session lifecycle, camera rendering, terrain anchors,
consent, runtime camera/precise-location permission requests, device support checks, and
accuracy-gated waypoint rendering. Configure a restricted Android ARCore API key and backend URL
using [Geospatial AR setup](geospatial-ar.md), then install a new APK.

Actual localization and arrow alignment require a supported physical device and outdoor field
testing. The existing route data is fictional and must not be used as evacuation guidance.
