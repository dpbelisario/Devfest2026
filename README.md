# Evacuation-AR

Native Android evacuation-navigation prototype with a TypeScript/Express API for
Google Cloud Run. This replaces the previous React/FastAPI project.

## Current state

This is a prototype, not a verified evacuation system.

- Backend: health, nearby destination filtering, and saved demo-route lookup.
- Android: Contour WebView map UI, an original Compose route preview, and a native
  ARCore Geospatial screen with camera rendering, terrain anchors, tracking checks,
  and backend destination/route loading from actual device position.
- Geospatial AR requires configuration and physical-device field testing. Voice
  playback and offline navigation are not wired into the native AR screen.
- Data: one **fictional** destination and one **synthetic, unverified** route.
  Coordinates remain fixed for previews; native AR uses the actual device pose.
- This AR implementation creates no cloud resources or deployment pipelines.

## Layout

```text
android/   Kotlin/Compose application, WebView UI, native Geospatial AR, Android tests
backend/   Express API, schemas, services, fixture data, Dockerfile
docs/     Setup, deployment, sources, demo walkthrough
```

## Backend quick start

Requirements: Node.js 24 and npm.

```sh
npm ci
npm run dev
```

The API listens on port 8080. For local overrides use environment variables, e.g.
`PORT=8081 npm run dev`; `.env` files are not automatically loaded.

```sh
curl http://localhost:8080/health
curl 'http://localhost:8080/destinations?lat=35.68&lng=139.767&disaster=earthquake'
curl 'http://localhost:8080/directions?originLat=35.68&originLng=139.767&destinationId=demo-site-1'
```

Coordinates are validated. Unsupported origins return 422; unknown destinations
return 404. No dynamic routing or live hazard information is provided.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
```

## Android

Open `android/` in Android Studio with JDK 17 and Android SDK 35. Copy
`android/local.properties.example` to `android/local.properties` and set the API
URL. On the emulator use `http://10.0.2.2:8080/`; on a physical phone use an HTTPS
Cloud Run endpoint. The default URL intentionally points to example.invalid.

```sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The app opens the Contour UI (a WebView page, `WebUiActivity`); the Compose scaffold above is still
in the app as `MainActivity`. See [UI](docs/ui.md). For the native 3D AR feature,
configure a restricted ARCore key and follow [Geospatial AR setup](docs/geospatial-ar.md).

Install the debug APK using Android Studio or `adb install -r
app/build/outputs/apk/debug/app-debug.apk`. Android builds are distributed to
phones; only the backend deploys to Cloud Run.

See [setup](docs/setup.md), [deployment](docs/deployment.md),
[APK distribution](docs/apk-distribution.md), [data sources](docs/data-sources.md),
and [walkthrough](docs/demo-walkthrough.md).
