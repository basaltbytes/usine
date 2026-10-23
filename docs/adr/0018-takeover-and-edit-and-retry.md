# Takeover and edit-and-retry: session-addressed interventions, held children, persistent amendments

Takeover is conversing inside a live session. Inbound attempt-channel envelopes (steer, interrupt, operator message) get a **session target**: the Pi parent by default, or a harness child by its event-stream id. Operator messages join that session as user turns through the subagents extension's streaming-input bridge, which every harness backend supports. The first operator message to a child places a **hold**: an idle held child keeps its result from the waiting parent until released, while the parent's spawn call keeps waiting, so the parent is never cut out. Holds are per child and concurrent; the parent returns to no one, so it has none.

**Edit-and-retry** amends a failed run before its next attempt: the **task text** (the interpolated loop body; the engine sets the preamble, and the persona comes from the agent) and, optionally, the roster agent. Amendments **persist** in the run's effective context for every later attempt, capped automatic retries included, until amended again.

Neither adds entities. Operator messages, holds, and releases are attributed transcript envelopes, never events, and attempt rows get an **operator-intervened** flag. Each attempt records the task text and agent it ran (ADR 0005's observe-by-record). The runaway wall clock pauses during a hold, as during an ask, since operator presence is supervision; the token ceiling stays armed.

## Considered options

- **Detach-and-own takeover** (the spawn call resolves as taken over, and the operator finishes the child): rejected, because it cuts the parent out and forks the step-result path.
- **Child steer only** (one text at the child's next tool boundary): rejected. Multi-round exchange is the point of attaching, as with ask-and-park over ask-and-end ([ADR 0017](./0017-away-intervention-github-native-asks.md)).
- **Claim/release mode** (explicit envelopes bracketing an exclusive recorded span): rejected as heaviest; the implicit hold defers completion without a channel state machine. **No hold** (the idle child returns, racing the operator) is unusable.
- **Interventions as events**: rejected, since chat turns would fill the ledger. Events stay facts that open runs or that runs consume (triggers, approvals, ask answers); in-flight interaction belongs in the transcript.
- **Other edit scopes**: steer text only (ADR 0002's retry steering), the composed prompt (fights the three-part assembly and the persona passed to children), all three parts (three surfaces to explain and record), or a refreshed snapshot (the attempt would no longer read its event). Rejected for task text and agent.
- **One-shot amendments**: rejected, since an infra-error automatic retry would silently revert the fix.

## Consequences

- Additive to [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md): inbound envelopes have a target session id, and operator-message and release types join the versioned, transport-agnostic channel. A parent parked on an ask (ADR 0017) doesn't prevent taking over a live child.
- Revises [ADR 0002](./0002-run-model-event-run-step-attempt.md): retry's steering text becomes the persistent effective context (task text and agent), with the operator-intervened flag. Edit-and-retry uses the existing `failed` → `running` transitions, runaway restarts included.
- Revises [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md) as ADR 0017 did: the wall-clock pause extends from open asks to open holds; the token ceiling stays armed.
- In the run drawer of [ADR 0008](./0008-web-ui-projects-kanban-spine.md), the parent transcript and each child's events become chat surfaces with per-child release, and failed runs get the edit-and-retry form (task text, roster agent). UI only: a GitHub 👍 restart (ADR 0017) never includes edits.
- An agent swap derives persona and brain spec from the new agent, and usage goes to its pool per child (ADR 0013).
- **Takeover**, **hold**, and **edit-and-retry** join the glossary.

## Amendment (2026-10-08, #176): interventions reach the parent through the durable runtime

On local workers, the Pi parent and children are durable conversations in the orchestrator, with no inbound frame channel. Steer, interrupt, operator messages, and release go to `AttemptRuntime.intervene`, which delivers them and records the envelope and its receipt in the transcript with the task's sequence numbers. Records are unchanged, so holds, the flag, and the wall-clock pause still work. The executor rejects input only for attempts with no live session here, including those awaiting reattach. exe.dev still uses the run host's channel.

## Amendment (2026-10-19, #159): the parent has a hold

An operator message to the Pi parent places a hold, as on a child: its next answer doesn't end the attempt, another message starts its next turn, and a release resumes it with an instruction to continue the task. A release while it works only ends the hold, so the next answer ends the attempt. Steers place no hold.

Since #176, though, the parent does return something: its last answer is the attempt's result. A 2026-09-17 dogfood run showed the cost of no hold, the option rejected for children: the operator's question reached the parent when its child returned, the parent answered as its last turn, and the run recorded `Succeeded` without resuming the task. The hold keeps parent exchanges multi-round. A persona rule treating operator messages as asides would leave it to the model, which in that run ended on the answer. The persona now says replies to the operator are never final, but the hold doesn't depend on it.

pi-durable delivers steers after the running tool call returns, and the parent's only tool, delegation, can run long. A user turn mid-call would abort the child, so messages to a delegating parent are queued, as their receipt says. A second receipt with the same input sequence reports when the parent reads it, or that it never does, as when a pause's abort withdraws it.

The parent's report records whether its last turn answered operator input without delegating afterward. If so, and the checkout has no commit, PR, or comment, the executor fails the attempt with `AgentFailure`, so ending on an answer after a steer or release never yields an empty `Succeeded`. 2026-10-20 (#393): only operator messages and steers count as operator input, so a released parent's answer to the release guidance is judged like any other.

The wall-clock pause covers the parent's hold too.
