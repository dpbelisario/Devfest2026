#!/usr/bin/env bash
# Store the IndoorAtlas mobile SDK key and secret in Secret Manager so the
# APK pipeline (android/cloudbuild.yaml) builds them into Firebase releases.
# Run it in Cloud Shell with the project selected, after setup-apk-pipeline.sh:
#
#   bash android/setup-indooratlas-secrets.sh
#
# Values come from INDOORATLAS_API_KEY / INDOORATLAS_API_SECRET if set, otherwise
# you are prompted (input hidden). Values are never printed. Rerunning adds a new
# secret version, so it also rotates the credentials.
set -euo pipefail

PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] || { echo "Select a project first: gcloud config set project PROJECT_ID" >&2; exit 1; }

KEY="${INDOORATLAS_API_KEY:-}"
SECRET="${INDOORATLAS_API_SECRET:-}"
[ -n "$KEY" ] || { read -rsp "IndoorAtlas mobile SDK key (hidden): " KEY; echo; }
[ -n "$SECRET" ] || { read -rsp "IndoorAtlas mobile SDK secret (hidden): " SECRET; echo; }
for v in "$KEY" "$SECRET"; do
  if [ -z "$v" ] || printf '%s' "$v" | LC_ALL=C grep -q '[^A-Za-z0-9._~+/=-]'; then
    echo "Missing or invalid value. Nothing was stored." >&2; exit 1
  fi
done

SA_REF="$(gcloud builds get-default-service-account --project "$PROJECT" --format='value(serviceAccountEmail)')"
SA="${SA_REF##*/}"
if [ -z "$SA" ]; then
  SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
fi

store() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$name" --project "$PROJECT" --replication-policy=automatic >/dev/null
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "Stored $name (readable by $SA)"
}
store indooratlas-api-key "$KEY"
store indooratlas-api-secret "$SECRET"

echo "Done. The next android-apk-distribution build includes IndoorAtlas positioning:"
echo "  gcloud builds triggers run android-apk-distribution --project $PROJECT --branch=main"
