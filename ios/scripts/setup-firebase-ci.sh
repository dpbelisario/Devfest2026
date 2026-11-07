#!/usr/bin/env bash
# Configure keyless Firebase uploads for this repository's manual iOS workflow.
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
project=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["projectId"])' "$script_dir/../firebase-app.json")
project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
service_account="contour-ios-distribution@$project.iam.gserviceaccount.com"
pool=contour-ios-ci
provider=github
repository=dpbelisario/Devfest2026
# Immutable repository/owner IDs avoid trusting a later reuse of the repository name.
condition="assertion.repository_id == '1445568390' && assertion.repository_owner_id == '224859517' && assertion.event_name == 'workflow_dispatch' && (assertion.ref == 'refs/heads/main' || assertion.ref == 'refs/heads/david/kmp-ios')"

gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com firebase.googleapis.com firebaseappdistribution.googleapis.com --project "$project" --quiet
if ! gcloud iam service-accounts describe "$service_account" --project "$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create contour-ios-distribution --display-name='Contour iOS Firebase distribution' --project "$project" --quiet
fi
for role in roles/firebaseappdistro.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$service_account" --role="$role" --condition=None --quiet >/dev/null
done
if ! gcloud iam workload-identity-pools describe "$pool" --location global --project "$project" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$pool" --location global --display-name='Contour iOS GitHub builds' --project "$project" --quiet
fi
if gcloud iam workload-identity-pools providers describe "$provider" --workload-identity-pool "$pool" --location global --project "$project" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$provider" --workload-identity-pool "$pool" --location global --project "$project" --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository' --attribute-condition="$condition" --quiet
else
  gcloud iam workload-identity-pools providers create-oidc "$provider" --workload-identity-pool "$pool" --location global --project "$project" --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository' --attribute-condition="$condition" --quiet
fi
gcloud iam service-accounts add-iam-policy-binding "$service_account" --project "$project" --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool/attribute.repository/$repository" --quiet >/dev/null
printf 'GCP_WORKLOAD_IDENTITY_PROVIDER=projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\n' "$project_number" "$pool" "$provider"
printf 'GCP_SERVICE_ACCOUNT=%s\n' "$service_account"
