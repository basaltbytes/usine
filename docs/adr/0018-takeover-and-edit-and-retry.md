# Takeover and edit-and-retry: operator input reaches the live session, never the event ledger

An operator steers, interrupts, messages, or releases a session of a running attempt. The engine sends the input to the live session through `Executor.intervene`, records it and its receipt in the transcript, and flags the attempt as operator-intervened. Operator input never becomes an event; chat turns would fill the ledger of facts that open runs.

Input addressed to the parent goes to the Pi parent when the attempt has one; the parent forwards a steer to its only live child, and takes a separate turn when no child accepts it. An attempt on the event-driven coordinator has no parent session, so parent-addressed input goes to its live child, and is rejected when no child is live. The runaway guard's warning is a parent steer and takes the same route.

An operator message places a hold; a steer doesn't. A held child keeps its result until released, so its parent or coordinator is never cut out. A held parent's next answer doesn't end the attempt, so the exchange can span turns; a release resumes the task. An interrupt pauses the session until new input or a release. Holds, pauses, and queued input survive an orchestrator restart: pi-durable keeps them for the Pi parent, and the attempt journal for the coordinator. The runaway wall clock excludes held time.

An attempt whose final answer replied to the operator, with no commit, pull request, comment, or step output, fails with `AgentFailure` instead of succeeding without work. The Pi parent's answer replied if its last turn followed operator input and delegated nothing; a child's answer replied if the child read operator input after its last tool call.

Edit-and-retry retries a failed run with a changed task text or agent. The change becomes the run's effective context for every later attempt, automatic retries included.

## Considered options

- **Detach-and-own takeover**: cuts the parent out and forks the result path.
- **Child steer only**: no multi-round exchange.
- **Explicit claim and release envelopes**: a channel state machine that an implicit hold avoids.
- **No hold**: a parent's answer to the operator ended the run as `Succeeded` mid-task (#159).
- **One-shot amendments**: an automatic retry would revert the fix.
- **Editing the composed prompt or the event**: fights prompt assembly, or detaches the attempt from its event.
