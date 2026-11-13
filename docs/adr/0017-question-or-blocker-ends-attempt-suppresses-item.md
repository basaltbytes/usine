# A question or blocker ends the attempt and suppresses the item

An agent that needs an operator decision or can't resolve a blocker records it on the item and starts its final report with `[usine:question]` or `[usine:blocked]`. The attempt ends with a typed `QuestionFailure` or `BlockedFailure`, shown in Needs attention and never retried automatically. A child's marked report ends the attempt the same way: the Pi parent relays it verbatim, and the event-driven coordinator reads the marker itself.

A marker always decides. Without a marker, the event-driven coordinator completes the attempt with the report, unless the agent sets a `decision` model. That model reads the unmarked report and may end the attempt as `Blocked` or `Question`, with the same typed failure as a marker. The operator opts in per agent. The decision model returns one schema-checked decision, never free prose, and the coordinator's rules still check that decision. A refused, invalid, or failed answer leaves the rule in place. This keeps the misfire risk that rejected prose detection to agents whose operator chose a model that classifies reports. In exchange, a blocker or question that a child reports without the marker no longer completes the attempt.

The run's loop then suppresses the item: the first item state after the stop, usually the agent's own comment, opens no run. A later different state, a non-matching sighting, an operator retry, or marking the stop resolved lifts it. Without suppression, the agent's comment would open another run that stops again until the cycle budget ([ADR 0022](./0022-item-cycle-budgets-and-comment-reviews.md)) runs out.

The operator answers on the item and marks the stop resolved in the web UI; usine posts nothing to GitHub.

## Considered options

- **Ask-and-park**: the live attempt waits on an ask tool, holding a worker until the operator answers.
- **GitHub asks answered by reaction or reply**: a bot @mention on every blocked run is noise on public repositories.
- **Questions detected in prose by default**: misfire; a reserved marker works in every harness. Only an opt-in decision model classifies an unmarked report.
- **Suppressing on any item change**: the agent's own comment is a change.
- **A blocker as an ordinary `AgentFailure`**: the blocker comment opens the same run again.
