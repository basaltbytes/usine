# Polling triggers: content-hashed events over payload slices

v1 watches GitHub by polling only. Change detection is one REST call per registered repo (`GET /repos/{o}/{r}/issues?since=<watermark>&state=all&sort=updated`, which covers issues and PRs alike) under an ETag — authenticated 304s are rate-limit-free, so idle repos cost nothing; only items that actually changed get their payload slice fetched via GraphQL. An Event exists when a changed item's slice content — canonicalized, timestamps excluded — hashes to a value unseen for (loop, repo, item) *and* the loop's `if:` matches; the ledger is permanent, so a state once seen never fires again. Schedule triggers fan out one Event per selected repo per tick (`cron:` + IANA `tz:`), catching up only the latest missed tick after downtime.

## Considered Options

- **Webhooks in v1** — needs a public endpoint (or GitHub App delivery polling) and per-org setup; breaks local-first zero-config. Polling plus a permanent dedup ledger delivers the same correctness; push delivery stays an additive latency upgrade (its own ticket).
- **All-GraphQL polling** — one protocol, but GraphQL has no conditional requests (idle polls burn points) and the 2025 opaque resource limits can partial-fail rich fan-out queries.
- **Search-API sweep** — O(1) calls for N repos, but a 30 req/min cap, a 1,000-result window, and the legacy-vs-advanced OR/AND repo-qualifier trap.
- **updated_at or edge-triggered event grain** — timestamp keys fire on touches the slice can't see; edge-triggering (fire only on `if:` false→true) misses same-item-new-state re-fires (reviewing each push), which the acceptance loops require.

## Consequences

- Stream catalog: `issue`, `pr`, `schedule` — engine-owned. Slices (fixed connection caps with `totalCount` alongside every list, `last:` where recency matters) are recorded in the Triggers ticket resolution; widening a slice is additive.
- Timestamps stay in the payload but out of the hash: re-nudging is a UI retry, not a GitHub touch.
- The Event's stored snapshot is what `if:`, `{{ }}` interpolation, and the context preamble read — for every attempt of the run. Freshness is supersede's job, not re-fetching.
- **Revises [ADR 0002](./0002-run-model-event-run-step-attempt.md)**: supersede replaces only runs with no started attempt; during a running attempt, newer events are held and re-judged against current state when it ends. Unmatch (state stops matching `if:`) likewise revokes pending/waiting runs only. Nothing but the operator cancels a running attempt — which makes both authoring styles safe: label-protocol claims (whose swap unmatches the item by design) and derived-state `if:` (whose own incremental work product would otherwise self-supersede).
- Cold start fires on all existing matching state — no baseline mode; worker concurrency caps (FIFO, oldest event first) and approval gates are the throttles.
- One factory-wide `poll_interval` (default 60s) in `usine.yaml` settings; slow-down under rate-limit pressure is engine behavior, not configuration.
- **Revised by [ADR 0014](./0014-webhook-delivery-as-hints.md)**: v1 does ship webhook delivery — as Hints that only move a fetch earlier (default off); polling stays the sole correctness source.
- Detection granularity is the item's own `updated_at`: cross-item slice edges (an issue's linked PRs) refresh only when the item itself changes — an accepted v1 limit.
