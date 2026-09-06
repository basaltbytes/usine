# Webhook delivery ships in v1 as hints; polling stays the only correctness source

v1 adds push-based delivery as a **Hint**: a droppable `(repo, optional item)` nudge that schedules the existing change-detection / slice fetch sooner — never a new event path. Hints create no Events; the fetch they accelerate feeds the same content-hash ledger, and the 60s backstop poll (ADR 0007) runs unchanged, so a dropped hint costs freshness and a doubled hint dedups to nothing. Self-write hints are always on: after any usine write to GitHub (board-drag label swap, agent comment), the engine hints itself — the trigger surface feels instant without webhooks. The two webhook modes sit behind one authored knob, `webhooks.mode` in `usine.yaml` (default `off`): **`deliveries`** JWT-polls the App's webhook-delivery log on an engine-fixed ~10s cadence — summary fields (`repository_id`, `event`) route repo-level hints without payload fetches, the cursor persists in the runtime store, `ping` and unregistered repos are ignored, the redelivery API is unused; **`endpoint`** serves `POST /webhooks/github` on the orchestrator's existing HTTP server, HMAC-SHA256-verified (`X-Hub-Signature-256`), taking item-level hints from payloads, with `webhooks.public_url` required and usine itself `PATCH`ing the App's hook URL on every mode/config change. Bootstrap always creates the App webhook **active** — placeholder URL on a dead `.invalid` host, generous slice-relevant events (issues, issue_comment, pull_request, pull_request_review, pull_request_review_comment, push, check_suite) — and captures `webhook_secret` into `.usine/` at manifest conversion even while the mode is off, because the active flag and event subscription have no API: set at creation, or eat a manual App-settings excursion later.

## Considered Options

- **No webhooks in v1** (ADR 0007's original posture) — but the hint seam must exist anyway for self-writes, and each webhook mode is a thin source behind it; deferring bought little once correctness stopped being at stake.
- **Webhooks as an event source** — deliveries minting Events directly would make delivery loss/duplication a correctness problem (GitHub never auto-redelivers; retention is 3 days). Ruled out at charting; everything here inherits it.
- **Default `deliveries`** — sub-10s latency everywhere, zero config; rejected for `off` because the perpetually-failing placeholder webhook is stable per docs but the no-nag/no-auto-disable behavior is absence-of-evidence, not a guarantee. Opt-in keeps the default posture exactly ADR 0007.
- **Bootstrap hook inactive until a mode needs it** — cleanest GitHub state, but flipping `active` (and widening events) later is a manual settings-UI step and the manifest conversion may return no `webhook_secret` to capture; every later mode change would risk a ceremony re-run.
- **Auto-relaxing the backstop cadence while hints are healthy** — saves rate limit at fleet scale but adds a health heuristic with a silent-death blind spot; `poll_interval` stays untouched, relaxation stays additive engine behavior per ADR 0007.

## Consequences

- **Revises [ADR 0007](./0007-polling-triggers-content-hashed-events.md)**: v1 does ship webhook delivery — as hints that only move a fetch earlier; polling remains the sole correctness source and the dedup ledger the sole event gate.
- **Hint** enters the glossary; the seam is one interface with three sources (self-writes, delivery-log polling, endpoint), so later sources (daemon workers, forge events) are additive.
- Bootstrap (issue #23) gains `hook_attributes` in the manifest and secret capture alongside the private key.
- UI: Configuration shows the mode and last-hint-received; the needs-you strip warns when endpoint mode has never received a delivery (wrong `public_url` or failed `PATCH`) — display + warn only, engine behavior never consults hint health.
- Facts this leans on (researched 2026-08-20): deliveries are recorded only for an active webhook, including 100%-failing ones; delivery retention 3 days; `PATCH /app/hook/config` changes URL/secret but not `active`; no documented auto-disable, failure throttling, or reachability validation; ~10s JWT polling is trivially within all documented limits.

## Board self-write implementation

Board label writes enqueue bounded, coalesced Item Hints in the poller even when
a write fails or is interrupted, since GitHub may have applied part of the swap.
The original outcome is preserved, and writer rate limits extend Hint backoff. Its single
owner serializes each authoritative snapshot and Loop evaluation with normal
repository cycles, using the existing projection and content-hash ledger. A Hint
does not advance a REST cursor or overwrite the last complete cycle's findings.
The normal conditional-poll cadence remains unchanged; separate request-backoff
metadata also delays Hint snapshots. Failed or dropped Hints rely on the poll
backstop. Webhook sources and other GitHub write sources remain separate work.
