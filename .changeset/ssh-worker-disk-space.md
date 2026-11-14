---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

SSH workers keep their disks from filling up with worker images. After each image pull, usine removes the other images of the attempt image's repository. It keeps the current image, the most recently built other image, and every image that a container uses. After a rollback, the retained image can be newer than the current image. Cleanup recognizes Docker Hub name aliases and tracks images replaced by mutable tags such as `latest`.

Preflight and each new attempt, before its checkout starts, check the free disk space on the filesystem of the worker's `root` and on the container runtime's image storage. Below the threshold, the check fails with a `disk` capability error that states the free space and the threshold. **Needs attention** shows the error, and attempts wait until a preflight passes. The threshold defaults to 10 GiB; set `min_free_disk_gib` on the worker to change it, or to `0` to turn the check off. An attempt whose check fails before its checkout fails with an infrastructure failure, which usine retries.

When one of usine's own commands on a worker, such as an image pull or a checkout, reports `ENOSPC` or `No space left on device` during preflight or preparation, usine reports the same `disk` error instead of the command's failure. A report from the attempt's agent keeps the outcome that the agent gave it.
