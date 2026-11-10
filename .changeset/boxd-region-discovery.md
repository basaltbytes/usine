---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd `provisioner.region` accepts any lowercase region id, with `fra` as the default. The boxd driver finds the region's API endpoint with `ListRegions` on `boxd.sh`, so a worker can run on a boxd deployment in your own cloud account and region. Preflight fails with a `provider` capability error that names the listed region ids when boxd lists no region with the configured id. The worker form suggests `fra` and `nyc`.
