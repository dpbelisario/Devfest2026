#!/usr/bin/env bash
# Deploy every infra/workflows/*.yaml as a Cloud Workflow of the same name.
# Used by infra/setup-cloud-jobs.sh and by Cloud Build (infra/cloudbuild.jobs.yaml).
#
# Drift check: each deploy labels the workflow with the SHA-1 of the repo file
# it came from. Before overwriting, the deployed source is hashed again; if it
# no longer matches the label, someone edited it in the console. The script then
# prints a diff and overwrites it anyway (the repo is the source of truth),
# unless FAIL_ON_DRIFT=true. Pull console edits first: bash infra/pull-workflows.sh
#
# Environment (all optional except where noted):
#   PROJECT        project ID (default: gcloud config)
#   REGION         default asia-northeast1
#   JOBS_SERVICE   Cloud Run service the workflows call (default contour-jobs)
#   JOBS_BASE_URL  its HTTPS URL (default: looked up from JOBS_SERVICE)
#   WORKFLOWS_SA   service account email the workflows run as
#                  (default contour-workflows@PROJECT.iam.gserviceaccount.com)
#   COMMIT         commit recorded in the repo-commit label (default: git HEAD or "manual")
#   FAIL_ON_DRIFT  "true" to stop instead of overwriting console edits
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Set PROJECT or run: gcloud config set project PROJECT_ID" >&2; exit 1; }
REGION="${REGION:-asia-northeast1}"
# python3 for small JSON/hash helpers. The cloud-sdk:slim image used by Cloud
# Build has no python3 on PATH, so fall back to the Python that gcloud bundles.
PYTHON="${PYTHON:-$(command -v python3 || gcloud info --format='value(basic.python_location)' 2>/dev/null || true)}"
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || { echo "python3 not found (set PYTHON)." >&2; exit 1; }
JOBS_SERVICE="${JOBS_SERVICE:-contour-jobs}"
WORKFLOWS_SA="${WORKFLOWS_SA:-contour-workflows@${PROJECT}.iam.gserviceaccount.com}"
FAIL_ON_DRIFT="${FAIL_ON_DRIFT:-false}"
COMMIT="${COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo manual)}"
COMMIT="$(printf '%s' "$COMMIT" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | cut -c1-63)"

if [ -z "${JOBS_BASE_URL:-}" ]; then
  JOBS_BASE_URL="$(gcloud run services describe "$JOBS_SERVICE" --project "$PROJECT" \
    --region "$REGION" --format='value(status.url)')"
fi
JOBS_BASE_URL="${JOBS_BASE_URL%/}"
[ -n "$JOBS_BASE_URL" ] || { echo "Could not find the $JOBS_SERVICE URL." >&2; exit 1; }

# SHA-1 of a file, ignoring trailing newlines (the API may add or drop one).
source_hash() {
  "$PYTHON" -c 'import hashlib,sys
t = open(sys.argv[1], encoding="utf-8").read().rstrip("\n") + "\n"
print(hashlib.sha1(t.encode("utf-8")).hexdigest())' "$1"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
drifted=0

for file in "$ROOT"/infra/workflows/*.yaml; do
  name="$(basename "$file" .yaml)"
  new_hash="$(source_hash "$file")"
  echo "--- Workflow $name"

  if gcloud workflows describe "$name" --project "$PROJECT" --location "$REGION" \
    --format=json >"$TMP/$name.json" 2>/dev/null; then
    "$PYTHON" -c 'import json,sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
open(sys.argv[2], "w", encoding="utf-8").write(d.get("sourceContents", ""))
labels = d.get("labels") or {}
print(labels.get("repo-source-sha1", ""), labels.get("repo-commit", "unknown"))' \
      "$TMP/$name.json" "$TMP/$name.deployed.yaml" >"$TMP/$name.labels"
    read -r label_hash label_commit <"$TMP/$name.labels" || true
    deployed_hash="$(source_hash "$TMP/$name.deployed.yaml")"

    if [ "$deployed_hash" != "${label_hash:-}" ] && [ "$deployed_hash" != "$new_hash" ]; then
      drifted=1
      echo "WARNING: deployed $name differs from the repo version last deployed" \
        "(commit ${label_commit:-unknown}); it was probably edited in the console."
      echo "Diff from the deployed definition to the repo version about to replace it:"
      diff -u --label "deployed/$name.yaml" --label "repo/infra/workflows/$name.yaml" \
        "$TMP/$name.deployed.yaml" "$file" || true
      if [ "$FAIL_ON_DRIFT" = "true" ]; then
        echo "FAIL_ON_DRIFT=true: not overwriting. Run infra/pull-workflows.sh and commit." >&2
        continue
      fi
      echo "Overwriting. To keep those edits, run infra/pull-workflows.sh and commit them."
    else
      echo "No console edits detected."
    fi
  else
    echo "Not deployed yet; creating it."
  fi

  gcloud workflows deploy "$name" --project "$PROJECT" --location "$REGION" \
    --source "$file" \
    --service-account "$WORKFLOWS_SA" \
    --set-env-vars "JOBS_BASE_URL=${JOBS_BASE_URL}" \
    --labels "managed-by=repo,repo-source-sha1=${new_hash},repo-commit=${COMMIT}" \
    --call-log-level log-errors-only \
    --execution-history-level execution-history-detailed \
    --description "Deployed from infra/workflows/$name.yaml (docs/cloud-jobs.md). Console edits are overwritten on the next deploy." \
    --format='value(name)' >/dev/null
  echo "Deployed $name"
done

if [ "$drifted" = 1 ] && [ "$FAIL_ON_DRIFT" = "true" ]; then
  exit 1
fi
