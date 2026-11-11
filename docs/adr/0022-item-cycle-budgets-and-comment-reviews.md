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

## Amendment (2026-11-07, #1028): replay blocked CI fix events on reset

A CI fix can exhaust the cycle budget after its source run removes the trigger label. Refreshing label triggers then produces no work, although the ask identifies the blocked CI event. Reset moves only the ask's recorded, unclaimed CI fix events into the new generation, including events that earlier label polling marked revoked. Ordinary queued trigger matches retain their old generation and require fresh evaluation.

CI fixes preserve their recorded prompt and failure evidence, along with inherited completion actions. Their loop settings follow the 2026-11-08 amendment below.

Reconciliation checks the current loop, repository selection, PR state, failed head, and checks before admission; paused loops keep the event queued. CI fixes bypass the loop's `if:` expression and can open its first run on an item. Open-PR revocation preserves queued and unstarted CI fixes only for the observed head while checks fail, or while checks are absent and mergeability is `CONFLICTING` or `UNKNOWN`. This exemption applies to every `if:` mismatch, including draft status and excluded labels. A new head or checks that stop failing revokes approval-waiting fixes as well as queued events. When the loop's `if:` rejects a closed or merged item, or the item is missing, polling revokes queued CI events and unstarted CI fix runs. A non-matching trigger observation still clears suppression, including an unanswered question; pausing the loop keeps queued fixes waiting independently of trigger observations.

Reconciliation excludes events blocked by an open budget ask or suppression, preserving the ask's recorded blocks until a new trigger observation or reset. Polling requests reconciliation before acknowledging a reset, and startup and periodic reconciliation recover pending events after interruption. Admission still applies the cycle budget and approval gate atomically.

## Amendment (2026-11-08, #1047): replayed CI fixes take the current loop settings

Keeping the saved approval, agent, models, permissions, CI policy, and cycle limit on a replayed CI fix meant an operator who set `approval: required` and then reset got no gate, although new work after a reset uses current configuration. A queued CI fix now takes these settings, with outcome labels, from its loop when its run opens; the prompt, failure evidence, and completion actions stay as recorded, because they describe the failure the fix answers. The generated CI handoff instructions are rebuilt from the current CI policy so the task and admission use the same policy. The trigger recheck already reads the current loop, so it returns the refreshed settings and admission records them.

When a CI fix and a trigger match wait on the same loop and item, candidates are rechecked from newest to oldest. A non-matching CI fix recheck revokes only that event and continues with the next candidate. A trigger mismatch revokes the trigger matches from that queue read together while preserving CI fixes for their own rechecks. Trigger matches share the item-level condition, so repeating their snapshot reads could admit an older event after a GitHub read error even though the previous read rejected the item. Revocation applies only to the queue read before the recheck, preserving events that arrive during it. The first matching event opens the next run and supersedes older events. A missing item revokes the whole queued group. Reconciliation skips items with an open run, so a CI fix queued behind a running attempt costs no GitHub recheck. The reset answer returns the CI fix events it replayed, and a failed source run in Needs attention links to the newest admitted fix run that has not been canceled or revoked.

## Amendment (2026-11-11, #1047): replayed CI fixes fail closed

A reset brings back CI fix events that were revoked or superseded. If the recheck failed open, a GitHub outage during the first reconcile after a reset could admit a fix for a head that a newer push had already replaced. A recheck that can't read the item now returns `Undetermined`, and a CI fix stays queued until a later reconcile reads the pull request. A trigger match still opens with its saved settings, because polling revokes it when the item stops matching.

The recheck returns only the settings and task the run opens with, not a whole submission, so the engine keeps the event, item, revision, cycle generation, and CI evidence as recorded. Reconcile reads the admissible queues once and admits each one, whatever the kind of its newest event. The reread after a mismatch skips items with an open run. A reset whose repository is no longer configured is acknowledged by polling, so CI reconciliation stops admitting replayed fixes for it. Unpausing a loop admits its queued CI fixes at once.

## Amendment (2026-11-08, #1009): verified outcome labels

A successful agent message does not prove that a review published its verdict. Loops declare their accepted verdicts with `outcome_labels`; any one listed label must have been added by an account used by the Run at or after its first Attempt started, even if another loop removed the label before settlement. The review example declares `review-passed` and `agent-review-findings`. Existing loops retain an empty requirement until configured because label names belong to the operator's loop definition.

The requirement is saved with the event. The engine's required `CompletionCheck` service verifies a successful completion before the attempt closes, including a completion recovered after restart. The orchestrator reads label events through GraphQL for the GitHub accounts used by all of the Run's Attempts. If the events cannot be read or a Worker is no longer configured, it checks the current labels through REST. The event read, including bot-account lookup and all writers, and the current-label read each have a 15-second timeout and two retries after one and two seconds. Timeouts and transient failures retry; definite refusals and missing items stop immediately. A missing verdict or an exhausted read retry is a non-retryable `AgentFailure` in Needs attention. Verification must not rerun an agent that has already published its work. Hosts provide the required service at composition time. Hosts that do not verify labels explicitly provide `CompletionCheck.unverified`, which accepts the completion and logs a warning. An empty requirement skips verification.

The executor remains responsible for running agents and harvesting their output. The completion check is separate because accepting an outcome requires an authoritative GitHub read after execution, and stored completions must pass the same check. CI handoff labels retain the separate completion rules of ADR 0033.


## Amendment (2026-11-08, #1076): verdict events across Attempts

A consumer loop can remove a verdict before the producing Attempt settles. Reading label events preserves that verdict and rejects labels from earlier Runs. The engine supplies the Run's Attempt history so an automatic or operator retry can reuse an earlier verdict, including when a different Worker kind uses a different GitHub account. The first Attempt's start, rounded down to GitHub's second precision, defines the event boundary. Verification runs once before the retried store write, and a rejected completion retains its message and facts on the failed Attempt without updating the Step result.
