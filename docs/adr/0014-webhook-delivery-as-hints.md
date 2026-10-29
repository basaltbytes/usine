# Webhook delivery as hints; polling stays the correctness source

v1 adds push delivery as **hints**: droppable `(repo, optional item)` requests that schedule the existing change detection or slice fetch sooner, never a new event path. Hints create no events: fetches use the same content-hash ledger, and the 60s backstop poll (ADR 0007) is unchanged, so dropped hints cost freshness and duplicates dedup away. After every usine write to GitHub (board label swap, agent comment), the engine hints itself, so the trigger surface responds instantly without webhooks.

`webhooks.mode` in `usine.yaml` (default `off`) selects a webhook mode:

- **`deliveries`** JWT-polls the App's delivery log about every 10s (engine-fixed). Summary fields (`repository_id`, `event`) route repo-level hints without fetching payloads. The cursor persists in the runtime store; `ping` and unregistered repos are ignored; redelivery is unused.
- **`endpoint`** serves HMAC-SHA256-verified (`X-Hub-Signature-256`) `POST /webhooks/github` on the orchestrator's HTTP server, taking item-level hints from payloads. It requires `webhooks.public_url`; usine `PATCH`es the App's hook URL on each mode or config change.

Bootstrap always creates the App webhook **active**, with a dead `.invalid` placeholder URL and generous slice-relevant events (issues, issue_comment, pull_request, pull_request_review, pull_request_review_comment, push, check_suite), and saves `webhook_secret` to `.usine/` at manifest conversion even with the mode off: only manual App settings can change the active flag or events later.

## Considered options

- **No webhooks in v1** (ADR 0007's position): the hint seam exists for self-writes anyway, with each mode a thin source behind it, so deferring saved little.
- **Webhooks as an event source**: would make delivery loss or duplication a correctness problem (GitHub never redelivers automatically; retention is 3 days). Ruled out at charting.
- **`deliveries` by default**: sub-10s latency with zero config, but while the docs say an always-failing placeholder persists, its lack of warnings or auto-disable is only observed. Opt-in keeps ADR 0007's default.
- **Inactive bootstrap hook until needed**: cleanest GitHub state, but activating it and adding events later is manual, and conversion may return no `webhook_secret`, so mode changes risk redoing setup.
- **Relaxing the backstop while hints are healthy**: saves rate limit at scale but adds a health heuristic blind to silent failure. `poll_interval` stays; relaxing can come later.

## Consequences

- **Revises [ADR 0007](./0007-polling-triggers-content-hashed-events.md)**: v1 has webhook delivery, as hints; the dedup ledger stays the only event gate.
- **Hint** joins the glossary. The seam is one interface over three sources (self-writes, delivery-log polling, endpoint); later sources (daemon workers, forge events) are additive.
- Bootstrap (#23) adds manifest `hook_attributes` and saves the secret with the private key.
- UI: Configuration shows the mode and last hint, and the needs-you strip warns if endpoint mode never received a delivery (wrong `public_url` or failed `PATCH`). The engine never reads hint health.
- Facts as of 2026-08-20: only active webhooks, always-failing ones included, record deliveries; retention is 3 days; `PATCH /app/hook/config` changes URL and secret, not `active`; nothing documents auto-disable, failure throttling, or reachability checks; ~10s JWT polling is well within limits.

## Board self-write implementation

Board label writes queue bounded, coalesced item hints in the poller, even after a failed or interrupted write, since GitHub may have applied part of the swap. The original outcome stands; writer rate limits extend hint backoff. The poller serializes each authoritative snapshot and loop evaluation with normal cycles, through the existing projection and ledger. Hints never advance a REST cursor or overwrite the last full cycle's findings; request backoff delays hint snapshots too.

## Deliveries implementation

The deliveries source extends `GitHubApp` for authenticated summary reads and reuses `CursorStore` for the last delivery ID, scoped to the installation. The `WebhookDeliveries` service owns the polling cadence and repository routing; it adds no transport or storage adapter. `Orchestrator` runs it beside polling and schedule triggers. The mode is read at startup, while each delivery cycle reads the current registry.

A cycle reads at most ten pages of 100 summaries and coalesces hints by registered repository. Reaching the page limit drops older hints and logs the decision. Each cycle has a 30-second timeout; typed failures retry after 10 seconds or GitHub's later rate-limit deadline. These limits affect freshness only. The normal poll and event ledger retain their existing behavior.

Repository hints use the existing repository cycle, including cursor updates, backoff, projection, and loop evaluation. Item hints continue to fetch a snapshot without advancing a REST cursor. Settings reports the last hint received in the running process; the engine does not use that timestamp for scheduling.
