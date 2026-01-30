#!/bin/bash
#
# Grant service account permissions to trigger Cloud Run Jobs
# This script is idempotent - safe to run multiple times
#

set -e

# Check if .env file exists
if [ ! -f .env ]; then
  echo "Error: .env file not found"
  echo "Create a .env file with PROJECT_ID and REGION"
  exit 1
fi

# Load environment variables
source .env

# Set defaults
LOCATION="${REGION:-europe-west3}"
JOB_NAME="claude-code-async-worker"

echo "=== Granting Job Execution Permissions ==="
echo ""
echo "Project: ${PROJECT_ID}"
echo "Location: ${LOCATION}"
echo "Job: ${JOB_NAME}"
echo ""

# Get service account from the service
echo "🔍 Finding service account..."
SERVICE_SA=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${LOCATION}" \
  --format='value(spec.template.spec.serviceAccountName)' \
  --project="${PROJECT_ID}" 2>/dev/null || echo "")

if [ -z "$SERVICE_SA" ]; then
  echo "⚠️  Service '${SERVICE_NAME}' not found, using default compute service account"
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
  SERVICE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "✅ Service account: ${SERVICE_SA}"

# Check if job exists
JOB_EXISTS=$(gcloud run jobs describe "${JOB_NAME}" \
  --region="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --format="value(metadata.name)" 2>/dev/null || echo "")

if [ -z "$JOB_EXISTS" ]; then
  echo "❌ Job '${JOB_NAME}' not found in ${LOCATION}"
  echo "Deploy the job first: ./scripts/deploy-job.sh"
  exit 1
fi

echo "✅ Job exists: ${JOB_NAME}"
echo ""

# Grant run.developer role (allows triggering job executions)
echo "🔐 Granting roles/run.developer to ${SERVICE_SA}..."
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${LOCATION}" \
  --member="serviceAccount:${SERVICE_SA}" \
  --role="roles/run.developer" \
  --project="${PROJECT_ID}" \
  --quiet

echo "✅ Permission granted"

echo ""
echo "=== Permission Check ==="
gcloud run jobs get-iam-policy "${JOB_NAME}" \
  --region="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --format="table(bindings.role, bindings.members)" \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SERVICE_SA}"

echo ""
echo "✅ Setup complete!"
echo ""
echo "The service can now trigger job executions for async tasks."
