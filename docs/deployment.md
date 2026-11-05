# Manual Cloud Run deployment

Only the API deploys to Cloud Run. The Android client is installed separately.
These commands are instructions; no deployment has been performed.

Prerequisites: Google Cloud CLI, a project with billing, and permission to enable
APIs/build images/deploy Cloud Run. Choose your project and region explicitly.

From the repository root, replace the placeholder values:

```sh
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud artifacts repositories create evacuation-ar --repository-format=docker --location=asia-northeast1
```

Build with the backend Dockerfile from the repository root, then push and deploy:

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
docker build --platform linux/amd64 -f backend/Dockerfile -t asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/evacuation-ar/api .
docker push asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/evacuation-ar/api
gcloud run deploy evacuation-ar-api --image asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/evacuation-ar/api --region asia-northeast1 --allow-unauthenticated --min-instances 0 --max-instances 2 --port 8080
```

Skip repository creation if it already exists. Build context must be the repository
root: the Dockerfile needs the root npm lockfile and workspace manifest.

The public service exposes only the read-only sample endpoints. Keep privileged
future credentials in Secret Manager, grant access only to the service identity,
and do not put service-account JSON files in source or the Android app.

Set the returned HTTPS URL as EVACUATION_AR_API_BASE_URL in android/local.properties,
then rebuild the APK. Test /health and the documented sample requests against the
service. An image contains data snapshots; redeploy to update bundled JSON.
Cloud Run writable disk is temporary and is not a database.

For sharing the Android build, use direct APK installation or Firebase App
Distribution. Firebase Hosting is not required. An optional Cloud Build trigger can
build the APK on each push to main and upload it to App Distribution; see
[apk-distribution.md](apk-distribution.md).
