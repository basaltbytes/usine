# @usine/agents

## 0.2.0

### Minor Changes

- 3f80f88: Apply `settings.max_children` as a per-Attempt child-session budget. Protocol v4 sends the budget to the Pi parent, records each accepted spawn with its cumulative count and task excerpt, and reports an excess spawn as a typed non-retryable failure with the configured and attempted counts. Durable protocol-v3 transcript envelopes remain readable after the live channel upgrade.
- 333eacd: Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.
- 57a374f: Verify rostered harness executables and login state on local and exe.dev Workers before scheduling and preparation. Require codex-cli 0.144.0 and verify ChatGPT authentication before starting Codex turns. Capability gaps require operator action; incomplete checks and transport failures retain infrastructure retries.
  
  Executor preflight and orchestrator engine layers now accept the roster’s brain specs. The run host provides a credential-free harness readiness command, replacing exe.dev’s manually configured login checks. Claude’s Agent SDK uses the Worker’s preflight-checked `claude` executable.

### Patch Changes

- 34aeb4a: Update Pi to 0.85.1 and Claude Agent SDK to 0.3.261. The bundled Pi catalog supports GPT-6 Astra through OpenAI API keys and Codex subscriptions, and Claude Fable 5.1 through Anthropic API keys.
- a36f46e: Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.
  
  Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
- 28ec315: Support Codex CLI 0.153.4 and gracefully stop Codex child processes before completing their sessions, including background commands left alive by turn interruption.
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
- fb24c80: Add Codex app-server and API-key-only Pi SDK children to the subagents extension. Dispatch children from the rostered harness, emit normalized session and ChatGPT pool events, and record the effective parent model on each Attempt through protocol v3; each child's effective brain rides its `SessionStarted` transcript event.
- 684757f: Allow the Pi parent to use a ChatGPT subscription through the `openai-codex` provider while preserving API-key-only Pi children. Keep repository coding tools out of the parent so work reaches the rostered child, and disable Codex's recursive collaboration tools inside that child so usine remains the owner of the parent-to-child boundary.

### Patch Changes

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
