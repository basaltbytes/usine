# @usine/durable

Runs an Attempt's Pi parent inside the orchestrator on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) storage. Each Attempt is one durable task, `usine.attempt`, that owns one parent conversation. The parent's only tool, `subagent`, launches the Agent's Claude Code, Codex, or Pi child in the Attempt's checkout. When the orchestrator restarts, the storage is reopened and every unfinished Attempt continues from its last committed step.

## Entry points

- `@usine/durable/attempt-runtime`: the `AttemptRuntime` contract the executor calls, with `AttemptRequest`, `StoredRequest`, and `AttemptReport`.
- `@usine/durable/harness`: the `DurableHarness` service, which owns the open pi-durable Harness, and its platform-free `layer(options)`.
- `@usine/durable/backup`: `backup(instanceDirectory, destination)`, an online copy of the instance's `.usine/durable.sqlite` through SQLite's backup API, hard-linked into place so it never overwrites a file; `usine backup` takes it beside the runtime database.
- `@usine/durable/live`: the Node composition: the harness on `<instance>/.usine/durable.sqlite`, Pi's configured models and credentials, and the Claude, Codex, and Pi child backends from `@usine/agents`.
- `@usine/durable/testing`: a scripted parent model and stub children for driving whole Attempts in tests, and a stub `AttemptRuntime` for tests of the executors around it.

```ts
import { layer as durableLayer } from "@usine/durable/live";

// Provides AttemptRuntime and DurableHarness; requires ChildProcessSpawner and ClaudeLoginLock,
// the per-Worker lock the executor's preflight shares (claudeLoginLockLayer from @usine/executor).
const attempts = durableLayer(instanceDirectory);
```

Building the layer installs the usine extension and resumes the harness's tasks. Closing it closes the harness without writing any task outcome, so the next start resumes the same work.

## Running an Attempt

`execute(request, io)` creates the Attempt's task, or finds it by Attempt id after a restart, and waits for its outcome. The Attempt id and the task id are committed together, so a crash never leaves a task that a later call cannot find. `isLive(attemptId)` is true from the first `execute` until the terminal envelope has been sent or the task is canceled, so a restarted orchestrator reattaches instead of starting a new Attempt.

After the terminal envelope, `finished(attemptId)` still reads what the parent left: `ParentReported` with its report, `ParentFailed` with its failure, or `ResultRecorded` once the executor has called `recordResult(attemptId, result)` with the result it harvested from the checkout. An orchestrator that stopped before the engine recorded the Attempt's outcome finishes the Attempt with it instead of running the agent again. A canceled task leaves nothing.

