---
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

A configuration save no longer waits for an SSH worker to pull its attempt image. `Executor.preflight` takes an optional `PreflightImage`: `pull`, the default, pulls the image as before, and `defer` checks the image that the machine has, or with `docker manifest inspect` or `podman manifest inspect` that the registry has it. With `defer`, a machine without the image skips the checks that run the image, and the report gives the image as `missingImage` and the harnesses as deferred. The worker preflight of a save or reload, and the preflight of a worker whose connection a revision changes, use `defer`. When the machine lacks the image, the worker takes no attempt after the save until a `pull` preflight, which runs outside the save, pulls the image and checks the image's user ID, the shared caches, Podman's resource enforcement, and the harnesses. Startup, on-demand, and retried preflights still pull. A deferred preflight that checked a machine records its container limits and findings.

A save that its client interrupts before the `store` step logs `Configuration save interrupted by the client; nothing was saved` at Info level, with the step that was running. `CurrentInstance.writes` and `GET /api/configuration/writes` list the saves that run now, each with the `save` ID that its client sent with the write, the revision it expects, and its step. The configuration form sends a `save` ID with each save, and when the save takes more than 3 seconds, the form shows the step of that save.
