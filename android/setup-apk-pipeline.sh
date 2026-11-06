#!/usr/bin/env bash
# One-time setup for the automatic APK pipeline (android/cloudbuild.yaml).
# Run it in Cloud Shell with the project selected:
#
#   bash setup-apk-pipeline.sh FIREBASE_APP_ID
#
# FIREBASE_APP_ID is the Android app's App ID from Firebase project settings,
# for example 1:1234567890:android:abc123 (package com.contour.app).
# Optional environment overrides: API_BASE_URL, TESTER_GROUPS.
#
# Safe to rerun: existing secret, role bindings and trigger are kept.
set -euo pipefail

APP_ID="${1:?Usage: bash setup-apk-pipeline.sh FIREBASE_APP_ID}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] || { echo "Select a project first: gcloud config set project PROJECT_ID" >&2; exit 1; }
API_BASE_URL="${API_BASE_URL:-https://${PROJECT}.web.app/}"
TESTER_GROUPS="${TESTER_GROUPS:-team}"
TRIGGER=android-apk-distribution
SECRET=android-debug-keystore

echo "Project: $PROJECT | API: $API_BASE_URL | Testers: $TESTER_GROUPS"

echo "1/5 Enabling APIs"
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com \
  firebaseappdistribution.googleapis.com --project "$PROJECT"

echo "2/5 Finding the Cloud Build service account"
SA_REF="$(gcloud builds get-default-service-account --project "$PROJECT" --format='value(serviceAccountEmail)')"
SA="${SA_REF##*/}"
if [ -z "$SA" ]; then
  NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  SA="${NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "    $SA"

echo "3/5 Shared debug signing key (Secret Manager: $SECRET)"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "    exists, keeping it"
else
  TMP="$(mktemp -d)"
  keytool -genkeypair -keystore "$TMP/debug.keystore" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA \
    -keysize 2048 -validity 10000 -noprompt >/dev/null
  base64 -w0 "$TMP/debug.keystore" |
    gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy=automatic --data-file=-
  rm -rf "$TMP"
fi

echo "4/5 Granting the service account access"
for role in roles/firebaseappdistro.admin roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role="$role" --condition=None >/dev/null
done
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null

echo "5/5 Trigger: $TRIGGER"
if gcloud builds triggers describe "$TRIGGER" --project "$PROJECT" >/dev/null 2>&1; then
  echo "    exists, keeping it (edit it in the console to change settings)"
else
  gcloud builds triggers create github --project "$PROJECT" --name="$TRIGGER" \
    --repo-owner=dpbelisario --repo-name=Devfest2026 --branch-pattern='^main$' \
    --build-config=android/cloudbuild.yaml \
    --included-files='android/**' \
    --substitutions="_FIREBASE_APP_ID=${APP_ID},_API_BASE_URL=${API_BASE_URL},_TESTER_GROUPS=${TESTER_GROUPS}" \
    --service-account="projects/${PROJECT}/serviceAccounts/${SA}"
fi

echo "Starting the first build"
gcloud builds triggers run "$TRIGGER" --project "$PROJECT" --branch=main --format='value(metadata.build.logUrl)'
echo "Done. Testers in '$TESTER_GROUPS' get an invite when the build finishes (about 10 minutes)."
