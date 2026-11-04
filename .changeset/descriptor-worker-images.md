---
"@usine/agents": minor
"@usine/executor": patch
"@usine/cloudflare": patch
---

Generate worker image packages and tags from harness descriptors. Export `workerImageInputs` from `@usine/agents/harness`, derive the default SSH attempt image from it, and keep both Dockerfiles, Hetzner cloud-init, image publishing, and snapshot creation consistent with the catalog.
