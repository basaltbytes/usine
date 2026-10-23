---
"@usine/orchestrator": minor
"@usine/server": patch
---

The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.

`AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
