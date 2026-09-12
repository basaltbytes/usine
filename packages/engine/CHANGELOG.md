# @usine/engine

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- 388e59d: Add `usine export-run <runId>` to save one Run's detail, Attempt history, and complete transcripts as a local JSON file. Use `--output <path>` to choose the destination. Existing files are preserved, and missing Runs or export failures return a nonzero exit status.
  
  Add `RunReader.evidence(runId)` for a consistent snapshot and complete transcripts from one transaction, and `runReaderLayer(instanceDirectory)` for read-only access to an existing local runtime database without migrations.
- a36f46e: Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.
  
  Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
- 83edd04: Add `usine backup <path>` to copy the runtime database while the orchestrator runs. Backups include all tables and committed WAL data, preserve existing destination files, and support restoring Run evidence. Document backup and restore requirements.

### Patch Changes

- 162b323: Record executor defects as non-retryable Attempt failures with safe operator messages. Keep Attempt admission and cleanup in one service operation, and match Task relationships by canonical PR paths.
- 5c47dc2: Drain admitted Attempts on SIGINT or SIGTERM before closing the runtime. Defer queued work and automatic retries until restart, with a bounded shutdown wait and a second-signal force stop.
- b628897: Join linked issue and PR Items into Board tasks with complete saved Run histories, per-task Run and Attempt counts, and explicit current-Item lane moves.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- da13037: Run Attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child. Assemble prompts from the payload snapshot, agent persona, and CEL-rendered loop body; persist the effective brain and parent model; stream typed parent and child session events over protocol v2; and pass steer and interrupt controls to the live session.
- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- a8d8df4: Add the durable Drizzle-backed Event, Run, Step, and Attempt engine with approval, retry, supersede, revoke, restart recovery, and a portable SQLite database seam. The root entry is platform-free; the Node local adapter lives at `@usine/engine/local-sqlite`.
- 24eef02: Add CLI port overrides, help and version output, occupied-port diagnostics, and a two-second timeout when `usine up` opens the setup page. The operator API now returns attempts, needs, and transcript events without exposing infrastructure causes. Cold and live transcript reads have explicit response limits, and the web drawer can continue loading rows beyond its initial 500-row page. Concurrent overview requests reuse one projection computation, and local-worker polling budgets include their timing rationale.
- fb24c80: Add Codex app-server and API-key-only Pi SDK children to the subagents extension. Dispatch children from the rostered harness, emit normalized session and ChatGPT pool events, and record the effective parent model on each Attempt through protocol v3; each child's effective brain rides its `SessionStarted` transcript event.
- ae86c6c: Add `usine up` with a local observe-and-intervene UI. Persist Loop pause state in the runtime database; list every open Run plus the newest settled ones and project protocol transcripts; expose approve, retry, cancel, pause, and unpause through the embeddable orchestrator; and preserve durable observation while the foreground server waits for missing GitHub App credentials with trigger execution idle.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.
- 1a9669d: Persist efficiency-only trigger cursors in the run database. Detect GitHub issue and pull-request changes with conditional REST polling, fetch and content-hash fixed GraphQL payload slices, and turn matching loop state into durable Events through the orchestrator polling service.

### Patch Changes

- 3041f9d: Move the instance-folder directory brand and the approval-requirement literal set into `@usine/core` (`Instance.Directory`, `Loop.ApprovalRequirement`) so the engine and the config loader share one owner. `@usine/engine` re-exports `InstanceDirectory` and `ApprovalRequirement` unchanged.
- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
