#!/usr/bin/env bash
# Runs backend + gateway locally with plain Node.js — no Docker, no Kubernetes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/backend/.env" ]; then
  echo "==> backend/.env not found, creating one with a fresh MASTER_KEY"
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # portable sed -i for macOS/BSD and GNU
  sed -i.bak "s/^MASTER_KEY=.*/MASTER_KEY=${KEY}/" "$ROOT/backend/.env" && rm -f "$ROOT/backend/.env.bak"
fi
[ -f "$ROOT/gateway/.env" ] || cp "$ROOT/gateway/.env.example" "$ROOT/gateway/.env"

echo "==> installing backend deps"
(cd "$ROOT/backend" && npm install)
echo "==> installing gateway deps"
(cd "$ROOT/gateway" && npm install)

echo "==> starting backend (gRPC :50051) and gateway (HTTP :8080)"
(cd "$ROOT/backend" && npm run dev) &
BACKEND_PID=$!
(cd "$ROOT/gateway" && npm run dev) &
GATEWAY_PID=$!

trap 'kill $BACKEND_PID $GATEWAY_PID 2>/dev/null' EXIT
echo "==> open http://localhost:8080"
wait
