# @usine/executor

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

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- 333eacd: Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.
- 57a374f: Verify rostered harness executables and login state on local and exe.dev Workers before scheduling and preparation. Require codex-cli 0.144.0 and verify ChatGPT authentication before starting Codex turns. Capability gaps require operator action; incomplete checks and transport failures retain infrastructure retries.
  
  Executor preflight and orchestrator engine layers now accept the roster’s brain specs. The run host provides a credential-free harness readiness command, replacing exe.dev’s manually configured login checks. Claude’s Agent SDK uses the Worker’s preflight-checked `claude` executable.

### Patch Changes

- 410607d: Ignore non-repository entries when pruning local Worker bare caches, and keep Turborepo's shared worktree cache outside repository cache storage.
- 7dc019e: Route process-console logging to stderr and tolerate stray Effect diagnostics on the Attempt channel while preserving strict protocol validation.
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
- 27004c2: Add the exe.dev Worker adapter and orchestrator composition. Attempts use native time-boxed GitHub integration grants, cached remote worktrees, protocol-v1 SSH channels, typed capability preflight, and idempotent cancellation and cleanup.
- fb24c80: Add Codex app-server and API-key-only Pi SDK children to the subagents extension. Dispatch children from the rostered harness, emit normalized session and ChatGPT pool events, and record the effective parent model on each Attempt through protocol v3; each child's effective brain rides its `SessionStarted` transcript event.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.

### Patch Changes

- 7bd5cdb: Preserve redacted run-host frame diagnostics in logs and Attempt failure messages so malformed JSON, stdout log pollution, and schema-invalid protocol output can be distinguished without recording frame content or credentials.
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
