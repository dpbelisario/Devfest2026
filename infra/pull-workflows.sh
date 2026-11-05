#!/usr/bin/env bash
# Copy the currently deployed Cloud Workflows definitions back into
# infra/workflows/ so edits made in the console can be reviewed and committed.
# The repo is the source of truth: the next deploy (Cloud Build on push to main,
# or infra/deploy-workflows.sh) overwrites anything not pulled and committed.
#
#   bash infra/pull-workflows.sh            # all workflows in infra/workflows/
#   bash infra/pull-workflows.sh jma-warnings
#
# Environment: PROJECT (default: gcloud config), REGION (default asia-northeast1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Set PROJECT or run: gcloud config set project PROJECT_ID" >&2; exit 1; }
REGION="${REGION:-asia-northeast1}"

if [ "$#" -gt 0 ]; then
  names=("$@")
else
  names=()
  for file in "$ROOT"/infra/workflows/*.yaml; do names+=("$(basename "$file" .yaml)"); done
fi

for name in "${names[@]}"; do
  out="$ROOT/infra/workflows/$name.yaml"
  gcloud workflows describe "$name" --project "$PROJECT" --location "$REGION" --format=json |
    python3 -c 'import json,sys
src = json.load(sys.stdin).get("sourceContents", "")
if not src.strip():
    sys.exit("Workflow has no source contents")
open(sys.argv[1], "w", encoding="utf-8").write(src.rstrip("\n") + "\n")' "$out"
  echo "Pulled $name -> infra/workflows/$name.yaml"
done

echo
echo "Next: npx prettier --write infra/workflows && git diff -- infra/workflows"
echo "Review the diff, then commit and push to main to make it the deployed version."
git -C "$ROOT" diff --stat -- infra/workflows 2>/dev/null || true
