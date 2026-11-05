# Scheduled data jobs on Google Cloud

The two n8n workflows on `feat/automation` (`automation/n8n/workflow-1.json` and
`workflow-2.json`) are replaced by Google Cloud services:

- **Cloud Workflows** holds the pipeline. The console draws each workflow as a
  step graph, similar to the n8n canvas. Step names match the n8n node names.
- **Cloud Scheduler** starts the workflows, like the n8n schedule triggers.
- **`contour-jobs`** is a private Cloud Run service that does the work. It runs
  the same image as the public `api` service, with `JOBS_ENABLED=true`. It
  downloads, parses, validates and stores data in Firestore. The workflows only
  call it and branch on the answers.

These are scaffold jobs. Imported destinations and warnings are not verified
evacuation guidance. Unknown opening status stays unknown. Warning delivery to
phones (outbox → FCM) is still disabled.

| File                                 | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `infra/workflows/nagoya-import.yaml` | Workflow 1: Nagoya evacuation destination import            |
| `infra/workflows/jma-warnings.yaml`  | Workflow 2: JMA weather, earthquake/tsunami/volcano, outbox |
| `infra/setup-cloud-jobs.sh`          | One-time setup, safe to rerun                               |
| `infra/deploy-workflows.sh`          | Deploys the workflows and checks for console edits (drift)  |
| `infra/cloudbuild.jobs.yaml`         | Redeploys `contour-jobs` and the workflows from `main`      |
| `infra/pull-workflows.sh`            | Copies the deployed definitions back into the repo          |

## What maps to what

### `nagoya-import` (n8n workflow 1, hourly)

| n8n node(s)                                                                    | Workflows step                                            | Backend endpoint                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------ |
| Hourly JST - inactive until published                                          | Scheduler job `nagoya-import-hourly` (`0 * * * *`, Tokyo) | none                                 |
| Manual import                                                                  | **Execute** in the console, or `gcloud workflows run`     | none                                 |
| Import configuration                                                           | `import_configuration`, `check_configuration`             | none                                 |
| Download official Nagoya CSV → Extract CSV records → Validate complete dataset | `download_and_validate_dataset`                           | `POST /jobs/nagoya/fetch`            |
| Dataset valid?                                                                 | `dataset_valid` (switch)                                  | none                                 |
| Reject invalid dataset                                                         | `reject_invalid_dataset` (raise `INVALID_DATASET`)        | none                                 |
| Read current dataset state → Compare published content                         | `compare_published_content` (+ `dataset_shrank`)          | `POST /jobs/nagoya/compare`          |
| Content changed?                                                               | `content_changed` (switch)                                | none                                 |
| Save versioned snapshot → Publish current snapshot                             | `publish_current_snapshot`                                | `POST /jobs/nagoya/publish`          |
| Record successful unchanged check                                              | `record_successful_unchanged_check`                       | `POST /jobs/nagoya/record-unchanged` |
| Import summary                                                                 | `import_summary` (returned as the execution result)       | none                                 |

If the new dataset is less than half the size of the published one, the backend
answers HTTP 409 `DATASET_SHRANK`. The workflow is not retried. It fails with
`DATASET_SHRANK` and nothing is published. Fetch and compare are retried up to 3
times with backoff on HTTP 5xx, timeouts and connection errors. Publish and
record-unchanged retry only on 429/503 and connection failures, because those
mean the request was not processed.

### `jma-warnings` (n8n workflow 2, every minute)

| n8n node(s)                                                                                                                       | Workflows step                                                                           | Backend endpoint                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| Every minute - inactive until published                                                                                           | Scheduler job `jma-warnings-every-minute` (`* * * * *`, Tokyo)                           | none                             |
| Manual recovery check                                                                                                             | **Execute** with `{"mode": "recovery"}`                                                  | none                             |
| Download recent feed or hourly recovery (mode choice)                                                                             | `recent_feed_or_hourly_recovery`: `recovery` at minute 00 Tokyo time, otherwise `recent` | none                             |
| Three outputs of the trigger                                                                                                      | `fan_out_feeds` (parallel, three branches)                                               | none                             |
| Parse Atom XML → Select Aichi bulletins → Read current Aichi snapshot → Skip seen or older bulletin                               | branch `aichi_weather_warnings`: `select_aichi_bulletins`                                | `POST /jobs/jma/weather/check`   |
| Download official bulletin → Parse → Validate municipality statuses → Prepare/Queue weather handoff → Save/Publish Aichi snapshot | `new_aichi_bulletin` → `validate_municipality_statuses`                                  | `POST /jobs/jma/weather/process` |
| Parse earthquake volcano Atom → Read stored bulletins → Select unseen earthquake tsunami volcano                                  | branch `earthquake_tsunami_volcano`: `select_unseen_earthquake_tsunami_volcano`          | `POST /jobs/jma/eqvol/check`     |
| Process each disaster bulletin → Download → Parse → Normalize → Prepare/Queue disaster handoff → Store                            | `process_each_disaster_bulletin` (loop) → `normalize_earthquake_tsunami_volcano`         | `POST /jobs/jma/eqvol/process`   |
| Cloud Run delivery configuration → Read pending warning handoffs → Deliver each warning handoff → Record acknowledgement          | branch `deliver_warning_handoffs`: `send_warning_to_cloud_run`                           | `POST /jobs/outbox/deliver`      |
| Warning import summary / Disaster import summary / Warning handoff summary                                                        | `update_summary` (returned as the execution result)                                      | none                             |

