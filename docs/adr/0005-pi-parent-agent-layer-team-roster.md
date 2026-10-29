# Pi runs every agent; the operator defines named agents

usine's agent layer is one adapter, the in-process Pi SDK. Every run is a Pi parent session whose usine subagents extension starts real harnesses as scoped children (in v1: Claude Code through the Claude Agent SDK, Codex through `codex app-server` JSON-RPC over stdio, Pi through the SDK). Agents are files, `agents/<name>.md` in the instance repo: the frontmatter is the brain spec (harness, model, normalized reasoning effort, optional parent model), and the body is the persona. Every loop must set `agent:` (ADR 0004's slot). A run's prompt is the context preamble, persona, and interpolated loop body; children also get the persona.

## Considered options

- **Flat per-harness adapters**: no parent session or token cost, but no in-run orchestration, and one 0.x adapter per harness to maintain.
- **Pi-only layer** (issue #4's first resolution): Pi calls provider APIs directly. Smallest surface, but no vendor-harness behavior or subscription billing, which the operator requires.
- **Pi parent with a subagents extension** (chosen): proven by davis7dotsh/my-pi-setup. The parent orchestrates real harness sessions on the operator's subscriptions, usine's seam is one adapter, and the multi-harness code is a reusable Pi extension.

## Consequences

- usine writes the extension: unlicensed, my-pi-setup is only a design reference (backend contract, normalized event stream, streaming-input bridge, interrupt semantics). It uses Effect v4, exact-pinned dependencies (`@earendil-works/pi-coding-agent`, `@anthropic-ai/claude-agent-sdk`, the app-server protocol), and live contract tests against the real CLIs.
- Claude children draw the Claude plan's monthly Agent SDK credit (capped API-rate credit, 2026-06-15 policy), and OAuth stays within the terms because the child is Claude Code. Codex children use the ChatGPT plan. The Pi parent bills API keys (instance default model in `usine.yaml`, per-agent override). _Revised by [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)_: the credit was paused before taking effect. Claude children use the plan's usage windows, metered by usine in estimated USD.
- Children run headless with permissions bypassed (`bypassPermissions` / `approvalPolicy: never`); the worker seam isolates them. Workers provide harness binaries, login state, and a duplex channel for events and steer/interrupt.
- The engine validates only its own shapes (harness enum, effort scale `off|minimal|low|medium|high|xhigh|max`). Model ids pass through; an unknown one fails the attempt with a typed error. Runs record what actually started.
- Acceptance loops are harness-free: to change a loop's brain, edit its agent file.

## Amendment (2026-09-03, #102)

Parent reasoning effort is configured, not inherited: `settings.parent_effort` in `usine.yaml` sets the default, and `parent_effort` in an agent file overrides it, like the parent model. Unset, it uses the child's effort. A parent model that can't run the resolved effort fails the attempt with a typed error before the session starts; the SDK doesn't clamp it.

## Amendment (2026-10-08, #176)

The subagents extension is now a pi-durable extension (`@usine/durable`), and the Pi parent runs in the orchestrator, not a worker run host. Each attempt is a `usine.attempt` task with its parent conversation, and the `subagent` tool is the parent's only tool. pi-durable commits the conversation, each tool call's intent, and its output so far before showing anything, so an orchestrator restart resumes the attempt instead of failing it.

The parent's system prompt remains the `usine` section alone because its only tool is `subagent`, children read the worktree's `AGENTS.md` themselves, and three weeks of internal use ran with this prompt (#185).

Unchanged: the parent's model, effort, and pool resolution, the child-session budget, `[usine:blocked]` reports, and the three child backends. A child is a vendor process the parent can't replay, so the tool isn't replay-safe. After a restart, its call ends as interrupted with the committed output, and the parent model decides whether to delegate again. Resuming the vendor session by recorded id comes later.

Every child and its commands get exactly the attempt's environment, because the orchestrator's own contains the App private key ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)). It's never stored, so after a restart new children wait for the executor. Interrupting the parent aborts its current turn and children, rather than blocking its next tool call. The parent is then on hold until operator guidance or a release ([ADR 0018](./0018-takeover-and-edit-and-retry.md)).
