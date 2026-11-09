#!/usr/bin/env bash
# One-time setup for the scheduled data jobs that replace the n8n workflows:
# Firestore, service accounts, the private contour-jobs Cloud Run service, two
# Cloud Workflows (the node graphs), paused Cloud Scheduler jobs and the Cloud
# Build trigger that keeps them in sync with main. It also prepares warning push
# (FCM API, sender role, outbox index) but leaves FCM_DELIVERY_ENABLED off. Run it in Cloud Shell from the
# repository root with the project selected:
#
#   gcloud config set project gen-lang-client-0467526025
#   bash infra/setup-cloud-jobs.sh
#
# Optional environment overrides: REGION (asia-northeast1), API_SERVICE (api),
# JOBS_SERVICE (contour-jobs), REDEPLOY_JOBS=1 to redeploy contour-jobs from the
# current api image even if it already exists.
#
# Safe to rerun: existing database, index, accounts, service (including its
# FCM_DELIVERY_ENABLED value), schedules (including their paused/resumed state)
# and trigger are kept; IAM bindings are re-applied and the workflows are
# redeployed from this checkout. Docs: docs/cloud-jobs.md and
# docs/push-notifications.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] || { echo "Select a project first: gcloud config set project PROJECT_ID" >&2; exit 1; }
REGION="${REGION:-asia-northeast1}"
API_SERVICE="${API_SERVICE:-api}"
JOBS_SERVICE="${JOBS_SERVICE:-contour-jobs}"
TIME_ZONE=Asia/Tokyo
TRIGGER=contour-jobs-deploy
RUNTIME_SA="contour-jobs-runtime@${PROJECT}.iam.gserviceaccount.com"
WORKFLOWS_SA="contour-workflows@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER_SA="contour-jobs-deployer@${PROJECT}.iam.gserviceaccount.com"
CONSOLE="https://console.cloud.google.com"

echo "Project: $PROJECT | Region: $REGION | Jobs service: $JOBS_SERVICE"

echo "1/9 Enabling APIs"
gcloud services enable workflows.googleapis.com workflowexecutions.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  fcm.googleapis.com fcmregistrations.googleapis.com firebaseinstallations.googleapis.com \
  --project "$PROJECT"

echo "2/9 Firestore database (default)"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT" \
  --format='value(type,locationId)' 2>/dev/null; then
  echo "    exists, keeping it (the backend expects FIRESTORE_NATIVE)"
else
  gcloud firestore databases create --database='(default)' --location="$REGION" \
    --type=firestore-native --project "$PROJECT"
fi
# Warning push reads pending outbox rows oldest first (deliveryStatus ==, createdAt order).
if index_out="$(gcloud firestore indexes composite create --project "$PROJECT" \
  --database='(default)' --collection-group=warningOutbox --query-scope=COLLECTION \
  --field-config=field-path=deliveryStatus,order=ascending \
  --field-config=field-path=createdAt,order=ascending --async 2>&1)"; then
  echo "    warningOutbox index (deliveryStatus, createdAt): building in the background"
elif grep -qi "already exists" <<<"$index_out"; then
  echo "    warningOutbox index (deliveryStatus, createdAt): exists"
else
  echo "$index_out" >&2; exit 1
fi

echo "3/9 Service accounts"
ensure_sa() {
  local id="$1" title="$2"
  if gcloud iam service-accounts describe "${id}@${PROJECT}.iam.gserviceaccount.com" \
    --project "$PROJECT" >/dev/null 2>&1; then
    echo "    ${id}: exists"
  else
    gcloud iam service-accounts create "$id" --project "$PROJECT" --display-name="$title"
  fi
}
ensure_sa contour-jobs-runtime "contour-jobs Cloud Run runtime"
ensure_sa contour-workflows "Cloud Workflows and Scheduler for contour jobs"
ensure_sa contour-jobs-deployer "Cloud Build deployer for contour jobs"

