# @usine/orchestrator

## 0.2.1

### Patch Changes

- 5828a95: Persist Claude and Codex child sessions and record their native ids and worker paths in transcripts. Show copyable resume commands in the Run drawer, including for completed sessions outside the loaded history page.
  
  Upgrade the orchestrator and run host together for Attempt channel protocol v6. Existing protocol-v3 through v5 transcripts remain readable.
- 8b9d544: Add operator takeover, session pause and resume, and edit-and-retry.
  
  Protocol v5 addresses guidance to the Pi parent or a live child. Pause waits at a tool boundary; a message resumes the same session. Messaging a child holds its result until release. Cancel stops the whole Attempt. Messages and delivery receipts identify the operator in the transcript, and stored v3 and v4 transcripts remain readable.
  
  Failed Runs can retry with an amended task and roster agent. Later Attempts retain those amendments and record their effective task, agent, and intervention flag. The Run drawer exposes these controls for parent and child conversations, including held children outside the loaded history page. Holds pause the elapsed-time budget while the token ceiling remains active.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/executor@0.2.1
  - @usine/run-host@0.3.0
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- a36f46e: Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.
  
  Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
- f42d393: Publish the operator HTTP contract at `@usine/orchestrator/operator/http` and derive server handlers and browser requests from it. Preserve existing URLs, response envelopes, transcript query conventions, and operator actions while validating transport failures for typed clients.
- 333eacd: Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.
- 57a374f: Verify rostered harness executables and login state on local and exe.dev Workers before scheduling and preparation. Require codex-cli 0.144.0 and verify ChatGPT authentication before starting Codex turns. Capability gaps require operator action; incomplete checks and transport failures retain infrastructure retries.
  
  Executor preflight and orchestrator engine layers now accept the roster’s brain specs. The run host provides a credential-free harness readiness command, replacing exe.dev’s manually configured login checks. Claude’s Agent SDK uses the Worker’s preflight-checked `claude` executable.

### Patch Changes

- 162b323: Record executor defects as non-retryable Attempt failures with safe operator messages. Keep Attempt admission and cleanup in one service operation, and match Task relationships by canonical PR paths.
- b9e38a7: Import expression schemas, environment descriptors, and typed errors from
  `@usine/expression/expression-engine`. This replaces the `/model` entry point;
  update existing `/model` imports to `/expression-engine`.
  
  Organize GitHub authentication, access, polling, and operator view contracts by
  responsibility while preserving their existing public entry points and schemas.
- 485f244: Start PR-triggered Attempts at the Event's exact pull request head commit.
- 354e598: Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.
- 7cf4887: Refresh Board moves from GitHub promptly and evaluate their Loops without waiting for the next periodic poll. Coalesce self-write Hints, preserve normal polling and Event deduplication, and honor GitHub request backoff.
  
  Keep moved cards in their destination through stale refreshes and project navigation, show saving and synchronization progress, and keep every Board lane reachable beside the sidebar.
- dd81b60: Make proposed Board lanes read-only to preserve descriptive GitHub labels. Configure an authored lane map in usine.yaml to enable moves; authored moves exchange only labels in that map.
- e7adbd8: Derive operator action availability from the shared Run lifecycle rules.
- b628897: Join linked issue and PR Items into Board tasks with complete saved Run histories, per-task Run and Attempt counts, and explicit current-Item lane moves.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [3db806c]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [410607d]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [7dc019e]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/executor@0.2.0
  - @usine/run-host@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- da13037: Run Attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child. Assemble prompts from the payload snapshot, agent persona, and CEL-rendered loop body; persist the effective brain and parent model; stream typed parent and child session events over protocol v2; and pass steer and interrupt controls to the live session.
- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- 27004c2: Add the exe.dev Worker adapter and orchestrator composition. Attempts use native time-boxed GitHub integration grants, cached remote worktrees, protocol-v1 SSH channels, typed capability preflight, and idempotent cancellation and cleanup.
- 24eef02: Add CLI port overrides, help and version output, occupied-port diagnostics, and a two-second timeout when `usine up` opens the setup page. The operator API now returns attempts, needs, and transcript events without exposing infrastructure causes. Cold and live transcript reads have explicit response limits, and the web drawer can continue loading rows beyond its initial 500-row page. Concurrent overview requests reuse one projection computation, and local-worker polling budgets include their timing rationale.
- ae86c6c: Add `usine up` with a local observe-and-intervene UI. Persist Loop pause state in the runtime database; list every open Run plus the newest settled ones and project protocol transcripts; expose approve, retry, cancel, pause, and unpause through the embeddable orchestrator; and preserve durable observation while the foreground server waits for missing GitHub App credentials with trigger execution idle.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.
- 1a9669d: Persist efficiency-only trigger cursors in the run database. Detect GitHub issue and pull-request changes with conditional REST polling, fetch and content-hash fixed GraphQL payload slices, and turn matching loop state into durable Events through the orchestrator polling service.
- 05937b8: Add clock-driven schedule triggers with IANA time zones, per-repository Tick fanout, latest-missed catch-up, and durable Event submission through the existing run engine.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [24eef02]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [7bd5cdb]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/engine@0.1.0
  - @usine/executor@0.1.0
  - @usine/run-host@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
