# mini-dropbox

A small distributed file-storage system: upload a file, it gets **chunked**,
**encrypted**, **replicated** across multiple targets (including AWS S3),
and every re-upload of the same file is kept as a new **version** you can
roll back to. A gRPC service does the real work; a REST gateway + web UI
sit in front of it.

```
┌───────────────┐   HTTP (upload/list/   ┌──────────────┐   gRPC    ┌──────────────────┐
│  Browser UI    │ ─  download/rollback) ─▶│   Gateway    │ ─stream─▶│  Backend (gRPC)  │
│ (static, no    │◀──────────────────────  │ Express REST │◀─stream──│  FileService     │
│  build step)   │                         └──────────────┘          └─────────┬────────┘
└───────────────┘                                                              │
                                                                    chunk + encrypt + fan-out
                                                                              │
                                                     ┌────────────────────────┼────────────────────────┐
                                                     ▼                        ▼                         ▼
                                              replica-a (disk)         replica-b (disk)            S3 bucket (AWS)
```

## Feature → code map

| Feature | Where |
|---|---|
| **Chunking** | `backend/src/services/chunking.ts` — fixed 1 MiB chunks, streamed (never buffers a whole file in memory) |
| **Encryption** | `backend/src/services/encryption.ts` — AES-256-GCM per chunk, authenticated (tamper-evident) |
| **Replication** | `backend/src/services/replication/` — fan-out write to N targets, read with automatic failover; targets: two local dirs + optional S3 |
| **Version control** | `backend/src/services/metadataStore.ts` + `fileService.ts` — every upload of an existing `file_id` creates a new version; old versions and their chunks are kept until you delete the file |
| **gRPC** | `proto/filestorage.proto`, `backend/src/grpcServer.ts` — the actual storage-node API. The REST gateway is just one possible client of it. |
| **Kubernetes** | `k8s/` — Deployments, Services, PVC, ConfigMap/Secret, optional Ingress |
| **AWS** | `aws/*.tf` — S3 bucket (the third replica), IAM policy, ECR repos |

## Run it locally — no Docker, no Kubernetes

Requires only Node.js 18+.

```bash
./scripts/dev.sh
```

This generates a `MASTER_KEY`, installs dependencies for both services, and
starts:
- backend gRPC server on `:50051`
- gateway (REST API + the web UI) on `:8080`

Open **http://localhost:8080** — drag a file in, watch it upload, expand a
row to see its version history and per-version chunk ledger, re-upload the
same browser tab's file again to create v2, and roll back to v1.

Chunks land on disk under `backend/data/replica-a/` and `.../replica-b/` —
open both and you'll see identical encrypted `.chunk` files, proving
replication actually happened. Metadata lives in `backend/data/metadata.json`.

To also exercise the S3 replica leg locally, set `S3_BUCKET` (and valid AWS
credentials) in `backend/.env` before running `dev.sh`.

### Manual setup (equivalent to dev.sh)

```bash
cp backend/.env.example backend/.env   # then fill in MASTER_KEY
cp gateway/.env.example gateway/.env
cd backend && npm install && npm run dev     # terminal 1
cd gateway && npm install && npm run dev     # terminal 2
```

## Building images without Docker

Kubernetes runs container images, but nothing says you need `docker build`
or a `Dockerfile` to produce one. `scripts/build-backend.sh` and
`scripts/build-gateway.sh` use **Cloud Native Buildpacks** (`pack build`)
instead — no Dockerfile anywhere in this repo.

One honest caveat: buildpacks still need *some* OCI-compatible engine to
assemble the image layers — that's inherent to producing a container image
at all, not a buildpacks quirk. Point `pack` at **Podman** instead of Docker
Desktop (rootless, no Docker daemon):

```bash
brew install podman pack     # or your distro's equivalents
podman machine init && podman machine start
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

./scripts/build-backend.sh
./scripts/build-gateway.sh
```

Push the resulting images to the ECR repos created by Terraform (see below),
then update the `image:` fields in `k8s/backend-deployment.yaml` and
`k8s/gateway-deployment.yaml`.

## AWS infrastructure (Terraform)

```bash
cd aws
terraform init
terraform apply -var="bucket_name=your-globally-unique-bucket-name"
```

Creates:
- an **S3 bucket** — the third replication target, versioned and encrypted at the storage layer as a second safety net independent of the app's own version control
- an **IAM policy** scoped to `PutObject`/`GetObject`/`DeleteObject`/`ListBucket` on that bucket — attach it to an IRSA role (EKS) or an IAM user for local testing
- two **ECR repos** for the buildpacks-built images

This provisions supporting infra only — it does not create an EKS cluster.
Point `kubectl` at whatever cluster you already have (EKS, kind, k3s, etc.).

## Deploying to Kubernetes

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
cp k8s/secret.yaml.example k8s/secret.yaml   # fill in MASTER_KEY (and AWS keys if not using IRSA)
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/backend-pvc.yaml
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml
kubectl apply -f k8s/gateway-deployment.yaml
kubectl apply -f k8s/gateway-service.yaml
# optional: kubectl apply -f k8s/ingress.yaml
```

`kubectl get svc mini-dropbox-gateway -n mini-dropbox` gives you the
LoadBalancer address once AWS provisions it.

## Known simplifications (read before treating this as production)

- **Metadata store** is a single JSON file (`metadataStore.ts`), guarded by
  an in-process write queue. Fine for a demo/single backend replica; swap
  it for Postgres/DynamoDB before running more than one backend pod or
  trusting it with real data.
- **Local replicas share one PVC** in the provided K8s manifests (see the
  comment in `k8s/backend-pvc.yaml`). Real fault tolerance means separate
  pods/volumes/AZs — the `ReplicaTarget` interface is already shaped so you
  can point a replica at a remote node instead of a local directory.
- **No auth** on the API — every request is `owner: anonymous` unless the
  caller sets one. Add real authentication before exposing this beyond your
  own machine.
- **Chunking is fixed-size**, not content-defined, so it won't dedupe
  near-identical files. Good enough for correct replication/versioning;
  swap in a rolling-hash chunker if dedup matters to you.
