---
"@usine/orchestrator": minor
"@usine/server": patch
---

The session handoff on the Run page gives a command that runs from the operator's own terminal, also when the attempt ran on an ssh worker.

`AttemptView` in `@usine/orchestrator/operator` adds `workerAccess`, how the operator reaches the attempt's worker, read from the worker's entry in `usine.yaml`: `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port` (null when `usine.yaml` sets no port), or null when `usine.yaml` no longer declares the worker. An exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. The union is exported as `WorkerAccess`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument. The overview refreshes its cached Runs when a reload adds or removes a worker.

In the web UI, the block under a Claude Code or Codex child is titled **Resume this session**, with `Session <id>` and `Worktree <cwd>` above it, `on <worker>` for an ssh worker. For a local worker the command is `cd -- '<cwd>' && claude --resume '<id>'`. For an ssh worker it is the same command run over `ssh -t <destination>`, with `-p <port>` when a port is set, quoted once more so paths with apostrophes survive both shells. Codex uses `codex resume --`. A worker `usine.yaml` no longer declares gets the local form and the line `Worker <name> is no longer declared in usine.yaml`. The command wraps instead of scrolling sideways, and **Copy command** copies it as one line. The composer's helper line for a child reads `Session stays open after a message. Release to return the result to the parent`.