project_role() {
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" \
    --role="$2" --condition=None >/dev/null
  echo "    $1 -> $2"
}
echo "4/9 Project roles"
project_role "$RUNTIME_SA" roles/datastore.user
# Sends warning pushes to the FCM topic (only used when FCM_DELIVERY_ENABLED=true).
project_role "$RUNTIME_SA" roles/firebasecloudmessaging.admin
project_role "$WORKFLOWS_SA" roles/logging.logWriter
project_role "$WORKFLOWS_SA" roles/workflows.invoker
project_role "$DEPLOYER_SA" roles/run.developer
project_role "$DEPLOYER_SA" roles/workflows.editor
project_role "$DEPLOYER_SA" roles/artifactregistry.writer
project_role "$DEPLOYER_SA" roles/logging.logWriter
# The deployer deploys the service and workflows as these two accounts.
for sa in "$RUNTIME_SA" "$WORKFLOWS_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa" --project "$PROJECT" \
    --member="serviceAccount:$DEPLOYER_SA" --role=roles/iam.serviceAccountUser >/dev/null
  echo "    $DEPLOYER_SA -> roles/iam.serviceAccountUser on $sa"
done

echo "5/9 Private Cloud Run service $JOBS_SERVICE"
API_IMAGE="$(gcloud run services describe "$API_SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].image)')"
[ -n "$API_IMAGE" ] || { echo "Could not read the image of Cloud Run service $API_SERVICE." >&2; exit 1; }
echo "    $API_SERVICE image: $API_IMAGE"
# Artifact Registry path for CI images: drop the digest or tag and the image name.
IMAGE_NO_DIGEST="${API_IMAGE%%@*}"
IMAGE_NAME_TAG="${IMAGE_NO_DIGEST##*/}"
IMAGE_REPO="${IMAGE_NO_DIGEST%/*}"
case "$IMAGE_REPO" in
  *-docker.pkg.dev/*) ;;
  *) echo "    WARNING: $IMAGE_REPO is not Artifact Registry; CI builds will push there anyway." ;;
esac
echo "    CI image path: $IMAGE_REPO/$JOBS_SERVICE (from ${IMAGE_NAME_TAG})"

if gcloud run services describe "$JOBS_SERVICE" --project "$PROJECT" --region "$REGION" \
  >/dev/null 2>&1 && [ "${REDEPLOY_JOBS:-0}" != 1 ]; then
  echo "    exists, keeping its image (Cloud Build updates it; REDEPLOY_JOBS=1 to force)"
  gcloud run services update "$JOBS_SERVICE" --project "$PROJECT" --region "$REGION" \
    --service-account "$RUNTIME_SA" --update-env-vars JOBS_ENABLED=true,LIVE_DATA_STORE=off --quiet >/dev/null
else
  gcloud run deploy "$JOBS_SERVICE" --project "$PROJECT" --region "$REGION" \
    --image "$API_IMAGE" --service-account "$RUNTIME_SA" --no-allow-unauthenticated \
    --update-env-vars JOBS_ENABLED=true,LIVE_DATA_STORE=off --min-instances 0 --max-instances 2 \
    --timeout 300 --quiet
fi
gcloud run services add-iam-policy-binding "$JOBS_SERVICE" --project "$PROJECT" \
  --region "$REGION" --member="serviceAccount:$WORKFLOWS_SA" --role=roles/run.invoker >/dev/null
echo "    $WORKFLOWS_SA -> roles/run.invoker on $JOBS_SERVICE only"

echo "6/9 Workflows"
PROJECT="$PROJECT" REGION="$REGION" JOBS_SERVICE="$JOBS_SERVICE" WORKFLOWS_SA="$WORKFLOWS_SA" \
  bash "$ROOT/infra/deploy-workflows.sh"

echo "7/9 Scheduler jobs (new jobs start PAUSED, like unpublished n8n workflows)"
ensure_schedule() {
  local job="$1" workflow="$2" schedule="$3" retries="$4" description="$5"
  local uri="https://workflowexecutions.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/workflows/${workflow}/executions"
  local common=(--project "$PROJECT" --location "$REGION" --uri "$uri" --http-method POST
    --message-body '{"argument":"{}"}' --oauth-service-account-email "$WORKFLOWS_SA"
    --time-zone "$TIME_ZONE" --max-retry-attempts "$retries" --description "$description")
  if gcloud scheduler jobs describe "$job" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$job" "${common[@]}" --schedule "$schedule" >/dev/null
  else
    # Create with a once-a-year placeholder schedule, pause, then set the real one,
    # so a per-minute job cannot fire before it is paused.
    gcloud scheduler jobs create http "$job" "${common[@]}" --schedule "0 0 1 1 *" >/dev/null
    gcloud scheduler jobs pause "$job" --project "$PROJECT" --location "$REGION" >/dev/null
    gcloud scheduler jobs update http "$job" "${common[@]}" --schedule "$schedule" >/dev/null
    if [ "$(gcloud scheduler jobs describe "$job" --project "$PROJECT" --location "$REGION" \
      --format='value(state)')" != PAUSED ]; then
      gcloud scheduler jobs pause "$job" --project "$PROJECT" --location "$REGION" >/dev/null
    fi
  fi
  echo "    $job ($schedule $TIME_ZONE -> $workflow): $(gcloud scheduler jobs describe "$job" \
    --project "$PROJECT" --location "$REGION" --format='value(state)')"
}
ensure_schedule nagoya-import-hourly nagoya-import "0 * * * *" 1 \
  "Hourly Nagoya evacuation destination import (n8n workflow 1)"
ensure_schedule jma-warnings-every-minute jma-warnings "* * * * *" 0 \
  "Every-minute JMA weather and earthquake/tsunami/volcano check (n8n workflow 2)"

echo "8/9 Cloud Build trigger: $TRIGGER"
if gcloud builds triggers describe "$TRIGGER" --project "$PROJECT" >/dev/null 2>&1; then
  echo "    exists, keeping it (edit it in the console to change settings)"
else
  gcloud builds triggers create github --project "$PROJECT" --name="$TRIGGER" \
    --description="Redeploy contour-jobs and Cloud Workflows from main (docs/cloud-jobs.md)" \
    --repo-owner=dpbelisario --repo-name=Devfest2026 --branch-pattern='^main$' \
    --build-config=infra/cloudbuild.jobs.yaml \
    --included-files='backend/**,infra/workflows/**,infra/cloudbuild.jobs.yaml,infra/deploy-workflows.sh' \
    --substitutions="_REGION=${REGION},_IMAGE_REPO=${IMAGE_REPO},_JOBS_SERVICE=${JOBS_SERVICE},_WORKFLOWS_SA=${WORKFLOWS_SA}" \
    --service-account="projects/${PROJECT}/serviceAccounts/${DEPLOYER_SA}"
fi

echo "9/9 Done. Everything is deployed; both schedules stay paused until you resume them."
cat <<EOF

Graphs (Source tab shows the step diagram) and executions:
  nagoya-import: $CONSOLE/workflows/workflow/$REGION/nagoya-import/source?project=$PROJECT
                 $CONSOLE/workflows/workflow/$REGION/nagoya-import/executions?project=$PROJECT
  jma-warnings:  $CONSOLE/workflows/workflow/$REGION/jma-warnings/source?project=$PROJECT
                 $CONSOLE/workflows/workflow/$REGION/jma-warnings/executions?project=$PROJECT
  Scheduler:     $CONSOLE/cloudscheduler?project=$PROJECT

Test once by hand (no schedule needed):
  gcloud workflows run nagoya-import --location $REGION
  gcloud workflows run jma-warnings --location $REGION --data='{"mode":"recent"}'

Publish (start the schedules):
  gcloud scheduler jobs resume nagoya-import-hourly --location $REGION
  gcloud scheduler jobs resume jma-warnings-every-minute --location $REGION

Unpublish (stop them again):
  gcloud scheduler jobs pause nagoya-import-hourly --location $REGION
  gcloud scheduler jobs pause jma-warnings-every-minute --location $REGION

Warning push to Android (docs/push-notifications.md) is OFF. After the outbox
index shows READY (gcloud firestore indexes composite list) and the app build
has google-services.json, turn it on with:
  gcloud run services update $JOBS_SERVICE --region $REGION --update-env-vars FCM_DELIVERY_ENABLED=true
Turn it off again with FCM_DELIVERY_ENABLED=false.
EOF
