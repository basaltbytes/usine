# @usine/durable

Runs an attempt's Pi parent in the orchestrator on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) storage. Each attempt is one durable task, `usine.attempt`, with one parent conversation. The parent's only tool, `subagent`, starts the agent's Claude Code, Codex, or Pi child in the attempt's checkout. After an orchestrator restart, unfinished attempts continue from their last committed step. [Attempt execution](https://github.com/basaltbytes/usine/blob/main/docs/architecture/execution.mdx) covers the durable layer and live channel.

Brain specifications use the branded `Harness` ID from `@usine/core/agent/brain`. Configuration checks registered harnesses through the platform-free `@usine/agents/harness` catalog before an attempt starts.

Coordinator startup and `subagent` use the shared harness admission check. `/live` exports `loadParentModels(directory)` for configuration validation without opening durable storage. The orchestrator quarantines refused coordinator brains while keeping its operator UI available. Parent selection repeats admission when each attempt starts.

## Entry points

- `/attempt-runtime`: the `AttemptRuntime` contract that the executor calls, with `AttemptRequest`, `StoredRequest`, and `AttemptReport`.
- `/parent`: `resolveParent(models, defaultModel, options)`, which validates coordinator admission, model availability, reasoning effort, and credentials.
- `/harness`: the `DurableHarness` service, which manages the open pi-durable harness, and its platform-free `layer(options)`.
- `/backup`: `backup(instanceDirectory, destination)`, an online copy of `.usine/durable.sqlite` through SQLite's backup API, hard-linked into place so it never overwrites a file. `usine backup` writes it next to the runtime database copy.
- `/gateway`: `gatewayModelAccess(transport)` returns an Effect that builds Pi model access from a gateway transport. Parent admission checks the configured coordinator providers. It uses no local provider login.
- `/live`: the Node composition: the harness on `<instance>/.usine/durable.sqlite`, Pi's configured models and credentials, and the child backends from `@usine/agents`.
- `/testing`: a scripted parent model and stub children for whole-attempt tests, and a stub `AttemptRuntime` for executor tests.

```ts
import { layer as durableLayer } from "@usine/durable/live";

// Provides AttemptRuntime and DurableHarness; requires the Harnesses registry
// shared with the executor.
const attempts = durableLayer(instanceDirectory);
```

`/live` accepts optional `ParentModelAccess` as its second argument. The orchestrator supplies gateway model access when an SSH worker configures a gateway; otherwise Pi keeps its local login. `DurableHarnessOptions.credentials` selects `HostLogin` or `Gateway`; gateway admission checks the upstream credential through an Effect independently of the transport's caller token. Gateway ChatGPT models use the Responses API over HTTP streaming, without a local OAuth token, and retain the `chatgptPlan` pool. API-key routes use `apiKeys`.

The parent record stores the pool and endpoint resolved from its credential at launch. Transcript relay uses those stored values after a restart. Records created before these fields were stored retain the historical accounting rule.

Building the layer installs the usine extension and resumes tasks. Closing it writes no task outcome, so the next start resumes the same work. Each child receives a `ChildSessionLifecycle` tied to the channel attachment that supplied its host and environment. When that attachment detaches, the child stops recovering connections and reporting shutdown errors before the executor releases its transports and credentials.

Before opening the first harness, `/live` installs Pi's HTTP dispatcher once for the process. It uses HTTP/1.1, CONNECT proxy tunnels, five-minute body and header timeouts, and a two-second address-family connection attempt timeout. Pi's global `httpProxy` setting fills unset `HTTP_PROXY` and `HTTPS_PROXY` variables; existing environment values and `NO_PROXY` retain their precedence. Project settings do not configure the proxy.

The dispatcher applies to all server requests, including GitHub, gateway administration, and Boat. The adapter installs undici's fetch globals together with the dispatcher, preserving a fetch override made after importing `/live`. Reopening a harness reuses the dispatcher. Restart the server to apply proxy changes.

The Pi packages are pinned together at 1.4.0. The attempt and hold documents use explicit checkpoint policies that keep ordinary updates as deltas. Hold document version 2 gives each queued guidance message a stable request ID; version 1 guidance migrates with its order and supervision state preserved.

## Run an attempt

`execute(request, io)` creates the attempt's task, or finds it by attempt id after a restart, and waits for the outcome. Attempt and task ids are committed together, so a later call always finds the task. `isLive(attemptId)` is true from the first `execute` until the terminal envelope is sent or the task is canceled or settled, so a restarted orchestrator reattaches the attempt.

After confirming cancellation and stopping the relay, the caller can call `settle(attemptId)` to persist that the attempt is no longer live. This also handles a task that completed or failed before cancellation, when its terminal envelope couldn't be delivered. Settlement preserves the task's outcome and delivery state: it doesn't make an undelivered report available through `finished`. Repeated calls are safe.

After the terminal envelope, `finished(attemptId)` returns `ParentReported` with the report, `ParentFailed` with the failure, or `ResultRecorded` once the executor calls `recordResult(attemptId, result)` with the harvested result. If the orchestrator stopped before the engine recorded the outcome, it finishes the attempt with this instead of running the agent again. A canceled task leaves nothing.

`recordUnsupervised(attemptId, unsupervised)` stores the unsupervised time that the runaway guard counted, and `unsupervised(attemptId)` reads it back for a reattached attempt's guard (#178). It never decreases and is none until a guard records it.

`io` receives `Started` with the resolved parent model, `SessionEvent`s for the parent's committed entries and the children's events in order, `InterventionApplied` or `InterventionRejected`, and one `Final`, `Failed`, or `Interrupted`. Before appending a batch, the relay commits its encoded envelopes, next sequence, and parent-entry cursor together in the attempt record. It clears this outbox only after every append succeeds. A reattached `execute` delivers pending envelopes before new output, preserving their payloads, sequences, and timestamps; the transcript keeps one copy. Parent entries, child events, and intervention results use the same outbox. A pending terminal envelope keeps the attempt live until delivery completes. Older records without an outbox read as empty.

`AttemptRequest.host` (`@usine/agents/child-host`) is where the worker runs children: `LocalProcess` here or `RemoteShell` over SSH. The `subagent` tool passes it and the worker's name to every child, and tags child logs with the attempt id. `AttemptRequest.environment` is the whole environment of every local child and its commands; on `RemoteShell`, it's exported over the machine's own.

The task doesn't store the host or environment. It stores the run spec, worker, and worktree as a `StoredRequest`, which `request(attemptId)` returns, so a reattachment knows its run spec, base commit, and worktree. After a restart, or after the executor releases the attempt, the parent waits for the next `execute` to supply the host and environment before launching another child. An abort of the tool call ends that wait, for example when a stopping orchestrator closes the harness. The next start then resumes the call as interrupted.

`AttemptRequest.gatewayCredential`, supplied the same way, is the credential kind that the worker's gateway uses for the children, from the worker's latest preflight, or none if they use their harness's login. The `subagent` tool records it on each child's `ChildSession` at start, so usage counts the child in the right pool. A preflight during the attempt applies to its next child.

Every child receives the stored rendered loop task unchanged. The parent supplies supplemental context through `subagent.task`. The child's `SessionStarted.prompt` records its exact initial prompt for the run page, including its persona, task, parent context, and completion instructions. Older transcripts leave this field absent.

Children aren't resumed after a restart: the tool call ends as interrupted with the output committed so far, and the parent model decides next.

After a restart, admitting another delegation clears a previous process's stored child infrastructure failure. The replacement child's report determines the attempt outcome. The previous failure remains in the transcript. If the parent finishes without another delegation, the stored infrastructure failure still fails the attempt. Infrastructure failures recorded in the current process retain their precedence and trigger the existing automatic retry.

## Operator input

`intervene(attemptId, intervention)` needs a live `execute`. It records the inbound envelope, applies the action, and records the result, in order with the relay's envelopes, so a sink's `append` must not wait for it. Input sent before `execute` has read durable storage and started relaying fails. `attached(attemptId)` completes once an `execute` in this process relays the channel; the runaway guard waits on it to deliver a reattached attempt's due warning (#178).

- `OperatorMessage` places a hold on the parent or a child; `Release` ends it. A held parent's answers wait for the operator instead of ending the attempt, and a released waiting parent continues with a new turn. A held child's report goes to the parent only after `Release`. `Steer` places no hold.
- A `Steer` to the parent is forwarded unchanged to its single live child. Its `InterventionApplied.state.forwardedTo` records the child ID, and `queued` remains true until the child reads it. If no single child accepts it, or a child stops before reading it, the parent gets a separate turn to act on the steer. The attempt waits for a forwarded steer's delivery receipt before completing. An unread forwarded steer also returns to the parent after a restart; an explicit interruption withdraws it instead.
- An `OperatorMessage` to a working parent joins after the current tool round; input to a working child joins at its next step. Until then, `InterventionApplied` says `queued` and `AttemptRecordDoc.queuedInputs` keeps it. A second receipt for the same input sequence reports the read, with a child's state, or `InterventionRejected` if it never happens.
- Input to a paused or waiting parent, or an idle or paused child, starts its next turn.
- `Interrupt` aborts the parent's turn and children, withdraws queued input, and holds the parent until a `Steer`, `OperatorMessage`, or `Release` resumes it.

`AttemptReport.answeredOperator` is true if the parent's last turn replied to an operator message or steer, not to the release guidance, without delegating after it. `harvestedResult(report, facts, outputs)` builds a `StepCompletion`, and fails such a report with `AgentFailure` if the checkout has no facts or outputs.

`cancel(attemptId)` aborts the task bottom-up, waits until it's terminal, and ends `execute` with `Interrupted`. A child whose launch hasn't returned, such as a Claude child waiting to relaunch, starts no process.

## Recovery from storage errors

pi-durable fails the harness on any storage error, a read included: it aborts the running tasks, which stops their children, closes the harness, and rejects later calls with `SessionFailed`. `DurableHarness` watches the close and reacts by phase:

- Before `resume` completes, the harness stays closed. Building the layer fails with a `DurableHarnessError` that names the storage error, so `usine up` doesn't start.
- After that, each `execute` that relays an attempt fails with an `InfraFailure` whose cause is `DurableStorageFailed`. The engine retries the attempt from salvage. The harness reopens the storage as the next generation, aborts those attempts' tasks before the other tasks resume, and repeats a `DurableHarness.use` call that the failure interrupted.
- If the reopen fails, or the reopened harness fails within a minute, the harness stops. Later calls fail with a `DurableHarnessError` that names the cause, and attempts fail with `InfraFailure` until the orchestrator restarts.

Each time the harness opens, before tasks resume, the runtime reads every live task's `pi.live`, `pi.inbox`, `pi.usage`, `pi.agent`, and `pi.provider` documents from the storage directly, because a failed read through the harness fails it. An unreadable document, for example one whose delta chain doesn't apply, stops every step that needs it. In one commit, the runtime retires it unread, recreates it with its initial value, and records the reason on the attempt whose `usine.attempt` task has the conversation. It then aborts that task: the abort applies to the generation and tool tasks first, and the abort handler fails the attempt with an `InfraFailure` giving the reason, which `execute` and a reattachment report. Other attempts keep running. If that commit fails, the harness fails as described above.

pi-durable reports failures that don't fail their caller through `onReport`. The harness logs a failure's first report, then its repeat count at most every five seconds.

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
- `StubChildren.next` waits for the next child. A `StubChild` exposes `request`, `emit(event)`, `reply(message)`, `block(message)`, `crash(message)`, `interrupted`, and its `interventions`. `crash` ends the child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails. A held child replies after `Release`.
- `fauxParent(steps)` and `stubChildBackendLayer` are the two halves, to compose `DurableHarness` with other storage.
- `stubAttemptRuntime(storage, parent)` is an in-memory `AttemptRuntime` for executor and engine tests without a parent model. `parent` scripts each attempt's final message or `AttemptReport` (`completes`, `worksFor(millis)`, or a `StubParent`). Rebuilding it on the same `StubStorage` simulates a restart. `StubStorage.unsupervised` contains what `recordUnsupervised` stored, and `attached` completes when `execute` starts recording.

Push refusals recorded as `GitHubPushFailure` retain their diagnostic when serialized as a failed task outcome.

A child's provider capacity refusal remains `ProviderCapacityFailure` when the parent relays `[usine:provider-capacity]` or ends without relaying the child's report. The saved child report retains the classification across a restart. Direct Pi parent capacity errors also preserve the provider's message for the engine's delayed retry. The testing stub's `fail` method classifies message-only harness failures in the same way.

## Test storage

Durable storage fixtures use the shared [SQLite fixture directory helper](../../tooling/test/sqlite.mts).

See [Development](../../README.md#development) for temporary storage selection and worker concurrency.

A child's `SessionOperationError` is recorded as an infrastructure failure. This classification takes precedence over a later parent blocker, so the engine can retry the attempt from its recorded salvage.

## Storage contracts

`DurableHarnessOptions.openStorage` supplies pi-durable storage independently of the engine's runtime database. The Node composition uses a separate `.usine/durable.sqlite`; pi-durable owns its schema and migrations. `test/storage.test.ts` runs the pinned pi-durable storage conformance suite against `MemoryStorage` and Node SQLite as part of `pnpm test`. See the [persistence inventory](../../docs/persistence.md) for the storage boundaries and adapter test matrix.

The `/backup` operation requires `FileSystem` and `Path`. Provide `NodeServices.layer` at the application entry point.

## Schema contracts

Attempt runtime records and errors use nominal Schema brands. Task-input and failed-outcome encoders are pure functions over validated values. Encoding failures in runtime operations are defects; storage failures use the durable harness error channel.

Run `pnpm --filter @usine/durable check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## Step outputs

`AttemptRuntime.recordResult` stores a `StepCompletion` containing the step result and full output documents. `finished` returns that completion after a restart, so the engine can persist bodies before recording success even after checkout cleanup. Durable records containing an older step result decode as completions with no output bodies.
