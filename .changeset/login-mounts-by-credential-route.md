---
"@usine/executor": patch
"@usine/server": patch
---

An attempt container on an SSH worker mounts the SSH user's login files for its harness only when the harness uses that login. When the gateway holds the provider's credential (`llm_providers`) or the provisioner gives the attempt an API key, the container gets no login files for that harness, even when they exist on the machine. Preflight logs, at Info, which login files the worker's containers mount for each harness if the machine has them, and why.
