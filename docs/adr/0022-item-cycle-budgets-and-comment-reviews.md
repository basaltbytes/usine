# Item cycle budgets and comment-only agent reviews

An Item has a durable cycle budget shared by its Loops. Each Loop may open at most
`max_cycles` Runs between explicit operator resets, default three. A round is the
nth Run of each participating Loop: three review/fix rounds permit three reviews
and three fixes. The next admission that exceeds a Loop's limit opens one Item-level
Ask and blocks all further Runs on that Item, including finishing Loops. Schedule
Ticks have no Item feedback cycle and do not use this limit.

Admission reserves a round in the same transaction that opens its Run. Repeated
Events and Attempt retries never charge twice. A canceled Run with no Attempt
returns its reservation; started Runs keep theirs regardless of outcome. This
prevents concurrent admissions from overspending while excluding superseded work
that never used a Worker. Runs already admitted retain their reserved allowance
and finish; the Ask prevents admission of further Runs.

The Ask records its Item, participating Loops, counts, and exhausted limit. It
persists even when labels change or Loops stop matching. Reset answers are Events
bound to the Ask identity, so a repeated answer cannot reset a later budget. Reset
also records a durable request to re-poll the repository. Polling fetches current
state and checks active Loops before opening work; reset never executes a saved
stale prompt directly. There is no automatic reset on convergence, label removal,
configuration reload, or process restart.

This extends [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)'s per-Attempt guards without introducing dollar budgets.
It also extends ADR 0017 with an Item-level Ask before a Run exists. These Asks are
actionable in the operator UI's Needs you strip; GitHub delivery and phone answers
belong to the notifier feature tracked in #36.

All Agents retain the shared App identity from ADR 0011. Agent reviews use GitHub's
`COMMENT` event at the reviewed head commit, with findings and outcome labels
defined by the Loop. The review/fix example uses `agent-review-findings` and
`review-passed`; either outcome removes the opposite label. A success label means
the agent found no actionable issues and does not satisfy GitHub required-review
rules. The operator supplies any required independent approval and merges.

This resolves the identity decision in #77 without introducing a second credential
set. GitHub disallows approving one's own PR; distinct personas or installation
tokens do not change the App's author identity.

## Considered Options

- Count posted reviews in CEL: the limit depends on review text, misses Runs that
  fail before posting, and cannot durably block other Loops on the Item.
- Bound each Attempt only: retries and separate review/fix Runs still permit an
  endless sequence of bounded Attempts.
- Add authored chain membership: makes every Loop author maintain a second group
  definition. The existing Item identity already connects the feedback path.
- Use a second GitHub App for approving reviews: introduces another credential set
  and operator setup requirement. Comment reviews plus explicit labels preserve
  the shared identity and leave required independent approval to the operator.

## Consequences

- Existing completed Run history and queued Item Events join the default budget
  during upgrade. An Item already at its limit asks before the next Run opens.
- Changing labels, restarting, or renaming a Loop cannot clear an existing Ask.
  A new Loop name has no prior count before exhaustion; Loop-file edits are trusted
  operator configuration, not an agent-controlled way to resume a blocked Item.
- Queued Events carry the generation in which a trigger last confirmed them.
  Queue selection and admission exclude older generations until fresh polling
  confirms that each Event still matches, including on later pages of a backlog.
- Old CEL review-count workarounds should be removed from fix and finishing Loops;
  the [migration guide](../guides/review-fix-loops.md) shows the replacement.
