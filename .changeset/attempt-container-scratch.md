---
"@usine/core": patch
"@usine/config": patch
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Run SSH attempt containers with memory-backed `/dev/shm` and `/tmp` storage. Configure their capacities per worker with `container.shm_size_mib` and `container.tmpfs_size_mib`; each defaults to 2048 MiB and is capped at the container memory limit.
