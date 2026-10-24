# Run model: Event → Run → Step → Attempt

usine adapts Inngest's run model, not n8n's or Temporal's ([run-model research](https://github.com/basaltbytes/usine/blob/research/run-models/docs/research/run-models.md)). A deduplicated event has at most one open run. A run's work is named steps with stored results (one in v1); each try of a step is an attempt. Dedup keys, derived per trigger type, never expire: usine never acts twice on the same state, unlike Inngest's 24-hour window. A coarser item key lets a newer event supersede a stale open run.

## Considered options

- **n8n's shape** (a trigger firing is a run; a retry is a new linked run): conflates identity and splits one piece of work's history.
- **Temporal's shape**: usine borrows its business-key uniqueness, not its replay determinism or server cluster, since memoized step results already give resumability.
- **Inngest's shape as-is**: the closest fit, but its 24-hour idempotency window breaks the permanent guarantee, and coupling triggers to runs hides the event as a row.

## Consequences

- Run states: `pending` → `waiting` (per-loop approval gate) → `running` → `succeeded` / `failed` / `canceled`. Retry moves `failed` to `running` (attempt N+1, optional steering text); cancel or supersede moves any open state to `canceled`.
- An approval is an event the waiting run consumes, deduplicated and auditable like any fact; it's v1's only waiting reason.
- Step names in the loop are step identity, as filenames are loop identity ([ADR 0001](./0001-loops-live-in-the-instance-repo.md)). Renaming a step retires it; earlier results stay under the old name.
- Automatic retry covers only typed infra errors, capped at 2–3 attempts. Agent failures wait for the operator.
- Polling cursors only save work; the dedup key is the guarantee.
- **Revised by [ADR 0007](./0007-polling-triggers-content-hashed-events.md)**: supersede acts only on runs with no started attempt. A running attempt finishes, and the newer state is evaluated when it ends.
- **Revised by [ADR 0018](./0018-takeover-and-edit-and-retry.md)**: retry's steering text becomes the run's effective context (task text and agent), which edit-and-retry changes for all later attempts. Attempt rows get an operator-intervened flag.
- **Revised 2026-09-03**: an approved run moves to `queued` (gate passed, no attempt yet) instead of staying `waiting` until a worker slot frees. The board showed both alike, so an approved run behind a busy worker looked unapproved, and repeat approvals succeeded silently. Repeat approvals are now rejected. Supersede and revoke apply to `queued` as to `pending` and `waiting`.
- **Revised 2026-10-19 ([#152](https://github.com/basaltbytes/usine/issues/152), [#342](https://github.com/basaltbytes/usine/issues/342))**: the operator can run a succeeded or canceled run again. A run can succeed with its item unresolved (its agent hit a blocker), and a cancel followed by a label round trip within one poll interval looks unchanged. Before, acting again needed a GitHub edit that changed the content hash.

  Run again records a new event for the same item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`, where `n` counts that state's reopenings ([ADR 0007](./0007-polling-triggers-content-hashed-events.md), #267). The polled event keeps its key and run, so polling never acts twice. Later sightings of the unchanged item join the newest reopening's run.

  The new run takes the task text and agent that edit-and-retry can change ([ADR 0018](./0018-takeover-and-edit-and-retry.md)), the current loop file's step, approval requirement, and cycle limit, and the item's current cycle generation, so the approval gate and cycle budget apply. Failed runs are retried instead. The request is refused while another run of the same loop is open on the item. The event records the requesting operator's login, like an approval. Paused loops can run again: pause stops triggers, not operator actions on one item.

  #342's other remedy, a sighting with `updated_at` newer than the cancel, would make a timestamp part of event identity, which ADR 0007 excludes.