`recordUnsupervised(attemptId, unsupervised)` keeps the unsupervised time the executor's runaway guard counted with the Attempt's record, and `unsupervised(attemptId)` reads it back, so the guard of a reattachment goes on from it (#178). The kept time never goes back, and it is none until a guard records one.

Everything reaches `io` as attempt channel envelopes: `Started` with the resolved parent model, `SessionEvent`s for the parent's committed entries and the children's events in the order they happened, `InterventionApplied` or `InterventionRejected` for operator input, and exactly one `Final`, `Failed`, or `Interrupted`. The next sequence is stored with the Attempt, so a reattached `execute` continues the numbering. Progress is committed once per parent entry, after all of its envelopes are appended, and once per other envelope: a crash before the commit relays the same envelopes again with the same sequences, which the transcript keeps once.

`AttemptRequest.host` (`@usine/agents/child-host`) says where the Worker runs the parent's children, and the `subagent` tool passes it and the Worker's name to every child, whose logs it annotates with the Attempt id: `LocalProcess` on this machine, or `RemoteShell` over SSH. `AttemptRequest.environment` is the complete environment of every local child and every command it runs; on a `RemoteShell` host it is exported on top of the remote machine's own environment. Neither the child host nor the environment is written to storage, since both describe the process that runs the Attempt: the task stores the RunSpec, Worker, and worktree as a `StoredRequest`, which `request(attemptId)` reads back so a reattachment knows the RunSpec, base commit, and worktree the Attempt started with. After a restart, the parent waits for the next `execute` call to supply the child host and environment before it launches another child.

A child is not resumed after a restart. Its tool call settles as interrupted with the output committed so far, and the parent model decides what to do next.

## Operator input

`intervene(attemptId, intervention)` needs a live `execute` for the Attempt; it records the inbound envelope, applies the action, and records the result. It records the envelopes in order with those the relay appends, so a sink's `append` must not wait for it. `execute` relays the Attempt's channel only after reading durable storage, and input sent before that fails; `attached(attemptId)` completes once an `execute` call in this process relays the channel, at once while one does, and waits as long as none does. The executor's runaway guard waits on it to deliver the warning a reattachment owes (#178).

- Parent `OperatorMessage`: places a Hold on the parent. While the Hold lasts, each answer of the parent waits for the operator instead of ending the Attempt; `Release` ends the Hold, and a waiting parent then continues the task with a new turn. A `Steer` places no Hold.
- Parent `Steer` or `OperatorMessage` while a turn runs: joins the turn after its current tool round. Until then its `InterventionApplied` says `queued`, and a second receipt for the same input sequence reports that the parent read it, or an `InterventionRejected` that it never will. To a paused or waiting parent, it starts the next turn.
- Parent `Interrupt`: aborts the current turn, children included, withdraws queued input, and holds the parent until a `Steer`, an `OperatorMessage`, or a `Release` resumes it with a new turn.
- Child actions go to the live child; an `OperatorMessage` places a Hold, and the child's report reaches the parent only after `Release`.
- Child `Steer` or `OperatorMessage` while the child works: its `InterventionApplied` says `queued` until the child reads it at its next step. `AttemptRecordDoc.queuedInputs` keeps it, and a second receipt for the same input sequence reports that the child read it, with the child's state, or an `InterventionRejected` when the child stopped first, including a child lost to a restart. To an idle or paused child, the message starts its next turn.

`AttemptReport.answeredOperator` says the parent's last turn replied to an operator message or a steer, not to the release guidance, without delegating after it. `harvestedResult(report, facts)` builds the Attempt's `StepResult`, and fails with an `AgentFailure` for such a report when the checkout holds no facts.

`cancel(attemptId)` aborts the task bottom-up, children first, waits until it is terminal, and makes `execute` end with `Interrupted`. A child whose launch has not returned, such as a Claude child waiting to launch again, stops there and starts no process.

## Recovery from a poisoned Session or a stuck step

Each time the harness opens, before its tasks resume, the Attempt runtime reads the `pi.live`, `pi.inbox`, `pi.usage`, `pi.agent`, and `pi.provider` documents of every live task's conversation. A document that no longer reads back, as when a delta in its chain does not apply, stops every step that needs it. In one commit the runtime retires each unreadable document without reading it, creates it again with its initial value, and records the reason on the record of the Attempt whose `usine.attempt` task owns the conversation. It then aborts that task: the abort reaches the conversation's generation and tool tasks first, and the task's own abort handler fails the Attempt with an `InfraFailure` whose message is that reason, so `execute` and a reattachment report it. Other Attempts in the same storage keep running.

A pi-durable commit that fails after storage admission poisons the whole Session. `DurableHarness` detects it, logs the cause, closes the Session, opens the storage again, and resumes. A `DurableHarness.use` call that failed because of the reopen runs once more on the new harness.

pi-durable reports failures that do not fail their caller through `onReport`. The harness logs the first report of each failure, then the number of repeats at most once every five seconds. One failure reported 1,000 times with no commit adopted in between means pi-durable is retrying a step that cannot succeed. It retries at once, in microtasks, so the process runs no timer and no I/O until the harness closes: the harness closes it from inside the report and reopens the storage, which also clears a scheduler state that no longer matches storage and repeats the document check above. If the reopened harness gets stuck again within a minute, the harness stops for good. The cause is logged as an error, every later call fails with a `DurableHarnessError` that names it, and each running Attempt fails with an `InfraFailure`. The next orchestrator start opens the storage again.

One process owns the storage at a time; pi-durable has no cross-process locking, and a second writer leaves tasks and documents that no longer read back. `usine up` holds the instance folder for this reason.

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
- `stubAttemptRuntime(storage, parent)` is an in-memory `AttemptRuntime` for executor and engine tests that need no parent model: `parent` scripts each Attempt's final message or `AttemptReport` (`completes`, `worksFor(millis)`, or your own `StubParent`), and building it again on the same `StubStorage` simulates a restart. `StubStorage.unsupervised` holds what `recordUnsupervised` kept. Its `attached` completes once `execute` starts recording the Attempt's activity.
