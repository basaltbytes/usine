# Takeover and edit-and-retry: operator input reaches the live session, never the event ledger

An operator steers, interrupts, messages, or releases the parent or a child of a running attempt. The engine sends it to the live session through `Executor.intervene`, records it and its receipt in the transcript, and flags the attempt as operator-intervened. Operator input never becomes an event; chat turns would fill the ledger of facts that open runs.

An operator message places a hold; a steer doesn't. A held child keeps its result from the parent until released, so the parent is never cut out. A held parent's next answer doesn't end the attempt, so the exchange can span turns; a release resumes the task. An interrupt pauses the session until new input or a release. The runaway wall clock excludes held time.

An attempt whose last turn answered the operator, with no commit, pull request, comment, or step output, fails with `AgentFailure` instead of succeeding without work.

Edit-and-retry retries a failed run with a changed task text or agent. The change becomes the run's effective context for every later attempt, automatic retries included.

Built: the Pi parent forwards a parent steer to its only live child. Decided, not built: the event-driven coordinator has no parent session; parent-addressed input goes to the live child (#1150, #1163).

## Considered options

- **Detach-and-own takeover**: cuts the parent out and forks the result path.
- **Child steer only**: no multi-round exchange.
- **Explicit claim and release envelopes**: a channel state machine that an implicit hold avoids.
- **No hold**: a parent's answer to the operator ended the run as `Succeeded` mid-task (#159).
- **One-shot amendments**: an automatic retry would revert the fix.
- **Editing the composed prompt or the event**: fights prompt assembly, or detaches the attempt from its event.
