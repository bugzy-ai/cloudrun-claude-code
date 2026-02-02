#!/bin/bash

# Build and push Docker image to GCP Artifact Registry

set -e

# Load environment variables
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "${DIR}/load-env.sh"

# Configuration - Replace these with your actual values
PROJECT_ID="${PROJECT_ID:-your-project-id}"
REGION="${REGION:-us-central1}"
REPOSITORY="${REPOSITORY:-claude-code}"
IMAGE_NAME="${IMAGE_NAME:-claude-code}"
TAG="${TAG:-latest}"

# Enable required APIs
echo "Checking required APIs..."
APIS_TO_ENABLE=""

if ! gcloud services list --enabled --project="${PROJECT_ID}" | grep -q "artifactregistry.googleapis.com"; then
  APIS_TO_ENABLE="${APIS_TO_ENABLE} artifactregistry.googleapis.com"
fi

if ! gcloud services list --enabled --project="${PROJECT_ID}" | grep -q "cloudbuild.googleapis.com"; then
  APIS_TO_ENABLE="${APIS_TO_ENABLE} cloudbuild.googleapis.com"
fi

if [ -n "${APIS_TO_ENABLE}" ]; then
  echo "Enabling APIs:${APIS_TO_ENABLE}"
  gcloud services enable ${APIS_TO_ENABLE} --project="${PROJECT_ID}"
  echo "✓ APIs enabled"
  sleep 5  # Wait for APIs to be ready
else
  echo "✓ All required APIs already enabled"
fi

# Check if Artifact Registry repository exists, create if not
echo "Checking Artifact Registry repository..."
if ! gcloud artifacts repositories describe "${REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" &>/dev/null; then
  echo "Creating Artifact Registry repository: ${REPOSITORY}"
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --description="Claude Code Docker images"
  echo "✓ Repository created"
else
  echo "✓ Repository already exists"
fi

# Configure Docker authentication for Artifact Registry
echo "Configuring Docker authentication..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
echo "✓ Docker authentication configured"

# Construct the full image URL
IMAGE_URL="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

echo "Building and pushing image: ${IMAGE_URL}"

# Build and push the image using Cloud Build
# Package versions are baked into .package-versions.env (COPY'd in Dockerfile)
echo "Building and pushing Docker image..."
gcloud builds submit \
  --tag "${IMAGE_URL}" \
  --project "${PROJECT_ID}" \
  --timeout=20m \
  .

if [ $? -eq 0 ]; then
  echo "✓ Image successfully built and pushed to: ${IMAGE_URL}"
else
  echo "✗ Failed to build and push image"
  exit 1
fi