Every call has its own timeout of 15–20 seconds. Checks retry twice on HTTP
5xx, timeouts or connection errors. Processing steps retry once on 429/503 or
connection failures. After 40 seconds the loop stops processing earthquake,
tsunami and volcano candidates. The rest stay unseen, so the next run picks them
up. The result reports them as `eqvolDeferred`. This keeps each run well under
the one-minute schedule. Overlapping runs are still possible, so the backend
must tolerate them (see the backend contract below).

If any branch fails, the other branches still finish. The execution then fails
with `BRANCH_FAILED`, and the error includes the results that did succeed.

### Backend contract

Every call is `POST` with a JSON body to the `contour-jobs` URL. Authentication
is a Google OIDC token from the `contour-workflows` service account, with the
service URL as the audience. The service is deployed with
`--no-allow-unauthenticated`. The request and response shapes are in the
workflow files. The workflows also expect the following:

- **Response bodies.** Responses are JSON with `Content-Type: application/json`,
  so Workflows parses them into maps. `errors[]` and the candidate objects should
  stay small (keep `errors[]` to about 20 entries). One execution can hold at
  most 512 KB of variables.
- **Missing values.** `weather/check` returns `{"candidate": null}` when there is
  nothing new. `eqvol/check` returns `{"candidates": []}`, with at most 9 items.
- **Idempotency.** `publish` and `record-unchanged` must be safe to repeat for the
  same `runId`. `weather/process` and `eqvol/process` must be safe to repeat for
  the same candidate. Overlapping per-minute runs can call them twice.
- **Errors.** HTTP 409 with `{"error":"DATASET_SHRANK"}` is only for the shrink
  guard. Other 4xx responses are not retried. Responses must not contain
  internal error details.

## Viewing graphs and executions

1. Open **Workflows** in the console (region `asia-northeast1`):
   `https://console.cloud.google.com/workflows?project=gen-lang-client-0467526025`.
2. Select `nagoya-import` or `jma-warnings`. The **Source** tab shows the code and
   the step graph side by side.
3. The **Executions** tab lists runs with their argument, result or error. Open a
   run to see the steps it took. The workflows use detailed execution history,
   which also records variable values.
4. To run once by hand, choose **Execute**. Pass `{}`, `{"mode":"recovery"}`, or
   `{"baseUrl":"https://..."}` to call another backend. From Cloud Shell:

   ```sh
   gcloud workflows run nagoya-import --location asia-northeast1
   gcloud workflows run jma-warnings --location asia-northeast1 --data='{"mode":"recent"}'
   ```

Schedules are under **Cloud Scheduler**. Use **Force run** to start a run now.

## Publish and unpublish

New Scheduler jobs are created paused, like unpublished n8n workflows. Rerunning
the setup script does not change a job's paused or running state.

```sh
# Publish (start the schedules)
gcloud scheduler jobs resume nagoya-import-hourly --location asia-northeast1
gcloud scheduler jobs resume jma-warnings-every-minute --location asia-northeast1

# Unpublish (stop them)
gcloud scheduler jobs pause nagoya-import-hourly --location asia-northeast1
gcloud scheduler jobs pause jma-warnings-every-minute --location asia-northeast1
```

Before you resume the JMA job, check that the backend endpoints are deployed and
that a manual run succeeds. Otherwise every minute adds a failed execution.

## One-time setup

You need Project Owner on `gen-lang-client-0467526025`, or equivalent roles:
Service Usage Admin, Project IAM Admin, Service Account Admin, Cloud Run Admin,
Workflows Admin, Cloud Scheduler Admin, Cloud Build Editor and Cloud Datastore
Owner. You also need permission to act as the new service accounts. The GitHub
connection for `dpbelisario/Devfest2026` must exist in Cloud Build. The existing
`api` trigger already uses it.

The backend must include the `/jobs/*` endpoints before the workflows can
succeed. Run the setup after that code is on `main` and the `api` image is
rebuilt.

In Cloud Shell, from a checkout of `main`:

```sh
gcloud config set project gen-lang-client-0467526025
bash infra/setup-cloud-jobs.sh
```

The script does the following:

1. Enables the Workflows, Workflow Executions, Cloud Scheduler, Firestore, Cloud
   Run, Cloud Build, Artifact Registry and IAM APIs.
2. Creates the Firestore Native database `(default)` in `asia-northeast1`, but
   only if no database exists.
