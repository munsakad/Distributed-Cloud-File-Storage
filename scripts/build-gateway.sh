#!/usr/bin/env bash
# See build-backend.sh for the full explanation of the no-Dockerfile approach.
set -euo pipefail
cd "$(dirname "$0")/../gateway"

echo "==> installing deps + type-checking"
npm ci
npm run build

echo "==> building image with Cloud Native Buildpacks (no Dockerfile)"
pack build mini-dropbox-gateway:latest \
  --builder paketobuildpacks/builder-jammy-base \
  --path .

echo "==> done: mini-dropbox-gateway:latest"
echo "    tag + push to ECR with:"
echo "    docker tag mini-dropbox-gateway:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mini-dropbox-gateway:latest"
echo "    docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mini-dropbox-gateway:latest"
