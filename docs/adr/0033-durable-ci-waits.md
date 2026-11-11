# Durable CI waits

A CI wait is run state, not agent work. An attempt that pushed to a pull request ends its session, and the run stays open in `AwaitingCi` with the pull request, the pushed head, the fix loop, the deadline, and the label actions to apply when CI passes. The worker slot is released, no model runs while checks are pending, and a restart keeps the wait. A wait starts from the agent's CI handoff, or from a pushed pull request under the loop's `ci` policy, which the trigger event captures so that a later edit can't drop it. Polling and repository hints read the checks.

CI on the recorded head decides the outcome:

- Green checks apply the label actions, and the run succeeds.
- Failed checks, or a merge conflict that keeps checks from starting, submit one event to the fix loop through the ordinary cycle budget and approval. Once the fix is admitted, the source run closes as `HandedOff`, a neutral outcome, and the fix inherits the label actions.
- A newer head or a closed pull request cancels the wait.
- Checks still pending at the deadline, or CI that ran only in part, fail the run for the operator without an automatic retry.

## Considered options

- **The agent watches CI in its session**: holds a worker slot and a model session for the length of a CI run.
- **An automatic retry at the CI deadline**: starts an agent for stalled CI that it can't fix.