3. Creates three service accounts:
   - `contour-jobs-runtime` gets `roles/datastore.user` and runs the Cloud Run
     service.
   - `contour-workflows` gets `roles/run.invoker` on `contour-jobs` only,
     `roles/logging.logWriter`, and `roles/workflows.invoker`. Workflows run as
     this account, and Scheduler starts them with it.
   - `contour-jobs-deployer` is the Cloud Build account. It gets
     `roles/run.developer`, `roles/workflows.editor`,
     `roles/artifactregistry.writer` and `roles/logging.logWriter`, plus
     `roles/iam.serviceAccountUser` on the two accounts above.
4. Deploys `contour-jobs` from the image the `api` service currently runs. It is
   private, with min 0 and max 2 instances and a 300 s timeout. An existing
   service keeps its image unless you set `REDEPLOY_JOBS=1`.
5. Deploys both workflows with `JOBS_BASE_URL` set to the `contour-jobs` URL.
6. Creates both Scheduler jobs in the paused state.
7. Creates the Cloud Build trigger `contour-jobs-deploy`.
8. Prints links to the graphs and the resume commands.

## Keeping the repo and the console in sync

The repo is the source of truth. The `contour-jobs-deploy` trigger runs
`infra/cloudbuild.jobs.yaml` on every push to `main` that touches `backend/**`,
`infra/workflows/**`, `infra/cloudbuild.jobs.yaml` or `infra/deploy-workflows.sh`.
The build does the following:

1. Builds `backend/Dockerfile` and pushes it as `<api repository>/contour-jobs:<commit>`.
2. Redeploys `contour-jobs` with that image. The service account, environment
   variables and private access stay as they are.
3. Redeploys every workflow in `infra/workflows/`. Each deploy labels the
   workflow with the SHA-1 of its source (`repo-source-sha1`) and the commit
   (`repo-commit`). Before overwriting, the build hashes the deployed source
   again. If the hash does not match the label, someone edited the workflow in
   the console. The build log then shows a warning and a unified diff from the
   deployed definition to the incoming repo version, and the build overwrites
   the workflow anyway. Set the trigger substitution `_FAIL_ON_DRIFT=true` to
   stop the build instead.

To keep an edit made in the console:

```sh
bash infra/pull-workflows.sh              # writes infra/workflows/*.yaml from the deployed versions
npx prettier --write infra/workflows
git diff -- infra/workflows               # review, then commit and merge to main
```

Limits of this sync:

- Console edits are lost on the next deploy unless you pull and commit them
  first. The drift warning appears only in the Cloud Build log, after the fact.
- The diff compares the deployed source with the incoming repo version. It mixes
  console edits with repo changes, because the build has no git history for the
  exact version it deployed last. Use the `repo-commit` label to look that
  version up.
- After a pull, Prettier formatting differences can cause one harmless drift
  warning on the next deploy.
- Only workflow source is synced. Console changes to Scheduler jobs, IAM, the
  workflows' service account or environment variables are not pulled back.
  Rerunning `infra/setup-cloud-jobs.sh` reapplies the service accounts and
  roles, and the next deploy resets the workflow settings. The setup script also
  resets Scheduler URIs and schedules, but leaves their paused state alone.
- A failed deploy of one workflow does not roll back `contour-jobs`.

## Cost estimate

Prices were checked on 2026-11-05 on the
[Workflows pricing page](https://cloud.google.com/workflows/pricing) and the
[Cloud Scheduler pricing page](https://cloud.google.com/scheduler/pricing). They
can change.

- **Workflows.** Every executed step is billed, including retries and steps that
  fail. Calls to `*.run.app` count as internal steps. Internal steps are free
  for the first 5,000 per month and then cost $0.01 per 1,000. External steps
  are free for the first 2,000 and then cost $0.025 per 1,000. The JMA job runs
  about 43,200 times a month (60 × 24 × 30). A quiet run executes roughly 15
  steps, which is about 650,000 steps and roughly **$6–7 a month**. Runs that
  process bulletins cost a little more. The hourly Nagoya job adds about 720
  runs × about 10 steps, which is close to free. The pricing page does not
  mention a separate charge for detailed execution history; that is not
  verified.
- **Cloud Scheduler.** Each billing account gets 3 free jobs, then each job costs
  $0.10 per month. These are 2 jobs.
- **Cloud Run, Firestore and Cloud Build.** About 130,000 requests a month to
  `contour-jobs`, with scale to zero, plus a few Firestore reads and writes per
  run and one image build per backend push. This should fit in or near the
  free tiers, but those numbers are not verified here. Check the billing reports
  after the first week.

Pausing the JMA Scheduler job stops nearly all of these costs.

## Not done yet

- The setup script has not been run, and nothing is deployed. The scripts were
  validated offline only: `bash -n`, YAML parsing, the SchemaStore Workflows
  schema, and gcloud flag checks.
- The `/jobs/*` backend endpoints are developed separately and must be deployed
  before the workflows can succeed.
- Outbox delivery is disabled (`deliveryEnabled: false`). Firebase sending and
  Android reception are not implemented.
