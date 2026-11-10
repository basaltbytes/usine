---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd `provisioner.region` accepts any lowercase region id, with `fra` as the default. The boxd driver finds the region's API endpoint with `ListRegions` on `boxd.sh`, so a worker can run on a boxd deployment in your own cloud account and region. Preflight fails with a `provider` capability error that names the listed region ids when boxd lists no region with the configured id. The worker form suggests `fra` and `nyc`.

If boxd doesn't answer or rate-limits while the driver connects to the region, attempt launch waits and tries again instead of failing the Worker's check, and preflight names the hosts to reach: `app.boxd.sh`, `boxd.sh:9443`, and the region's API endpoint.
