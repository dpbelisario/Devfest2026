# Context handoff: Contour / Devfest2026 (state as of 2026-11-07)

Everything the previous session knew, for the next agent or person. Read
`AGENTS.md` and GitHub issue #3 first; this file complements them.

---

## 1. Project at a glance

- Repo: `dpbelisario/Devfest2026` (private). Owner: David (`dpbelisario`).
  Teammate fork exists at `Deadspree/Devfest2026` (do not confuse the two).
- App: **Contour**, evacuation guidance for Nagoya. Native Android shell
  (`android/`, `WebUiActivity`) shows one HTML page, `contour.html`, which the
  backend also serves at `/app/`. UI changes reach phones without a new APK.
- Backend: TypeScript + Express (`backend/`), Node 24, npm workspaces from repo root.
- Google Cloud project `gen-lang-client-0467526025` (number `223430657240`),
  region `asia-northeast1`. Public site: https://gen-lang-client-0467526025.web.app/
  (Firebase Hosting → Cloud Run `api`). App page: `/app/`.

## 2. Owner rules (must follow)

- Branches: `david/<topic>` only. **Never** `claude/...` branches.
- Never push to `main` directly. PR from a `david/` branch, then merging is allowed (squash used so far).
- No Claude / Anthropic / "Generated with" / Co-Authored-By in commits, PR titles, PR bodies, branch names.
- Commit identity: `git config user.name dpbelisario` and
  `git config user.email 224859517+dpbelisario@users.noreply.github.com`.
- Never force-push.
- If a Cloud Build fails: read its log, fix on a `david/` branch, PR, merge, confirm the next build is green.
- Never print or commit service-account keys; delete `/tmp/gcp-key.json` when done.
- After a push, post an implementation report on issue #3 (template in `AGENTS.md`).
- Owner is cost-conscious ("not burning the $20"): keep the every-minute JMA schedule **paused** unless testing.

## 3. Cloud resources (all created and verified)

| Resource                      | Name                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run (public)            | `api`                                                                                                         | Runs as `223430657240-compute@developer` (default compute SA, has editor, aiplatform.user, Firestore). Env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_LOCATION=global`. No `JOBS_ENABLED` → `/jobs` is 404. Auto-deploys from `main` via trigger `rmgpgab-api-asia-northeast1-dpbelisario-Devfest2026--mattp` (global). |
| Cloud Run (private)           | `contour-jobs`                                                                                                | Runs as `contour-jobs-runtime@…`. Env `JOBS_ENABLED=true`, `LIVE_DATA_STORE=off`. Invoked only by `contour-workflows@…`. URL `https://contour-jobs-223430657240.asia-northeast1.run.app`.                                                                                                                                                             |
| Cloud Run (private)           | `contour-preview`                                                                                             | Preview of `david/*` branches, max 1 instance, scales to zero, runs as default compute SA. URL `https://contour-preview-223430657240.asia-northeast1.run.app` (also `…px6y3ae5eq-an.a.run.app`). No invoker bindings left.                                                                                                                            |
| Cloud Workflows               | `nagoya-import`, `jma-warnings`                                                                               | Source in `infra/workflows/*.yaml`, run as `contour-workflows@…`, labelled with repo commit/sha1 for drift detection.                                                                                                                                                                                                                                 |
| Cloud Scheduler               | `nagoya-import-hourly` (ENABLED, `0 * * * *` Asia/Tokyo), `jma-warnings-every-minute` (**PAUSED** on purpose) | Resume JMA: `gcloud scheduler jobs resume jma-warnings-every-minute --location asia-northeast1`.                                                                                                                                                                                                                                                      |
| Cloud Build triggers (global) | `contour-jobs-deploy`                                                                                         | On `main`, files `backend/**, infra/workflows/**, infra/cloudbuild.jobs.yaml, infra/deploy-workflows.sh` → rebuild `contour-jobs` + redeploy workflows. Runs as `contour-jobs-deployer@…`.                                                                                                                                                            |
|                               | `android-apk-distribution`                                                                                    | On `main`, `android/**` → APK to Firebase App Distribution group `team-david`. Runs as default compute SA. Keystore secret `android-debug-keystore`.                                                                                                                                                                                                  |
|                               | `contour-preview`                                                                                             | On `^david/.*$`, files `backend/**`, `android/app/src/main/assets/contour.html`, `infra/cloudbuild.preview.yaml` → deploy `contour-preview`.                                                                                                                                                                                                          |
|                               | `rmgpgab-api-…`                                                                                               | On `main` (any file) → build + deploy `api`.                                                                                                                                                                                                                                                                                                          |
| Firestore (default, native)   | collections `nagoyaDatasets`, `nagoyaJobRuns`, `jmaWeatherSnapshots`, `jmaEqvolBulletins`, `warningOutbox`    | TTL policy on `nagoyaJobRuns.expiresAt`; single-field index exemptions for `payloadGzip` in all five. `nagoyaDatasets/current:23100` = 1735 sites.                                                                                                                                                                                                    |
| Service accounts              | `contour-jobs-runtime`, `contour-workflows`, `contour-jobs-deployer`, `claude-deployer`                       | **`claude-deployer` key should be deleted by the owner** (IAM → Service accounts → claude-deployer → Keys).                                                                                                                                                                                                                                           |

