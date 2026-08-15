# Pi drives all agents; the operator authors a team of named Agents

Usine's agent layer is a single adapter: the in-process Pi SDK. Every run is a Pi parent session equipped with a usine-owned subagents extension that spawns the real harnesses as scoped children — Claude Code via the Claude Agent SDK, Codex via `codex app-server` JSON-RPC over stdio, Pi via the SDK — all three in v1. The operator authors **Agents**: named team members (`agents/<name>.md` in the instance repo, filename as identity) whose frontmatter is the brain spec (harness, model, normalized reasoning effort, optional parent model) and whose Markdown body is the persona. Every loop must name its agent (`agent:` — the slot ADR 0004 reserved); a run's prompt is context preamble + persona + interpolated loop body, and the persona rides into the child spawn.

## Considered Options

- **Flat per-harness adapters** — usine owns one adapter per harness at the worker seam, no parent session. Fewer layers and no parent token tax, but every run is a bare harness call: no in-run orchestration, and usine carries one 0.x adapter surface per harness at its own seam.
- **Pi-only layer** (issue #4's initial resolution) — Pi replaces the vendor harnesses, speaking provider APIs directly. Smallest surface, but forfeits vendor-harness behavior and subscription-included billing, which the operator requires.
- **Pi parent + subagents extension** (chosen) — proven end-to-end by davis7dotsh/my-pi-setup: the parent orchestrates, children are real harness sessions on the operator's subscriptions. Usine's own seam shrinks to one adapter; the multi-harness machinery becomes a separable Pi extension reusable outside usine.

## Consequences

- The extension is written by usine: my-pi-setup has no license (all-rights-reserved by default), so it serves as design reference only — backend contract, normalized event stream, streaming-input bridge, interrupt semantics. Effect v4, exact-pinned dependencies (`@earendil-works/pi-coding-agent`, `@anthropic-ai/claude-agent-sdk`, the app-server protocol), live contract tests against the real CLIs.
- Billing splits three ways: Claude children draw the Claude plan's monthly Agent SDK credit (post-2026-06-15 policy — API-rate credit, capped, not interactive plan limits; OAuth stays ToS-clean because the child *is* Claude Code), Codex children ride the ChatGPT plan, the Pi parent bills API keys (instance-level default model in `usine.yaml`, per-agent override).
- Children run headless with permissions bypassed (`bypassPermissions` / `approvalPolicy: never`); isolation remains the worker seam's job. Workers must provision harness binaries, login state, and a duplex channel for the normalized event stream + steer/interrupt.
- The engine validates only its own shapes (harness enum, effort scale `off|minimal|low|medium|high|xhigh|max`); model ids pass through and an unknown model fails the attempt with a typed error. Runs record what was actually spawned — declare by roster, observe by record.
- The acceptance loops are harness-free: migrating a loop to a different brain is editing its agent's file, never the loop.
