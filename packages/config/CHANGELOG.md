# @usine/config

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- a36f46e: Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.
  
  Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
- 333eacd: Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.

### Patch Changes

- b9e38a7: Import expression schemas, environment descriptors, and typed errors from
  `@usine/expression/expression-engine`. This replaces the `/model` entry point;
  update existing `/model` imports to `/expression-engine`.
  
  Organize GitHub authentication, access, polling, and operator view contracts by
  responsibility while preserving their existing public entry points and schemas.
- 354e598: Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0
  - @usine/expression@0.2.0

## 0.1.0

### Minor Changes

- da13037: Run Attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child. Assemble prompts from the payload snapshot, agent persona, and CEL-rendered loop body; persist the effective brain and parent model; stream typed parent and child session events over protocol v2; and pass steer and interrupt controls to the live session.
- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- 95b26af: Load, validate, and edit instance-folder configuration with per-loop quarantine and checked CEL prompt rendering. Add a typed CEL service over plain JSON with an implementation-neutral environment contract.
- 6e61cbf: Add the local worker runtime: capacity-aware scheduling, isolated Git worktrees, per-Attempt credentials, protocol-v2 run-host channels, durable transcripts, structured results, and cooperative cancellation with hard-kill cleanup.

### Patch Changes

- 27004c2: Add the exe.dev Worker adapter and orchestrator composition. Attempts use native time-boxed GitHub integration grants, cached remote worktrees, protocol-v1 SSH channels, typed capability preflight, and idempotent cancellation and cleanup.
- 57d383b: Add a shared GitHub repository identity and implement GitHub App authentication, installation discovery, per-project installation coverage, 0600 local credential loading, and one-repository worker tokens.
- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
