---
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

A configuration save no longer waits for an SSH worker to pull its attempt image. `Executor.preflight` takes an optional `PreflightImage`: `pull`, the default, pulls the image as before, and `defer` checks the image that the machine has, or with `docker manifest inspect` or `podman manifest inspect` that the registry has it. With `defer`, a machine without the image reports its harnesses as deferred, and the next attempt pulls the image and checks the harness in its container. The worker preflight of a save or reload, and the preflight of a worker whose connection a revision changes, use `defer`. Startup, on-demand, and retried preflights still pull. A deferred preflight that checked a machine now records its container limits and findings.

A save that its client interrupts before the `store` step logs `Configuration save interrupted by the client; nothing was saved` at Info level, with the step that was running. `CurrentInstance.writes` and `GET /api/configuration/writes` list the saves that run now, each with the revision it expects and its step. When a save takes more than 3 seconds, the configuration form shows that step.
