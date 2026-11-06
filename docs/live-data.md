# Live data API and assistant

The public `api` service exposes the data written by the Cloud Workflows jobs
([cloud-jobs.md](cloud-jobs.md)) to the app, plus a Gemini assistant. All
routes live under `/api`, allow any origin (the APK's offline page runs on
`https://appassets.androidplatform.net`) and need no account.

| Route                                                           | What it returns                                                                                                                                                                                                                                                                                                                                                   | Cache |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `GET /api/sites?lat=&lng=&limit=20&radiusMeters=5000&disaster=` | Nearest designated emergency evacuation sites in Nagoya from `nagoyaDatasets/current:23100`, with straight-line `distanceMeters`, `bearingDegrees`, `disasters` and `openingStatus: "unknown"`. `disaster` is one of `earthquake`, `tsunami`, `flood`, `inlandFlood`, `stormSurge`, `landslide`, `fire`, `volcano`. 503 `DATA_NOT_READY` before the first import. | 5 min |
| `GET /api/alerts`                                               | Latest JMA Aichi weather bulletin (`weather.nagoya.kinds[]` with the official `status`, a `level` derived from the name and `inEffect` for 発表/継続) and up to 5 recent earthquake/tsunami/volcano bulletins. `weather.nagoya` is `null` after a cancellation: status unknown.                                                                                   | 30 s  |
| `POST /api/assistant`                                           | `{ message, language: en\|ja\|zh\|ko, location: { lat, lng, source: gps\|demo } \| null, history }` → `{ reply, sites, actions, toolCalls, model }`.                                                                                                                                                                                                              | none  |

The service keeps the decoded dataset in memory and re-reads Firestore every
5 minutes (alerts every 30 seconds), so most requests cost no Firestore reads.

## Assistant

`backend/src/services/assistantService.ts` runs Gemini (`ASSISTANT_MODEL`,
default `gemini-3.5-flash-lite`, Vertex AI in `GOOGLE_CLOUD_LOCATION`) with four
tools:

- `find_evacuation_sites` and `get_current_alerts` read the data above;
- `show_sites_on_map` and `start_ar_navigation` become `actions` the page
  applies (highlight sites, open the AR arrow). Unknown site ids are rejected.

The system prompt forbids inventing sites, warnings or opening status, asks for
short plain-text replies in the user's language and always points to official
instructions and 119/110. Requests are limited per instance to
`ASSISTANT_PER_CLIENT_PER_MINUTE` (8) per client IP and
`ASSISTANT_TOTAL_PER_MINUTE` (60) in total; over the limit returns 429.
`ASSISTANT_ENABLED=false` returns 503.

Requirements on the Cloud Run runtime service account: Firestore read
(`roles/datastore.viewer` or broader) and `roles/aiplatform.user`. The `api`
service runs as the default compute service account, which has both.

Cost: one question is usually 2–3 model calls of a few thousand input tokens on
Gemini Flash, well under a cent. The rate limits cap a runaway client.

## Local run

```bash
GOOGLE_CLOUD_PROJECT=<project> npm run dev
```

With Application Default Credentials that can read Firestore, `/api/sites`
and `/api/alerts` return real data. Without Vertex AI access, set
`ASSISTANT_ENABLED=false`. `LIVE_DATA_STORE=memory` starts with no data
(503 / empty alerts); `off` removes `/api`.

## Preview on Cloud Run

`infra/cloudbuild.preview.yaml` builds a branch and deploys it to a private
`contour-preview` service (no unauthenticated access, max 1 instance) running
as the same account as `api`. Run it from a Cloud Build trigger on `david/*`
branches, or by hand. Call it with an identity token, for example
`gcloud run services proxy contour-preview --region asia-northeast1`.
