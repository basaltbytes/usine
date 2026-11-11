# A question or blocker ends the attempt and suppresses the item

An agent that needs an operator decision or can't resolve a blocker records it on the item and starts its final report with `[usine:question]` or `[usine:blocked]`. The attempt ends with a typed `QuestionFailure` or `BlockedFailure`, shown in Needs attention and never retried automatically. A child's marked report ends the attempt the same way.

The run's loop then suppresses the item: the first item state after the stop, usually the agent's own comment, opens no run. A later different state, a non-matching sighting, an operator retry, or marking the stop resolved lifts it. Without suppression, the agent's comment would open another run that stops again until the cycle budget ([ADR 0022](./0022-item-cycle-budgets-and-comment-reviews.md)) runs out.

The operator answers on the item and marks the stop resolved in the web UI; usine posts nothing to GitHub.

Built: the Pi parent relays a child's marked report verbatim. Decided, not built: the event-driven coordinator reads the child's marker itself (#1150, #1166).

## Considered options

- **Ask-and-park**: the live attempt waits on an ask tool, holding a worker until the operator answers.
- **GitHub asks answered by reaction or reply**: a bot @mention on every blocked run is noise on public repositories.
- **Questions detected in prose**: misfire; a reserved marker works in every harness.
- **Suppressing on any item change**: the agent's own comment is a change.
- **A blocker as an ordinary `AgentFailure`**: the blocker comment opens the same run again.
