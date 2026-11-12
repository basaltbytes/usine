# Item cycle budgets and comment-only agent reviews

Each item has a durable cycle budget that its loops share: a loop opens at most `max_cycles` runs on the item (default three) between operator resets. A round is each loop's nth run, so three review and fix rounds are three reviews and three fixes. Schedule loops have no budget.

Admission reserves the round in the run-opening transaction, so concurrent events can't overspend and a retry never charges twice. A run canceled before its first attempt doesn't count. The admission that would exceed a limit opens one ask for the item and blocks every further run on it. The operator answers the ask in Needs attention with a reset, which starts a new cycle generation and has polling reevaluate the item. New work then uses the current item state and configuration; events queued before the reset never enter the new allowance, except the CI fixes that the ask blocked, which polling wouldn't find again. The reset lifts every revocation or supersession of those fixes, since admission rechecks each one. A replayed CI fix opens with its loop's current settings only after a recheck reads its pull request. When GitHub can't answer, the fix stays queued, because failing open could admit a fix for a head that a newer push replaced. Labels, restarts, and loop edits never reset a budget, so an agent can't unblock an item by editing it. An ask on a closed, merged, or missing item closes without a reset.

Agents share the App identity ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)), and GitHub refuses an approval from a pull request's author, so agent reviews use the `COMMENT` event at the reviewed head commit. A review reports its verdict with the loop's outcome labels; a loop that lists `outcome_labels` fails a successful attempt when its run added none of them. A passing label isn't an approval; the operator approves where GitHub requires it and merges.

## Considered options

- **Counting posted reviews in CEL**: depends on review text and misses runs that fail before posting.
- **Per-attempt guards only** ([ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)): each review and fix run succeeds, so the pair never stops.
- **Authored chain membership**: a second group definition, where the item already links the loops.
- **Automatic resets on convergence or label removal**: an agent's own label writes would unblock the item.
- **A second, approving GitHub App**: another credential set and setup step.
