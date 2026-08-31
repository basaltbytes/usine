# The v1 web UI: projects as home, a kanban board per project

The UI's spine is the work, not the machinery. Home lists the factory's Projects (managed repos as the operator sees them) under a global needs-you strip; a project opens as a Board — a kanban of the repo's items grouped into Lanes, each lane mapping one or more GitHub labels or state sources (`label: ready`, `state: pr open`), configured per repo with defaults proposed from the repo's existing labels and two-way synced (usine never deletes a label). Cards carry the item plus its live run: agent, run state, and the error or approval that needs the operator. Dragging a card between lanes writes the label swap to GitHub — making the board a trigger surface, since a swap is exactly what fires label-protocol loops. Clicking a card opens the run drawer: event (dedup key, payload gist), attempts with typed errors, and the transcript — Pi parent messages with child session events collapsible one level deep. Loops, agents, workers, and lane maps are configuration, demoted to a Configuration section — never the spine.

## Considered Options

- **Runs console as home** (global run queue, CI-dashboard style) — densest observe surface, but the operator thinks in projects and items, not run rows; kept as the drawer's information design.
- **Loops as home** (factory floor of loop cards) — puts configuration where the work should be; rejected as spine, its loop-file view lands in Configuration.
- **Intervention inbox as home** (needs-you cards, everything else collapsed) — right instinct, wrong scope for a whole surface; survives as the global needs-you strip plus per-card badges.
- **Projects + kanban** (chosen) — the only spine that shows *what agents are working on* in the operator's own vocabulary, and the label-lane mapping makes the board double as a trigger surface for free.

## Consequences

- v1 interventions: **Approve**, **Retry**, **Steer** (message to the Pi parent), **Interrupt** (pause at the next tool boundary, wait for a steer), **Cancel**, **Pause a loop** (stop opening new runs; runtime state, see [ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md)), **Child takeover** (davis-style attach to a running harness child), and **Edit-and-retry** (amend context before the next attempt). Takeover and edit-and-retry mechanics get their own ticket — the attempt channel ([ADR 0006](./0006-executor-contract-run-host-attempt-channel.md)) currently addresses the parent only.
- Diffs: the run drawer links the PR the run produced — no reconstructed diff view in v1. The transcript is already persisted, so a changes view stays additive.
- Needs-you (approvals, agent failures, steerable runs) is global chrome — strip on home, badges on project cards and board cards; intervention never requires knowing which project to check.
- Lane maps are per-repo configuration in the instance repo; a fresh repo gets lanes proposed from its labels. Board sync is a projection over the trigger layer's polled state ([ADR 0007](./0007-polling-triggers-content-hashed-events.md)) — no new data source.
- **Project** enters the glossary as the operator-facing term (a managed repo plus its board and factory activity); *managed repo* remains the registry-level mechanism.
- The validated prototype (structure only — its visual language was explicitly rejected; the UI's look is a separate prototype ticket) lives on the `prototype/v1-web-ui` branch.
