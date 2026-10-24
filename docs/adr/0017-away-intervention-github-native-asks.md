# Away intervention: GitHub-native asks answered by reaction or reply; questions park the attempt

The single operator must unblock runs from a phone with **no inbound path** to the orchestrator, so the notification must include the action, and both go through GitHub. When a run blocks (approval wait, agent-failed attempt, runaway trip, agent question), the engine posts an **ask**: an @mention comment by the App bot on the run's item. The bot's separate identity ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)) triggers the operator's GitHub notifications, which the mobile app pushes. Two kinds:

- A **yes/no ask** has a fixed minimal summary (loop, agent, what's needed, typed error class name), never error detail, transcript excerpts, or costs, since managed repos can be public. A reaction answers it: 👍 approves, retries, or restarts; 👎 cancels the run.
- A **question** posts the agent's question, as a developer would in the thread; a reply that @mentions the bot answers it.

Both are checked against the operator's GitHub login. Answers are events, through the same polling and ledger ([ADR 0007](./0007-polling-triggers-content-hashed-events.md)). Yes/no answers resume runs between attempts, like the approval gate of [ADR 0002](./0002-run-model-event-run-step-attempt.md); a question's answer goes down the live attempt channel: **ask-and-park**. The attempt stays alive, its Pi parent blocked on the ask tool, so the agent can have a multi-round clarification on the issue thread. The runaway wall clock pauses while an ask is open.

Only run-blocking moments notify. Instance-health warnings (quarantine, registry drift, pool thresholds, webhook misconfiguration) stay on the needs-you strip. A **notifier seam** makes other channels (ntfy, Web Push, desktop) additive.

## Considered options

- **Custom push (ntfy or Web Push) in v1**: no repo noise, and covers item-less runs, but adds accounts and config, and without an inbound path it can't enable action. Additive behind the seam, not primary.
- **Deep links assuming Tailscale-style reachability**: make the web UI the only place to act and reachability a hidden requirement, breaking local-first. Phone access to the UI is a bonus, never assumed.
- **Label protocol for approval**: fits the label-loop idiom, but labels are item-scoped (ambiguous with two waiting runs on one item) and need removal after use. The run-scoped ask reaction won.
- **Comment commands (`/approve`, `/retry`)**: invents a parse vocabulary for a tap's job; questions need prose but only @mention addressing.
- **Ask-and-end for questions** (a typed needs-input outcome ends the attempt, and the answer event starts the next, like Inngest's `waitForEvent`): no held workers and restart-proof, but kills multi-round clarification, the point of asking. Rejected: parking is cheap here, since exe.dev workers are persistent VMs and a local run host is one blocked process.
- **Any operator comment as the reply**: zero ceremony, but a casual remark becomes the answer. Replies must @mention the bot and bind to the item's oldest open question.

## Consequences

- **Ask** joins the glossary. Asks and the needs-you strip show the same moments, one ask comment per transition, never edited or re-pinged.
- GitHub sends no reaction webhooks, so the engine polls each open ask's reactions (one small request each); replies arrive through item polling and hints (about 10s to 60s).
- Revises [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md): the runaway wall clock pauses while an ask is open, since waiting on the operator isn't a runaway (and parked sessions accrue no tokens).
- Additive to [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md): ask and answer envelopes join the attempt channel. A parked attempt waits indefinitely (no v1 timeout; 👎 always works). Channel loss or a restart while parked is the existing typed retryable failure: the capped retry starts a fresh attempt with the prior transcript, so answered questions aren't re-asked, but session state is rebuilt, which v1, without reattach, accepts.
- Additive to [ADR 0005](./0005-pi-parent-agent-layer-team-roster.md): usine's Pi extension gets the ask tool.
- Bootstrap (#23) saves the operator's GitHub login to `usine.yaml`; @mentions and answer checks read it.
- Schedule-stream runs have no item to ask on, so only the strip shows them until a custom notifier, the seam's first user, exists.

[ADR 0022](./0022-item-cycle-budgets-and-comment-reviews.md) extends this decision with durable item cycle budgets, operator reset asks, and comment-only reviews under the shared App identity.

## Amendment (2026-10-18, #241): a question ends its attempt until the ask tool exists

The ask tool and GitHub notifier (#36) aren't built, yet agents stopped to ask. They posted the question and ended with a blocker, and their comment, as new content, opened a run that asked again until the cycle budget ran out. Meanwhile, an agent asks by starting its final answer with the reserved marker `[usine:question]`. The attempt ends with a typed `QuestionFailure`, never retried automatically, shown in Needs you. Markers like `[usine:blocked]` are the one channel every harness child shares with the parent; detecting questions in prose would misfire.

The run's loop then suppresses the item: the first state after the question, usually the agent's comment, opens no run. The suppression lifts when the item moves on (a reply, a push, or a non-matching sighting), on retry, or when the operator marks the question answered, which re-evaluates the newest state. It applies to the first state, not any change, because the question's comment is a change; the operator can always answer from the UI. This is the ask-and-end option, one clarification round per attempt.

## Amendment (2026-10-19, #341): a blocker suppresses the item like a question

An agent that hits an unresolvable blocker records it on the item, as the prompt asks, and starts its final answer with `[usine:blocked]`. Its attempt used to fail with `AgentFailure`, which doesn't suppress the item, so the comment opened another run that usually posted the same blocker until the cycle budget ran out: the loop the amendment above removed for questions.

A blocker is effectively a question: the agent can't continue until something changes, and said so on the item. The marker now ends the attempt with a typed `BlockedFailure`, never retried automatically, and the loop suppresses the item as for `QuestionFailure` until another content change, a non-matching sighting, an operator retry, or marking the run resolved. An unrelayed child blocker fails the attempt the same way. The cycle budget exists to stop non-converging review and fix rounds, not to count repeats of a known stop at an attempt and a comment each. Other `AgentFailure` causes (a harness not logged in, an unusable model) post nothing, so they don't reopen and are unchanged.

2026-10-19 (#364): a child's harness failure posts nothing on the item either, so it reaches the parent as `[usine:failed]` instead of `[usine:blocked]` and ends the attempt with `AgentFailure`. Only an agent's own `[usine:blocked]` suppresses the item.

2026-10-23 (#489): renames the item-level hold to suppression; hold now means only the session hold.
