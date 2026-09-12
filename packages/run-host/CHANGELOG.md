# @usine/run-host

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- 57a374f: Verify rostered harness executables and login state on local and exe.dev Workers before scheduling and preparation. Require codex-cli 0.144.0 and verify ChatGPT authentication before starting Codex turns. Capability gaps require operator action; incomplete checks and transport failures retain infrastructure retries.
  
  Executor preflight and orchestrator engine layers now accept the roster’s brain specs. The run host provides a credential-free harness readiness command, replacing exe.dev’s manually configured login checks. Claude’s Agent SDK uses the Worker’s preflight-checked `claude` executable.

### Patch Changes

- 3db806c: Deliver session interrupts before terminal cleanup, preserving the interrupted outcome when an SDK abort immediately fails its result. End Attempts promptly when their session result, event stream, or Git result harvesting fails.
- 333eacd: Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.
- bd45cf4: Collect pull request facts from GitHub using the Attempt's final commit and existing worker credentials. Encode PR and comment URLs as strings so facts survive the Attempt channel and durable storage.
- 7dc019e: Route process-console logging to stderr and tolerate stray Effect diagnostics on the Attempt channel while preserving strict protocol validation.
- Updated dependencies [3f80f88]
- Updated dependencies [34aeb4a]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [28ec315]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/agents@0.2.0
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- da13037: Run Attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child. Assemble prompts from the payload snapshot, agent persona, and CEL-rendered loop body; persist the effective brain and parent model; stream typed parent and child session events over protocol v2; and pass steer and interrupt controls to the live session.
- fb24c80: Add Codex app-server and API-key-only Pi SDK children to the subagents extension. Dispatch children from the rostered harness, emit normalized session and ChatGPT pool events, and record the effective parent model on each Attempt through protocol v3; each child's effective brain rides its `SessionStarted` transcript event.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [684757f]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/agents@0.1.0
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
