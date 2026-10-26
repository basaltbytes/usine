---
"@usine/executor": patch
---

Fixes the salvage of an attempt whose container on an SSH worker stopped before the attempt ended, for example because the kernel killed it for memory or a test signaled its init. The salvage ran `docker exec` in the stopped container, failed, and kept the checkout without pushing its work. The release now starts the container again with `docker start`, salvages in it, and then removes it. A warning logs the container's status, exit code, and whether it was killed for memory.