Console: [Workflows](https://console.cloud.google.com/workflows?project=gen-lang-client-0467526025) ·
[Scheduler](https://console.cloud.google.com/cloudscheduler?project=gen-lang-client-0467526025) ·
[Firestore](https://console.cloud.google.com/firestore/databases?project=gen-lang-client-0467526025) ·
[Builds](https://console.cloud.google.com/cloud-build/builds?project=gen-lang-client-0467526025) ·
[Billing reports](https://console.cloud.google.com/billing/reports?project=gen-lang-client-0467526025)

## 4. What was done (chronological)

1. **Handoff goals for n8n → Google Cloud: all met.**
   - Ran `infra/setup-cloud-jobs.sh` (first try OK). First manual runs failed with IAM `AuthError` — just IAM propagation; worked a minute later.
   - Both workflows succeeded manually; Firestore filled; schedules resumed, automatic runs succeeded; then JMA paused at owner's request.
   - `contour-jobs-deploy` first run failed: `python3` missing in `cloud-sdk:slim`. Fixed in **PR #12** (scripts fall back to `gcloud info --format='value(basic.python_location)'`). Next auto build green.
   - `bash infra/pull-workflows.sh` → no git diff.
   - APK build `fe6e1168` green; release 0.1.0 (29898261) installed by David via App Tester.
2. **Live data + map + AR + assistant — PR #13** (squash `6cee882`).
3. **Startup fix — PR #14** (squash `003e2f4`, current `main`): `contour-jobs` crashed on boot because `@google/genai` threw without `GOOGLE_CLOUD_PROJECT`. Assistant now disabled with a warning in that case; jobs service set `LIVE_DATA_STORE=off`.
4. Verified after #14: `api` (`api-00017-8nk`) and `contour-jobs` (`contour-jobs-00006-x22`) both on image `003e2f4`, builds green; APK build `568f2e7c` (from #13) green; manual `nagoya-import` and `jma-warnings` runs on new image SUCCEEDED; production `/api/*` and assistant work; `/jobs` 404 on public host.
5. Report posted on issue #3: https://github.com/dpbelisario/Devfest2026/issues/3#issuecomment-6673230385
6. Cleanup: temporary workflow `contour-preview-probe` deleted, its invoker binding removed, `/tmp/gcp-key.json` deleted, gcloud credentials revoked.

## 5. Code added (PR #13/#14) — where things live

Backend (`backend/src`):

- `services/liveDataService.ts` — reads job outputs; caches decoded Nagoya dataset (5 min) and alerts (30 s). `findSites`, `getSite`, `getAlerts`. Weather kind `level` derived from name (特別警報/警報/注意報), `inEffect` = status 発表 or 継続. Cancelled bulletin → `nagoya: null` (unknown, never all-clear).
- `services/assistantService.ts` — Gemini tool loop (max 4 rounds). Tools: `find_evacuation_sites`, `get_current_alerts`, `show_sites_on_map`, `start_ar_navigation`. Returns `{ reply, sites, actions, toolCalls, model }`. Actions: `showSites{siteIds}`, `startAr{siteId}` (unknown ids rejected). System prompt forbids inventing data / opening status; tells model to open AR on "guide me / 案内して / 带我去 / 안내해 줘".
- `services/geminiClient.ts` — `@google/genai`, Vertex AI, ADC, 20 s timeout, temperature 0.2.
- `services/rateLimiter.ts` — per-instance fixed window.
- `services/createLiveContext.ts` — wiring; assistant only if `ASSISTANT_ENABLED` and `GOOGLE_CLOUD_PROJECT` set.
- `routes/live.ts` — mounted at `/api`; CORS `*` (bundled offline page origin `https://appassets.androidplatform.net`).
- Repos: added `listRecentEqvolBulletins(limit)` to `JobsRepository` (Firestore + memory).
- `app.ts` — `trust proxy`, mounts `/api` when live context provided. `config.ts` — new env vars below.
- Tests: `backend/tests/live.test.ts` (45 tests total pass).

Endpoints:

- `GET /api/sites?lat&lng&limit(1-50, def 20)&radiusMeters(100-20000, def 5000)&disaster` — cache 5 min. 503 `DATA_NOT_READY` before first import.
- `GET /api/alerts` — cache 30 s.
- `POST /api/assistant` `{message ≤500, language en|ja|zh|ko, location{lat,lng,source gps|demo}|null, history ≤8}` — 429 rate limited, 503 disabled.

Config (`backend/.env.example`): `LIVE_DATA_STORE` (firestore|memory|off), `ASSISTANT_ENABLED`, `ASSISTANT_MODEL` (default **`gemini-3.5-flash-lite`**; `gemini-2.5-flash` returns 404 for this project; `gemini-3.5-flash` also works), `GOOGLE_CLOUD_LOCATION` (global), `ASSISTANT_PER_CLIENT_PER_MINUTE` (8), `ASSISTANT_TOTAL_PER_MINUTE` (60).

UI (`android/app/src/main/assets/contour.html`, ~3 MB because of embedded offline tiles on one line — don't `cat` it; use `awk 'length($0)<2000'`):

- `API` = page origin when hosted, else `https://gen-lang-client-0467526025.web.app`.
- Starts at demo position `USER` (Nagoya University). GPS asked only on locate button, AR, assistant (`useGps`). Positions outside `NAGOYA_BOX` keep demo.
- Map: `loadSites()` → 15 sites within 4 km, `renderPoints()` rebuilds markers/cards (only when detail sheet closed); hazard filter in settings popup (`#hzFilter`); straight dotted line for real sites; detail sheet shows "Official", capacity "Unknown".
- AR: `arPlace()` recomputes distance/bearing on each GPS fix; "You're near the site" < 25 m; weak-accuracy note > 50 m. AR FAB requests GPS so the pick list sorts from real position.
- Disaster info view `#dz` + `#alertChip` from `/api/alerts` (JST times, JMA links, refresh every 2 min).
- Assistant panel `#ask` (FAB "Ask" + drawer item), quick prompts, site chips, applies actions.
- Falls back to fictional demo points (status "Demo data · offline") if `/api/sites` fails.
- Fixed a pre-existing bug: `display:` rules overriding `[hidden]` (`.s-clear`, etc.).
- 4 languages (en/ja/zh/ko) for all new strings.

Android: `WebUiActivity.kt` — `onGeolocationPermissionsShowPrompt` grants only our origins after runtime FINE/COARSE permission; `setGeolocationEnabled(true)`.

Infra: `infra/cloudbuild.preview.yaml` (new), `infra/setup-cloud-jobs.sh` (sets `LIVE_DATA_STORE=off`), `infra/deploy-workflows.sh` + `infra/pull-workflows.sh` (`$PYTHON` fallback).

Docs: `docs/live-data.md` (new), `docs/ui.md` (Live data section, limits), `docs/cloud-jobs.md` (unchanged), README link.

## 6. How to work in this environment (gotchas learned)

- Auth: `printf '%s' "$GCP_SA_KEY_B64" | base64 -d > /tmp/gcp-key.json && chmod 600 …; gcloud auth activate-service-account --key-file=…`. **Then `unset CLOUDSDK_AUTH_ACCESS_TOKEN`** in every shell — a preset invalid token overrides the SA otherwise.
- `claude-deployer` roles: run.admin, workflows.admin, cloudscheduler.admin, cloudbuild.builds.editor, datastore.owner, iam.serviceAccountAdmin/User, projectIamAdmin, serviceUsageAdmin, artifactregistry.reader, logging.viewer. **No** storage access (so `gcloud builds submit` from local source fails → use triggers), **no** Vertex AI predict, **no** secret IAM read, **no** billing.
- Sandbox egress blocks `*.run.app`, `web.app`, `cdnjs`, OSM tiles. To call Cloud Run: deploy a tiny workflow that does `http.get/post` with `auth: {type: OIDC}` and run it (`gcloud workflows run … --data="$(cat file)"`; there is no `--data-file`). New run.invoker bindings need ~60 s to propagate.
- Local backend against real Firestore: `GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json GOOGLE_CLOUD_PROJECT=gen-lang-client-0467526025 ASSISTANT_ENABLED=false PORT=8091 node backend/dist/src/server.js` (after `npm run build`; `curl --noproxy '*'`).
- Playwright UI tests: launch with `proxy: {server: process.env.HTTPS_PROXY, bypass: "localhost"}`, route `**/leaflet/1.9.4/leaflet.js` to a local copy (`npm pack leaflet@1.9.4`), abort OSM tiles. Scripts used: scratchpad `ui/e2e.cjs`, `ui/e2e2.cjs` (not in repo).
- `npm run build` type-checks tests too (stricter than `npm run typecheck` in one case). If lint fails with missing `@eslint/js`, run `npm ci`.
- No Android SDK here; the APK Cloud Build is the compile check for Kotlin changes.
- Merges to `main` with backend changes start 2 builds (`api`, `contour-jobs-deploy`), plus APK if `android/**` changed. Watch with `gcloud builds list --region=global --filter="substitutions.COMMIT_SHA=<sha>"`.
- Creating new CI triggers was blocked by the auto-mode safety check until the user approved explicitly.

## 7. Costs

- JMA every minute ≈ $6–7/month (Workflows steps) — currently paused.
- Hourly Nagoya, Scheduler (2 jobs), Cloud Run scale-to-zero, Firestore: ≈ $0.
- Assistant: 2–3 Gemini Flash-Lite calls per question, well under a cent; rate-limited.
- Owner should set a $20 budget alert (Billing → Budgets & alerts); the agent cannot see billing.

## 8. Open items / next steps

- Field-test on real phones in Nagoya: GPS accuracy, compass heading, camera AR, permission prompts in the WebView shell.
- Owner: delete `claude-deployer` key; delete the GitHub fine-grained token `cloud-shell` if unused.
- Resume `jma-warnings-every-minute` only when testing/demoing.
- Teammate branches not merged and untouched: `feat/geospatial_AR` (native ARCore Geospatial screen, uses synthetic Tokyo routes), `feat/offlinetl` (offline translation/speech), `feat/automation` (old). Native AR could later consume `/api/sites`.
- Possible hardening: narrower SA for `api`/APK/preview builds (they use the broad default compute SA with editor); Cloud Run audience/rate limits beyond per-instance; Firebase Hosting rewrite confirmed only indirectly (web.app → api works).
- Data limits: Nagoya City only; designated sites ≠ open shelters; distances straight-line; never invent opening status or all-clear (AGENTS.md).

## 9. Key links

- PRs: #12 (python fallback), #13 (live data/map/AR/assistant), #14 (startup fix) — all merged.
- Issue #3 reports: latest https://github.com/dpbelisario/Devfest2026/issues/3#issuecomment-6673230385
- Original handoff for this work: `HANDOFF-cloud-jobs.md` (uploaded by owner; goals 1–6 complete).
