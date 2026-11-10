# Evacuation-AR

Native Android evacuation-navigation prototype with a TypeScript/Express API for
Google Cloud Run. This replaces the previous React/FastAPI project.

## Current state

This commit scaffolds the project, not a functioning evacuation system.

- Backend: health, nearby destination filtering, and saved demo-route lookup.
- Android: Compose destination list and route preview, loading/empty/error states,
  and a configurable HTTP client.
- Integration boundaries: ARCore session, renderer, speech, compass sensors, and
  cache. These are not yet wired into navigation. ARCore is a declared dependency;
  no actual geospatial tracking, camera rendering, map, or voice playback is implemented.
- Data: one **fictional** destination and one **synthetic, unverified** route.
  Coordinates are fixed for preview; the app does not read the user's location.
- No cloud resources, credentials, database, or CI/CD pipelines are created.

## Layout

```text
android/   Kotlin/Compose application, AR boundaries, Android tests
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
in the app as `MainActivity`. See [UI](docs/ui.md).

Install the debug APK using Android Studio or `adb install -r
app/build/outputs/apk/debug/app-debug.apk`. Android builds are distributed to
phones; only the backend deploys to Cloud Run.

See [setup](docs/setup.md), [deployment](docs/deployment.md),
[APK distribution](docs/apk-distribution.md), [live data API and assistant](docs/live-data.md),
[warning push notifications](docs/push-notifications.md) (opt-in, off by default), [data sources](docs/data-sources.md),
and [walkthrough](docs/demo-walkthrough.md).
