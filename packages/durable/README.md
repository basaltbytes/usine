# @usine/durable

Runs an Attempt's Pi parent inside the orchestrator on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) storage. Each Attempt is one durable task, `usine.attempt`, that owns one parent conversation. The parent's only tool, `subagent`, launches the Agent's Claude Code, Codex, or Pi child in the Attempt's checkout. When the orchestrator restarts, the storage is reopened and every unfinished Attempt continues from its last committed step.

## Entry points

- `@usine/durable/attempt-runtime`: the `AttemptRuntime` contract the executor calls, with `AttemptRequest`, `StoredRequest`, and `AttemptReport`.
- `@usine/durable/harness`: the `DurableHarness` service, which owns the open pi-durable Harness, and its platform-free `layer(options)`.
- `@usine/durable/live`: the Node composition: the harness on `<instance>/.usine/durable.sqlite`, Pi's configured models and credentials, and the Claude, Codex, and Pi child backends from `@usine/agents`.
- `@usine/durable/testing`: a scripted parent model and stub children for driving whole Attempts in tests, and a stub `AttemptRuntime` for tests of the executors around it.

```ts
import { layer as durableLayer } from "@usine/durable/live";

// Provides AttemptRuntime and DurableHarness; requires ChildProcessSpawner.
const attempts = durableLayer(instanceDirectory);
```

Building the layer installs the usine extension and resumes the harness's tasks. Closing it closes the harness without writing any task outcome, so the next start resumes the same work.

## Running an Attempt

`execute(request, io)` creates the Attempt's task, or finds it by Attempt id after a restart, and waits for its outcome. The Attempt id and the task id are committed together, so a crash never leaves a task that a later call cannot find. `isLive(attemptId)` is true from the first `execute` until the terminal envelope has been sent or the task is canceled, so a restarted orchestrator reattaches instead of starting a new Attempt.

Everything reaches `io` as attempt channel envelopes: `Started` with the resolved parent model, `SessionEvent`s for the parent's committed entries and the children's events in the order they happened, `InterventionApplied` or `InterventionRejected` for operator input, and exactly one `Final`, `Failed`, or `Interrupted`. The next sequence is stored with the Attempt, so a reattached `execute` continues the numbering. Progress is committed once per parent entry, after all of its envelopes are appended, and once per other envelope: a crash before the commit relays the same envelopes again with the same sequences, which the transcript keeps once.

`AttemptRequest.host` (`@usine/agents/child-host`) says where the Worker runs the parent's children, and the `subagent` tool passes it to every child: `LocalProcess` on this machine, or `RemoteShell` over SSH. `AttemptRequest.environment` is the complete environment of every local child and every command it runs; on a `RemoteShell` host it is exported on top of the remote machine's own environment. The environment is never written to storage: the task stores the rest of the request as a `StoredRequest`, which `request(attemptId)` reads back so a reattachment knows the RunSpec, base commit, worktree, and child host the Attempt started with. A request stored before child hosts existed reads as `LocalProcess`. After a restart, the parent waits for the next `execute` call before it launches another child.

A child is not resumed after a restart. Its tool call settles as interrupted with the output committed so far, and the parent model decides what to do next.

## Operator input

`intervene(attemptId, intervention)` needs a live `execute` for the Attempt; it records the inbound envelope, applies the action, and records the result.

- Parent `Steer` or `OperatorMessage` while a turn runs: joins the turn after its current tool round.
- Parent `Interrupt`: aborts the current turn, children included, and holds the parent until a `Steer`, an `OperatorMessage`, or a `Release` resumes it with a new turn.
- Child actions go to the live child; an `OperatorMessage` places a Hold, and the child's report reaches the parent only after `Release`.

`cancel(attemptId)` aborts the task bottom-up, children first, waits until it is terminal, and makes `execute` end with `Interrupted`.

## Recovery from a poisoned Session

A pi-durable commit that fails after storage admission poisons the whole Session. `DurableHarness` detects it, logs the cause, closes the Session, opens the storage again, and resumes. A `DurableHarness.use` call that failed because of the reopen runs once more on the new harness.

## Testing

```ts
import { answer, delegate, layer, StubChildren } from "@usine/durable/testing";

const attempts = layer({
  database: "/tmp/attempt.sqlite",
  parent: [delegate("Fix the flaky test"), answer("Fixed it.")],
});
```

- `layer({ database, parent })` provides `AttemptRuntime`, `DurableHarness`, `ChildBackend`, and `StubChildren` on a SQLite file. Build a second layer on the same file to simulate an orchestrator restart; give it the parent answers still to come.
- `parent` lists the parent model's answers, one per model request. `delegate(task)` calls the `subagent` tool, `answer(text)` is a final answer, and a function receives the request's context and returns an answer.
- `PARENT_MODEL` is the scripted model's id, `faux/faux-1`. It accepts every effort up to `high`; leaving `RunSpec.parentModel` empty selects it too.
- `StubChildren.next` waits for the next launched child. A `StubChild` exposes its `request`, `emit(event)`, `reply(message)`, `block(message)`, `interrupted`, and the `interventions` it received. A child under a Hold returns its reply only after `Release`.
- `fauxParent(steps)` and `stubChildBackendLayer` are the two halves, for composing `DurableHarness` with another storage.
- `stubAttemptRuntime(storage, parent)` is an in-memory `AttemptRuntime` for executor and engine tests that need no parent model: `parent` scripts each Attempt's final message (`completes`, `worksFor(millis)`, or your own `StubParent`), and building it again on the same `StubStorage` simulates a restart.
