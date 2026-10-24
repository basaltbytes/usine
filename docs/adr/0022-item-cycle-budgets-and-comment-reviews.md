# Item cycle budgets and comment-only agent reviews

Each item has a durable cycle budget shared by its loops: a loop opens at most `max_cycles` runs (default three) between operator resets. A round is each participating loop's nth run, so three review/fix rounds mean three reviews and three fixes. The admission that would exceed a limit opens one item-level ask and blocks every further run on the item, finishing loops included. Schedule ticks skip this limit.

Admission reserves a round in the run-opening transaction. Repeated events and retries never charge twice. A canceled run with no attempt returns its reservation; started runs keep theirs. This prevents concurrent overspending and ignores superseded work that never used a worker. Admitted runs still finish.

The ask records its item, loops, counts, and exhausted limit, and survives label changes and loops that stop matching. Reset answers are events bound to the ask, so a repeated answer can't reset a later budget. A reset records a durable re-poll request, and polling checks current state and active loops before opening work, never running a stale saved prompt. Nothing resets automatically (convergence, label removal, reload, restart).

This extends the per-attempt guards of [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md) without dollar budgets, and ADR 0017 with an item-level ask before any run exists. These asks are answered in Needs you; GitHub delivery and phone answers wait for the notifier (#36).

Agents share the App identity of ADR 0011. Agent reviews use GitHub's `COMMENT` event at the reviewed head commit, with loop-defined findings and outcome labels (the review/fix example's `agent-review-findings` and `review-passed`, each removing the other). A success label means no actionable issues, not a required review; the operator gives any required independent approval and merges.

This resolves the identity question in #77 without a second credential set: GitHub disallows approving your own PR, and personas or installation tokens don't change the App's authorship.

## Considered options

- **Count posted reviews in CEL**: depends on review text, misses runs that fail before posting, and can't durably block other loops.
- **Bound each attempt only**: retries and separate review and fix runs still loop endlessly.
- **Authored chain membership**: a second group definition per loop, though item identity already links the feedback path.
- **A second, approving GitHub App**: another credential set and setup step.

## Consequences

- On upgrade, completed run history and queued item events join the default budget; an item at its limit asks before its next run.
- Label changes, restarts, and loop renames don't clear asks. A new loop name starts at zero; loop-file edits are trusted operator configuration, not an agent's way to unblock an item.
- Trigger adapters capture the item's generation before fetching its snapshot. It's immutable in the event route and, after a reset, part of the dedup key. Queue selection and admission reject older observations, including polls in flight at the reset. Fresh polling yields a new event with the current task, agent, and limit; earlier queued events never enter the new allowance.
- Remove old CEL review-count workarounds from fix and finishing loops; the [migration guide](../../apps/docs/src/content/docs/guides/review-fix-loops.md) shows the replacement.

## Amendment (2026-10-24, #476): a closed or merged item closes its ask

An ask on a merged pull request stayed in Needs attention with a reset as its only action, though no loop acted on the item any more and a reset would only request fresh polling. Each poll now closes the ask of an item that is closed, merged, or gone with the reason `ItemClosed`. A closure isn't a reset: the generation and reservations stay, so the budget's history keeps counting, and a reopened item at its limit asks again. The closed ask is stored with its reason, so the record says why it left.
