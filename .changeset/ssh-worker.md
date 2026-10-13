---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Add an `ssh` Worker kind for any Linux machine the orchestrator reaches over SSH, so customer code can run on EU machines usine controls (ADR 0026).

`@usine/core/worker`: `WORKER_KINDS` gains `"ssh"`, with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas for an SSH Worker's address.

`@usine/config/factory`: `Worker` is the union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, chosen by `kind`. An `ssh` Worker in `usine.yaml` takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory under which it keeps `workers/<name>` on the machine. Those keys are refused on other kinds.

`@usine/executor/ssh`: a new adapter. Preflight checks that SSH reaches the machine, that the root is writable, Git, and the roster's harnesses there, without changing anything. Each Attempt's single-repository token from the `CredentialProvider` reaches the machine through standard input and is written beside the Worker's checkouts with mode 600, read by git's credential helper and gh, renewed before it expires, and removed when the Attempt ends; the first use of a Worker by a process removes what an earlier process left. Every Attempt on a Worker runs as the same SSH user, so each can read the others' tokens while they run (#231). Children, pid files, sweeps, salvage, recovery, and reattachment are shared with the exe.dev adapter, whose span and log names for that shared code change (`RemoteExecutor.*`, "remote" in place of "exe.dev" in sweep and listing messages); its behaviour and command lines are unchanged. The local adapter's credential files and renewal now come from the same shared helper, unchanged in behaviour.

`@usine/orchestrator`: `@usine/orchestrator/ssh` composes the engine with the SSH executor, and `sshWorkersOf(config)` returns the SSH Workers `usine.yaml` declares. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`; `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every configured Worker is `ssh`. `pnpm test:ssh` runs the live SSH Worker check against a machine named by `USINE_SSH_INTEGRATION_DESTINATION`.

`@usine/server`: `usine up` runs Attempts on SSH Workers when `usine.yaml` declares them.
