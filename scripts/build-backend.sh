#!/usr/bin/env bash
# Builds a container image for the backend WITHOUT a Dockerfile, using
# Cloud Native Buildpacks (https://buildpacks.io) via the `pack` CLI.
#
# Note on "no Docker": `pack` needs *some* OCI-compatible engine to assemble
# image layers — that's unavoidable for producing a container image at all.
# What this script avoids is Docker Desktop / a hand-written Dockerfile /
# `docker build`. Point pack at Podman instead (rootless, no Docker daemon):
#
#   brew install podman pack        # or your distro's equivalents
#   podman machine init && podman machine start
#   export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
#
# Install pack: https://buildpacks.io/docs/tools/pack/
set -euo pipefail
cd "$(dirname "$0")/../backend"

echo "==> installing deps + type-checking"
npm ci
npm run build

echo "==> building image with Cloud Native Buildpacks (no Dockerfile)"
pack build mini-dropbox-backend:latest \
  --builder paketobuildpacks/builder-jammy-base \
  --path .

echo "==> done: mini-dropbox-backend:latest"
echo "    tag + push to ECR with:"
echo "    docker tag mini-dropbox-backend:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mini-dropbox-backend:latest"
echo "    docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mini-dropbox-backend:latest"
echo "    (the 'docker' CLI here just speaks the registry API — podman push works identically)"
