---
"@usine/executor": patch
---

Warn at SSH worker preflight when concurrent container memory limits exceed host memory minus the 1 GiB reserve. Set each container's swap limit equal to its memory limit to prevent attempts from swapping the host.
