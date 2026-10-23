# @usine/durable

Runs an attempt's Pi parent in the orchestrator on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) storage. Each attempt is one durable task, `usine.attempt`, with one parent conversation. The parent's only tool, `subagent`, starts the agent's Claude Code, Codex, or Pi child in the attempt's checkout. After an orchestrator restart, unfinished attempts continue from their last committed step. [Attempt execution](https://docs.usine.dev/architecture/execution/) covers the durable layer and live channel.

## Entry points

- `/attempt-runtime`: the `AttemptRuntime` contract that the executor calls, with `AttemptRequest`, `StoredRequest`, and `AttemptReport`.
- `/harness`: the `DurableHarness` service, which manages the open pi-durable harness, and its platform-free `layer(options)`.
- `/backup`: `backup(instanceDirectory, destination)`, an online copy of `.usine/durable.sqlite` through SQLite's backup API, hard-linked into place so it never overwrites a file. `usine backup` writes it next to the runtime database copy.
- `/live`: the Node composition: the harness on `<instance>/.usine/durable.sqlite`, Pi's configured models and credentials, and the child backends from `@usine/agents`.
- `/testing`: a scripted parent model and stub children for whole-attempt tests, and a stub `AttemptRuntime` for executor tests.

```ts
import { layer as durableLayer } from "@usine/durable/live";

// Provides AttemptRuntime and DurableHarness; requires ChildProcessSpawner and ClaudeLoginLock,
// the per-Worker lock the executor's preflight shares (claudeLoginLockLayer from @usine/executor).
const attempts = durableLayer(instanceDirectory);
```

Building the layer installs the usine extension and resumes tasks. Closing it writes no task outcome, so the next start resumes the same work.

## Run an attempt

`execute(request, io)` creates the attempt's task, or finds it by attempt id after a restart, and waits for the outcome. Attempt and task ids are committed together, so a later call always finds the task. `isLive(attemptId)` is true from the first `execute` until the terminal envelope is sent or the task is canceled, so a restarted orchestrator reattaches the attempt.

After the terminal envelope, `finished(attemptId)` returns `ParentReported` with the report, `ParentFailed` with the failure, or `ResultRecorded` once the executor calls `recordResult(attemptId, result)` with the harvested result. If the orchestrator stopped before the engine recorded the outcome, it finishes the attempt with this instead of running the agent again. A canceled task leaves nothing.

`recordUnsupervised(attemptId, unsupervised)` stores the unsupervised time that the runaway guard counted, and `unsupervised(attemptId)` reads it back for a reattached attempt's guard (#178). It never decreases and is none until a guard records it.

`io` receives `Started` with the resolved parent model, `SessionEvent`s for the parent's committed entries and the children's events in order, `InterventionApplied` or `InterventionRejected`, and one `Final`, `Failed`, or `Interrupted`. The next sequence is stored, so a reattached `execute` continues the numbering. Progress is committed once per parent entry, after its envelopes are appended, and once per other envelope. After a crash before a commit, the same envelopes are relayed with the same sequences, and the transcript keeps one copy.

`AttemptRequest.host` (`@usine/agents/child-host`) is where the worker runs children: `LocalProcess` here or `RemoteShell` over SSH. The `subagent` tool passes it and the worker's name to every child, and tags child logs with the attempt id. `AttemptRequest.environment` is the whole environment of every local child and its commands; on `RemoteShell`, it's exported over the machine's own.

The task doesn't store the host or environment. It stores the run spec, worker, and worktree as a `StoredRequest`, which `request(attemptId)` returns, so a reattachment knows its run spec, base commit, and worktree. After a restart, the parent waits for the next `execute` to supply the host and environment before launching another child.

`AttemptRequest.gatewayCredential`, supplied the same way, is the credential kind that the worker's gateway uses for the children, from the worker's latest preflight, or none if they use their harness's login. The `subagent` tool records it on each child's `ChildSession` at start, so usage counts the child in the right pool. A preflight during the attempt applies to its next child.

Children aren't resumed after a restart: the tool call ends as interrupted with the output committed so far, and the parent model decides next.

## Operator input

`intervene(attemptId, intervention)` needs a live `execute`. It records the inbound envelope, applies the action, and records the result, in order with the relay's envelopes, so a sink's `append` must not wait for it. Input sent before `execute` has read durable storage and started relaying fails. `attached(attemptId)` completes once an `execute` in this process relays the channel; the runaway guard waits on it to deliver a reattached attempt's due warning (#178).

- `OperatorMessage` places a hold on the parent or a child; `Release` ends it. A held parent's answers wait for the operator instead of ending the attempt, and a released waiting parent continues with a new turn. A held child's report goes to the parent only after `Release`. `Steer` places no hold.
- Input to a working parent joins after the current tool round; to a working child, at its next step. Until then, `InterventionApplied` says `queued` and `AttemptRecordDoc.queuedInputs` keeps it. A second receipt for the same input sequence reports the read, with a child's state, or `InterventionRejected` if it never happens, including for a child lost to a restart.
- Input to a paused or waiting parent, or an idle or paused child, starts its next turn.
- `Interrupt` aborts the parent's turn and children, withdraws queued input, and holds the parent until a `Steer`, `OperatorMessage`, or `Release` resumes it.

`AttemptReport.answeredOperator` is true if the parent's last turn replied to an operator message or steer, not to the release guidance, without delegating after it. `harvestedResult(report, facts)` builds the `StepResult`, and fails such a report with `AgentFailure` if the checkout has no facts.

`cancel(attemptId)` aborts the task bottom-up, waits until it's terminal, and ends `execute` with `Interrupted`. A child whose launch hasn't returned, such as a Claude child waiting to relaunch, starts no process.

## Recovery from a poisoned session or a stuck step

Each time the harness opens, before tasks resume, the runtime reads every live task's `pi.live`, `pi.inbox`, `pi.usage`, `pi.agent`, and `pi.provider` documents. An unreadable document, for example one whose delta chain doesn't apply, stops every step that needs it. In one commit, the runtime retires it unread, recreates it with its initial value, and records the reason on the attempt whose `usine.attempt` task has the conversation. It then aborts that task: the abort applies to the generation and tool tasks first, and the abort handler fails the attempt with an `InfraFailure` giving the reason, which `execute` and a reattachment report. Other attempts keep running.

A pi-durable commit that fails after storage admission poisons the session. `DurableHarness` logs the cause, closes the session, reopens the storage, and resumes. A `DurableHarness.use` call failed by the reopen runs once more.

pi-durable reports failures that don't fail their caller through `onReport`. The harness logs a failure's first report, then its repeat count at most every five seconds. 1,000 reports of one failure with no commit adopted means a step that can't succeed. pi-durable retries it in microtasks, with no timer or I/O until the harness closes, so the harness closes from inside the report and reopens the storage. That clears stale scheduler state and repeats the document check.

If the reopened harness is stuck again within a minute, it stops for good: it logs the cause as an error, later calls fail with a `DurableHarnessError` naming it, and running attempts fail with `InfraFailure`. The next orchestrator start reopens the storage.

pi-durable has no cross-process locking: tasks and documents from a second writer can't be read back. `usine up` locks the instance folder to prevent this.

## Testing

```ts
import { answer, delegate, layer, StubChildren } from "@usine/durable/testing";

const attempts = layer({
  database: "/tmp/attempt.sqlite",
  parent: [delegate("Fix the flaky test"), answer("Fixed it.")],
});
```

- `layer({ database, parent })` provides `AttemptRuntime`, `DurableHarness`, `ChildBackend`, and `StubChildren` on a SQLite file. To simulate a restart, build a second layer on the file with the remaining answers.
- `parent` lists the parent model's answers, one per request: `delegate(task)` calls `subagent`, `answer(text)` is a final answer, and a function gets the request's context and returns an answer.
- `PARENT_MODEL`, `faux/faux-1`, is the scripted model. It accepts efforts up to `high`; an empty `RunSpec.parentModel` selects it.
- `StubChildren.next` waits for the next child. A `StubChild` exposes `request`, `emit(event)`, `reply(message)`, `block(message)`, `interrupted`, and its `interventions`. A held child replies after `Release`.
- `fauxParent(steps)` and `stubChildBackendLayer` are the two halves, to compose `DurableHarness` with other storage.
- `stubAttemptRuntime(storage, parent)` is an in-memory `AttemptRuntime` for executor and engine tests without a parent model. `parent` scripts each attempt's final message or `AttemptReport` (`completes`, `worksFor(millis)`, or a `StubParent`). Rebuilding it on the same `StubStorage` simulates a restart. `StubStorage.unsupervised` contains what `recordUnsupervised` stored, and `attached` completes when `execute` starts recording.
