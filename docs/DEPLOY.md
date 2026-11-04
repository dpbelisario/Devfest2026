# Deploying

```
Browser ──► Firebase Hosting (frontend/dist, CDN)
               └─ /api/** rewrite ──► Cloud Run service "api" (backend/, asia-northeast1)
                                          └─ Gemini via Vertex AI (service account, no API key)
```

The frontend and the API share one domain (`https://PROJECT_ID.web.app`), so the
frontend calls relative URLs like `fetch("/api/health")` and needs no CORS setup.

## One-time setup

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) and
   Node 22+, then:

   ```bash
   gcloud auth login
   gcloud config set project PROJECT_ID
   gcloud config set run/region asia-northeast1
   npm i -g firebase-tools
   firebase login
   ```

2. Enable the APIs (once per project):

   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com
   ```

3. In the [Firebase console](https://console.firebase.google.com), choose
   **Add project** and pick the existing GCP project, then from the repo root:

   ```bash
   firebase use --add   # pick the project, alias "default"; commits .firebaserc
   ```

## Deploy the backend first

The frontend rewrite targets the `api` service, so it must exist first.

```bash
cd backend
gcloud run deploy api --source . --allow-unauthenticated
```

Answer yes when asked to create an Artifact Registry repo. When it finishes, check
that `<printed URL>/api/health` returns `{"ok":true}`.

## Deploy the frontend

```bash
cd frontend && npm ci && npm run build && cd ..
firebase deploy --only hosting
```

Open `https://PROJECT_ID.web.app/api/health`. If it returns `{"ok":true}`, the
frontend and backend are wired together.

## Continuous deployment

- **Backend:** in the Cloud Run console, open `api` → **Set up continuous
  deployment** → connect GitHub → branch `^main$`, build type Dockerfile, source
  location `/backend/Dockerfile`. This creates a Cloud Build trigger, so no keys go
  into GitHub.
- **Frontend:** run `firebase init hosting:github` from the repo root. Use
  `cd frontend && npm ci && npm run build` as the build script. It writes GitHub
  Actions for deploy on merge to `main` and a preview URL per PR.

## Local development

```bash
# Terminal 1: API on :8080
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8080

# Terminal 2: frontend on :5173, proxies /api to :8080
cd frontend && npm install && npm run dev
```

## Checks

```bash
cd backend && uv run black --check app tests && uv run flake8 app tests && uv run pytest
cd frontend && npm run format:check && npm run lint && npm run build
```

## Common first-deploy errors

| Error | Fix |
| --- | --- |
| Container failed to start / port | Server must listen on `0.0.0.0:$PORT` (the Dockerfile does this) |
| Permission denied during build | Grant the role named in the error to the Cloud Build service account |
| `/api/...` returns `index.html` | The `/api/**` rewrite must come before `**` in `firebase.json` |
| Rewrite to Cloud Run 404s | `serviceId`/`region` in `firebase.json` must match the deployed service |
| Gemini 403 | Grant the Cloud Run service account the **Vertex AI User** role |
