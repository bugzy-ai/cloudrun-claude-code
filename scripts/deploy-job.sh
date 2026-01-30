#!/bin/bash
#
# Deploy Cloud Run Job for async task execution
# This script creates or updates the job definition that will run job-worker.js
#

set -e

# Load environment variables
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "${DIR}/load-env.sh"

# Set defaults
LOCATION="${REGION:-europe-west3}"
JOB_NAME="claude-code-async-worker"
IMAGE_NAME="claude-code"

echo "=== Deploying Cloud Run Job ==="
echo ""
echo "Project: ${PROJECT_ID}"
echo "Location: ${LOCATION}"
echo "Job Name: ${JOB_NAME}"
echo ""

# Get the latest image from Artifact Registry
REPOSITORY_NAME="${REPOSITORY:-claude-code}"
REPOSITORY_PATH="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY_NAME}"
IMAGE="${REPOSITORY_PATH}/${IMAGE_NAME}:latest"

echo "📦 Using image: ${IMAGE}"

# Get service account from the service
echo "🔍 Finding service account..."
SERVICE_SA=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${LOCATION}" \
  --format='value(spec.template.spec.serviceAccountName)' \
  --project="${PROJECT_ID}" 2>/dev/null || echo "")

if [ -z "$SERVICE_SA" ]; then
  echo "⚠️  Service '${SERVICE_NAME}' not found"
  echo "Using default compute service account"
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
  SERVICE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "✅ Service account: ${SERVICE_SA}"

# Check if job already exists
JOB_EXISTS=$(gcloud run jobs describe "${JOB_NAME}" \
  --region="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --format="value(metadata.name)" 2>/dev/null || echo "")

if [ -n "$JOB_EXISTS" ]; then
  OPERATION="Updating"
  CMD="update"
  echo "ℹ️  Job '${JOB_NAME}' already exists - will update"
else
  OPERATION="Creating"
  CMD="create"
  echo "✨ Job '${JOB_NAME}' does not exist - will create"
fi

echo ""
echo "🚀 ${OPERATION} Cloud Run Job..."

# Build LOG_LEVEL_* env vars string
LOG_LEVEL_VARS=""
for var in $(env | grep '^LOG_LEVEL_' | cut -d= -f1); do
  value="${!var}"
  if [ -n "$value" ]; then
    LOG_LEVEL_VARS="${LOG_LEVEL_VARS} --set-env-vars=\"${var}=${value}\""
    echo "  Adding ${var}=${value}"
  fi
done

eval gcloud run jobs ${CMD} "${JOB_NAME}" \
  --image="${IMAGE}" \
  --region="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --max-retries=1 \
  --task-timeout=24h \
  --cpu=1 \
  --memory=4Gi \
  --service-account="${SERVICE_SA}" \
  --set-env-vars="PROJECT_ID=${PROJECT_ID}" \
  --set-env-vars="REGION=${LOCATION}" \
  --set-env-vars="GCS_LOGS_BUCKET=${GCS_LOGS_BUCKET}" \
  --set-env-vars="GCS_PROJECT_ID=${PROJECT_ID}" \
  --set-env-vars="LOG_LEVEL=${LOG_LEVEL:-info}" \
  ${LOG_LEVEL_VARS} \
  --set-secrets="CLOUDRUN_CALLBACK_SECRET=CLOUDRUN_CALLBACK_SECRET:latest" \
  --command=node \
  --args=dist/job-worker.js

if [ "$CMD" = "create" ]; then
  echo "✅ Job created successfully"
else
  echo "✅ Job updated successfully"
fi

echo ""
echo "Job details:"
gcloud run jobs describe "${JOB_NAME}" \
  --region="${LOCATION}" \
  --project="${PROJECT_ID}" \
  --format="yaml(spec.template.spec.containers[0])" | head -20

echo ""
echo "=== Next Steps ==="
echo "1. Grant service account permissions: ./scripts/grant-job-permissions.sh"
echo "2. Test the job: gcloud run jobs execute ${JOB_NAME} --region=${LOCATION}"
echo "3. View job executions: https://console.cloud.google.com/run/jobs/details/${LOCATION}/${JOB_NAME}?project=${PROJECT_ID}"
