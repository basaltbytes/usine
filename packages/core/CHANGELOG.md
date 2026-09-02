# @usine/core

## 0.1.0

### Minor Changes

- da13037: Run Attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child. Assemble prompts from the payload snapshot, agent persona, and CEL-rendered loop body; persist the effective brain and parent model; stream typed parent and child session events over protocol v2; and pass steer and interrupt controls to the live session.
- a8d8df4: Add the durable Drizzle-backed Event, Run, Step, and Attempt engine with approval, retry, supersede, revoke, restart recovery, and a portable SQLite database seam. The root entry is platform-free; the Node local adapter lives at `@usine/engine/local-sqlite`.
- 27004c2: Add the exe.dev Worker adapter and orchestrator composition. Attempts use native time-boxed GitHub integration grants, cached remote worktrees, protocol-v1 SSH channels, typed capability preflight, and idempotent cancellation and cleanup.
- 57d383b: Add a shared GitHub repository identity and implement GitHub App authentication, installation discovery, per-project installation coverage, 0600 local credential loading, and one-repository worker tokens.
- fb24c80: Add Codex app-server and API-key-only Pi SDK children to the subagents extension. Dispatch children from the rostered harness, emit normalized session and ChatGPT pool events, and record the effective parent model on each Attempt through protocol v3; each child's effective brain rides its `SessionStarted` transcript event.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.
- 1a9669d: Persist efficiency-only trigger cursors in the run database. Detect GitHub issue and pull-request changes with conditional REST polling, fetch and content-hash fixed GraphQL payload slices, and turn matching loop state into durable Events through the orchestrator polling service.
- 3041f9d: Move the instance-folder directory brand and the approval-requirement literal set into `@usine/core` (`Instance.Directory`, `Loop.ApprovalRequirement`) so the engine and the config loader share one owner. `@usine/engine` re-exports `InstanceDirectory` and `ApprovalRequirement` unchanged.

### Patch Changes

- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- ae86c6c: Add `usine up` with a local observe-and-intervene UI. Persist Loop pause state in the runtime database; list every open Run plus the newest settled ones and project protocol transcripts; expose approve, retry, cancel, pause, and unpause through the embeddable orchestrator; and preserve durable observation while the foreground server waits for missing GitHub App credentials with trigger execution idle.
- bc17c21: Encode rate-limit reset dates explicitly as ISO strings so session events round-trip through the run-host JSON protocol.

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
