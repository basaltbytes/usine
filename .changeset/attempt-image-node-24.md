---
"@usine/executor": patch
---

The attempt image, `ATTEMPT_IMAGE` in `@usine/executor/ssh`, runs Node.js 24, the major version that `infra/hetzner/cloud-init.yaml` installs on the worker machine; it ran Node.js 22. `NODE_MAJOR` in `infra/worker-image/Dockerfile` now sets both, and `infra/hetzner/render-cloud-init.sh` writes it into the cloud-init user data that `create-worker.sh`, `snapshot.sh`, and `gateway.sh worker-user-data` send. The image keeps its tag, so workers get Node.js 24 at their next preflight.
