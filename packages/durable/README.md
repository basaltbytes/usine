# @usine/durable

Runs each attempt's coordinator in the orchestrator. By default, the coordinator is a Pi parent on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) storage: each attempt is one durable task, `usine.attempt`, with one parent conversation, and the parent's only tool, `subagent`, starts the agent's Claude Code, Codex, or Pi child in the attempt's checkout. An attempt whose `RunSpec.coordinator` is `events` runs on the [event-driven coordinator](#event-driven-coordinator) instead, with no parent session. After an orchestrator restart, unfinished attempts continue from their last committed step. [Attempt execution](https://github.com/basaltbytes/usine/blob/main/docs/architecture/execution.mdx) covers the durable layer and live channel.

Brain specifications use the branded `Harness` ID from `@usine/core/agent/brain`. Configuration checks registered harnesses through the platform-free `@usine/agents/harness` catalog before an attempt starts.

Coordinator startup and `subagent` use the shared harness admission check. `/live` exports `loadParentModels(directory)` for configuration validation without opening durable storage. The orchestrator quarantines refused coordinator brains while keeping its operator UI available. Parent selection repeats admission when each attempt starts.

## Entry points

- `/attempt-runtime`: the `AttemptRuntime` contract that the executor calls, with `AttemptRequest`, `StoredRequest`, and `AttemptReport`.
- `/parent`: `resolveParent(models, defaultModel, options)`, which validates coordinator admission, model availability, reasoning effort, and credentials.
- `/harness`: the `DurableHarness` service, which manages the open pi-durable harness, and its platform-free `layer(options)`.
- `/backup`: `backup(instanceDirectory, destination)`, an online copy of `.usine/durable.sqlite` through SQLite's backup API, hard-linked into place so it never overwrites a file. `usine backup` writes it next to the runtime database copy.
- `/gateway`: `gatewayModelAccess(transport)` returns an Effect that builds Pi model access from a gateway transport. Parent admission checks the configured coordinator providers. It uses no local provider login.
- `/live`: the Node composition: the router over the Pi runtime and the event-driven coordinator, the harness on `<instance>/.usine/durable.sqlite`, Pi's configured models and credentials, the attempt journal on the runtime database's `SqlClient`, and the child backends from `@usine/agents`.
- `/coordinator/journal`: the `AttemptJournal` port of the event-driven coordinator, with its records and errors. `/coordinator/memory` and `/coordinator/sqlite` provide its adapters; see [Coordinator journal](#coordinator-journal).
- `/testing`: a scripted parent model and stub children for whole-attempt tests, the routed runtime with an in-memory attempt journal, and a stub `AttemptRuntime` for executor tests.

```ts
import { layer as durableLayer } from "@usine/durable/live";

// Provides AttemptRuntime and DurableHarness; requires the Harnesses registry
// shared with the executor and the runtime database's SqlClient.
const attempts = durableLayer(instanceDirectory);
```

`/live` accepts optional `ParentModelAccess` as its second argument. The orchestrator supplies gateway model access when an SSH worker configures a gateway; otherwise Pi keeps its local login. `DurableHarnessOptions.credentials.route` selects `host-login` or `gateway` from the shared `CredentialRoute`; gateway admission checks the upstream credential through an Effect independently of the transport's caller token. Gateway ChatGPT models use the Responses API over HTTP streaming, without a local OAuth token, and retain the `chatgptPlan` pool. API-key routes use `apiKeys`.

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

`io` receives `Started` once the attempt's task records `started` on its durable record, with the resolved parent model or `None` for an attempt without a parent session. The Worker notices sent before the start follow it. Then `io` receives `SessionEvent`s for the parent's committed entries and the children's events in order, `InterventionApplied` or `InterventionRejected`, and one `Final`, `Failed`, or `Interrupted`. Before appending a batch, the relay commits its encoded envelopes, next sequence, and parent-entry cursor together in the attempt record. It clears this outbox only after every append succeeds. A reattached `execute` delivers pending envelopes before new output, preserving their payloads, sequences, and timestamps; the transcript keeps one copy. Parent entries, child events, and intervention results use the same outbox. A pending terminal envelope keeps the attempt live until delivery completes. Older records without an outbox read as empty.

`AttemptRequest.host` (`@usine/agents/child-host`) is where the worker runs children: `LocalProcess` here or `RemoteShell` over SSH. The `subagent` tool passes it and the worker's name to every child, and tags child logs with the attempt id. `AttemptRequest.environment` is the whole environment of every local child and its commands; on `RemoteShell`, it's exported over the machine's own.

The task doesn't store the host or environment. It stores the run spec, worker, and worktree as a `StoredRequest`, which `request(attemptId)` returns, so a reattachment knows its run spec, base commit, and worktree. After a restart, or after the executor releases the attempt, the parent waits for the next `execute` to supply the host and environment before launching another child. An abort of the tool call ends that wait, for example when a stopping orchestrator closes the harness. The next start then resumes the call as interrupted.

`AttemptRequest.gatewayCredential`, supplied the same way, is the credential kind that the worker's gateway uses for the children, from the worker's latest preflight, or none if they use their harness's login. The `subagent` tool records it on each child's `ChildSession` at start, so usage counts the child in the right pool. A preflight during the attempt applies to its next child, including a resumed child after a restart.

Every child receives the stored rendered loop task unchanged. The parent supplies supplemental context through `subagent.task`. The child's `SessionStarted.prompt` records its exact initial prompt for the run page, including its persona, task, parent context, and completion instructions. Older transcripts leave this field absent.

The `subagent` tool and the event-driven coordinator both run children through the delegation core in `src/attempt/delegation/`. `delegate` runs one child from launch or resume to a `DelegationOutcome`: `Reported`, `Reserved`, `Interrupted`, or `BudgetExceeded`. It takes three ports, none of which loads a Pi package:

- `DelegationJournal` stores the delegation: its start, holds, pauses, queued operator input, the saved child session, and the retained output. Its operations fail with `JournalError`. The journal's owner numbers each delegation and applies the child-session budget in `start`, which returns `Admitted` or `Refused`: the `subagent` tool counts each call, and the coordinator numbers each child in the transition that decided it.
- `DelegationCall` is the call that owns the delegation: the running output, the published details, the abort, and what a reserved report or infrastructure failure means for the attempt. The `subagent` tool records them as the attempt's child blocker; the coordinator turns the delegation's outcome into its next event.
- `DelegationHub` is the attempt's in-process state that delegations share.

The tool implements the journal and the call over its pi-durable tool call and maps the outcome to its tool result.

The `subagent` tool commits the child's continuation identity (session ID, harness, home, and Codex model provider ID), worker, cumulative usage, and partial output before relaying them. Saved child identity excludes credential routes and billing metadata. Each launch resolves the current credential kind and repeats admission, including after a restart. A changed harness, home, checkout, or Codex provider ID refuses continuation with a message identifying the mismatch. After a restart, it waits for the executor's host and environment, then continues the saved conversation in the same checkout and transcript. Recovery keeps the child ID, child-session budget slot, and persisted operator hold and pause. A held child that finished its turn stays idle after restart until Release returns its saved report or operator guidance starts another turn. A paused child stays idle until a steer or operator message starts its next turn; releasing its hold preserves the pause. Launch admission requires `resume-session` for the worker's placement and credential route. If the saved conversation is missing or cannot be decoded, the original worker, machine, or checkout is unavailable, admission refuses resume, or recovery fails, the parent receives an interrupted tool result with the committed output.

After a restart, a resumed child's report clears its own stored infrastructure failure. Blockers from other children remain. Admitting another delegation also clears a previous process's stored child infrastructure failure, and the replacement child's report determines the attempt outcome. Previous failures remain in the transcript. If recovery fails and the parent finishes without another delegation, the stored infrastructure failure still fails the attempt. Infrastructure failures recorded in the current process retain their precedence and trigger the existing automatic retry.

## Operator input

`intervene(attemptId, intervention)` needs a live `execute`. It records the inbound envelope, applies the action, and records the result, in order with the relay's envelopes, so a sink's `append` must not wait for it. Input sent before `execute` has read durable storage and started relaying fails. `attached(attemptId)` completes once an `execute` in this process relays the channel; the runaway guard waits on it to deliver a reattached attempt's due warning (#178).

- `OperatorMessage` places a hold on the parent or a child; `Release` ends it. A held parent's answers wait for the operator instead of ending the attempt, and a released waiting parent continues with a new turn. A held child's report goes to the parent only after `Release`. `Steer` places no hold.
- A `Steer` to the parent is forwarded unchanged to its single live child. Its `InterventionApplied.state.forwardedTo` records the child ID, and `queued` remains true until the child reads it. If no single child accepts it, or a child stops before reading it, the parent gets a separate turn to act on the steer. The attempt waits for a forwarded steer's delivery receipt before completing. An unread forwarded steer also returns to the parent after a restart; an explicit interruption withdraws it instead.
- An `OperatorMessage` to a working parent joins after the current tool round; input to a working child joins at its next step. Until then, `InterventionApplied` says `queued` and `AttemptRecordDoc.queuedInputs` keeps it. A second receipt for the same input sequence reports the read, with a child's state, or `InterventionRejected` if it never happens.
- Input to a paused or waiting parent, or an idle or paused child, starts its next turn.
- `Interrupt` aborts the parent's turn and children, withdraws queued input, and holds the parent until a `Steer`, `OperatorMessage`, or `Release` resumes it.

`AttemptReport.answeredOperator` is true if the parent's last turn replied to an operator message or steer, not to the release guidance, without delegating after it. On the event-driven coordinator, it is the child's `SessionResult.answeredOperator`: the child read an operator message or steer after its last tool call. `harvestedResult(report, facts, outputs)` builds a `StepCompletion`, and fails such a report with `AgentFailure` if the checkout has no facts or outputs.

`cancel(attemptId)` aborts the task bottom-up, waits until it's terminal, and ends `execute` with `Interrupted`. A child whose launch hasn't returned, such as a Claude child waiting to relaunch, starts no process.

## Recovery from storage errors

pi-durable fails the harness on any storage error, a read included: it aborts the running tasks, which stops their children, closes the harness, and rejects later calls with `SessionFailed`. `DurableHarness` watches the close and reacts by phase:

- Before `resume` completes, the harness stays closed. Building the layer fails with a `DurableHarnessError` that names the storage error, so `usine up` doesn't start.
- After that, each `execute` that relays an attempt fails with an `InfraFailure` whose cause is `DurableStorageFailed`. The engine retries the attempt from salvage. The harness reopens the storage as the next generation, aborts those attempts' tasks before the other tasks resume, and repeats a `DurableHarness.use` call that the failure interrupted.
- If the reopen fails, or the reopened harness fails within a minute, the harness stops. Later calls fail with a `DurableHarnessError` that names the cause, and attempts fail with `InfraFailure` until the orchestrator restarts.

Each time the harness opens, before tasks resume, the runtime reads every live task's `pi.live`, `pi.inbox`, `pi.usage`, `pi.agent`, and `pi.provider` documents from the storage directly, because a failed read through the harness fails it. An unreadable document, for example one whose delta chain doesn't apply, stops every step that needs it. In one commit, the runtime retires it unread, recreates it with its initial value, and records the reason on the attempt whose `usine.attempt` task has the conversation. It then aborts that task: the abort applies to the generation and tool tasks first, and the abort handler fails the attempt with an `InfraFailure` giving the reason, which `execute` and a reattachment report. Other attempts keep running. If that commit fails, the harness fails as described above.

pi-durable reports failures that don't fail their caller through `onReport`. The harness logs a failure's first report, then its repeat count at most every five seconds.

pi-durable has no cross-process locking: tasks and documents from a second writer can't be read back. `usine up` locks the instance folder to prevent this.

## Coordinator rules

`src/attempt/coordinator/rules.ts` holds the policy of the event-driven coordinator from [#1150](https://github.com/basaltbytes/usine/issues/1150) as three pure functions. It imports only `@usine/core` schemas and performs no IO.

- `ruleFor(event, context)` returns the rule's `Decision` for a `CoordinatorEvent`.
- `clamp(decision, context)` checks a decision from a rule or a model against the event and resolves its defaults.
- `apply(state, decision)` returns the next `CoordinatorState` and the effect intents: `Delegate` starts a child, `Finish` ends the Attempt, and `Ignored` gives the reason a decision changed nothing.

`ModelDecision` is the contract that a model handler answers with. `Schema.toJsonSchemaDocument(ModelDecision)` has one branch per tag, and its free-text fields are optional wherever the event supplies the text. A `RetryChild` without an assignment tells the replacement to continue from the checkout, with the previous child's report when it answers a report. A `Complete` without a message completes with the report. A rule's `Decision` adds two tags that a model can't choose: `StartChild` and `OverBudget`.

The rules handle each lifecycle event as follows:

- `AttemptStarted` delegates child 1 with a fixed context.
- `ChildReported` with a reserved marker fails the Attempt with `BlockedFailure`, `QuestionFailure`, or `AgentFailure`. Without a marker, it completes the Attempt with the report.
- `ChildInterrupted` delegates one replacement in the next child-session budget slot, with a context that tells the child to inspect the checkout and continue. With no slot left, the Attempt fails with `InfraFailure`.
- `ChildAtCapacity` fails the Attempt with `ProviderCapacityFailure`, which keeps the time the provider's usage limit resets. `ChildFailed` fails it with `InfraFailure`, and `BudgetExceeded` with `ChildSessionBudgetFailure`.

A model may answer only a report without a reserved marker or a CI handoff. For every other event, `clamp` applies the rule, so a reserved marker always wins, a report that starts with `[usine:awaiting-ci]` completes the Attempt with the handoff unchanged, and an interrupted child, which left no report, can't complete the Attempt. `clamp` also applies the event's rule when it gets `StartChild` or `OverBudget` for a child event, and it turns a `RetryChild` past the budget into `Failed`. `apply` ignores a decision about a child other than the latest one, a decision about a child before the first child starts, a repeated start, and anything after the Attempt settles, so an interruption gets at most one replacement. For each of these, it returns one `Ignored` intent whose `reason` is `StaleChild`, `NotStarted`, `AlreadyStarted`, or `AttemptSettled`, so the coordinator can log why nothing happened.

## Event-driven coordinator

`CoordinatorRuntime` in `src/coordinator/runtime.ts` implements `AttemptRuntime` for an attempt without a parent session. It needs `AttemptJournal`, `ChildBackend`, and `WakeUp`, and no model credential. It handles each lifecycle event in four steps:

1. `buildAttemptContext` reads the journal: the event, the first 4,000 characters of the rendered task, the outcome labels and CI policy, each delegation with the latest two reports up to 4,000 characters and earlier ones as one line, and the last 2,000 characters of the latest child's output. It shortens the task, output, and reports so the encoded context stays within 16,000 characters, and keeps the event whole.
2. `WakeUp.handle(event, context, attempt)` returns a `RecordedDecision`, or `None` to apply the event's rule. `attempt` carries the attempt ID, the event's journal sequence, the stored `RunSpec` with the agent's brain, and an effect that returns the attached `AttemptRequest`, so a model handler can open a session on the attempt's worker, and `recordUsage`, which relays a model call's cumulative usage as a `SessionTokensUpdated` session event. A `RecordedDecision` names its handler, `rule`, `completion`, or `session`, and a model's decision also records its `HandlerSession`: the brain, credential route, billing pool, and usage of the model call. `WakeUp.rules` sends every event to its rule. `completionWakeUp` (`src/coordinator/completion.ts`), which the live layer's `coordinatorLayer` uses with the SQLite journal, decides a report without a reserved marker or a CI handoff with a structured completion; see [Structured completion](#structured-completion).
3. `AttemptJournal.decide` records the decision; the first one recorded for the event wins.
4. `clamp` and `apply` from the rules check it and return the next state and intents, which one `transition` commits with the event and the envelopes they reserve.

The first event starts child 1 with the rendered task, and the transition reserves `Started` without a parent model. A delegation runs after its transition commits, through the delegation core over the journal. The event that ends it is recorded with `settleDelegation` before the next transition, so a restart reads it instead of starting another child. A restart also applies a decision recorded before its transition instead of calling the handler again, and resumes a child that saved its session with the same child ID and budget slot. A child that stopped before it saved its session is replaced once within the child-session budget. A process stop interrupts the `execute` call, which detaches before its child stops. The delegation then aborts, and the child's harness leaves the session to resume, as a Pi parent's children do when the harness closes: a Claude Code child's turn is interrupted, and a Codex child is detached without a turn interrupt. The stop waits up to 10 seconds for the child. A delegation whose child hasn't started is interrupted. When a cancel or a failed sink ends the call, nothing resumes the child, so its delegation is interrupted while the call is attached and the child's host stops it.

The outbox relay in `src/coordinator/outbox.ts` reserves each envelope in the journal before the sink receives it and acknowledges it after, so the next `execute` sends unacknowledged envelopes again. Worker notices before `Started` wait for it, and notices after the terminal envelope are dropped.

`intervene` routes operator input to a child, as described in [Coordinator operator input](#coordinator-operator-input). `cancel` stops the running child or interrupts the running handler, relays `Interrupted`, and ends `execute` with `AgentFailure`. It settles a journal with no outcome, because the coordinator has no canceled status. A journal with an outcome is left for the caller, so a worker drain leaves an undelivered terminal envelope live, as it does for a Pi parent.

### Structured completion

`completionWakeUp` needs `Harnesses`. For a `ChildReported` without a reserved marker or a CI handoff, when the agent has a `decision` brain, it calls `complete` on the agent's harness with the `decision-completion` role: a structured value, no conversation, and no usine tools. A harness that can't turn its own tools off runs them read-only, so the role doesn't require `closed-tools`. The brain is the agent's harness with the `decision` model and effort. The session is a `RoleSession` whose ID is `parent:<attempt>:decision:<sequence>` and whose parent is the reporting child, on the attached request's host, worker, checkout, and environment, with the credential route that `workerAdmissionContext` reads for the child. The prompt holds the encoded `AttemptContext`, and the answer is a `ModelDecision` whose optional text is `null`, empty, or whitespace-only when absent, with a one-sentence reason. The answer's JSON Schema has no string length keyword, which strict provider modes may not accept, so the handler checks that required text isn't empty or whitespace-only.

Every other event, and an agent without a `decision` brain, takes its rule without a model call. A brain that admission refuses, a `CompletionError` of any reason, an answer that leaves required text empty or whitespace-only, and a decision that `clampRejection` rejects (a replacement past the child-session budget) return `None`, so the rule applies, and log the reason at Warning. The completion's usage is relayed with `recordUsage`, including the usage that a failed completion reports.

### Coordinator operator input

`Interventions` in `src/coordinator/interventions.ts` handles one attempt's operator input. `intervene` records the input's sequence in the journal, appends the input to the transcript through the outbox, and applies it under the attempt's routing permit, which transitions also take:

- Input for a child goes to that child. Input addressed to the parent goes to the live child, and its receipts set `InterventionState.forwardedTo` to the child, as a forwarded Pi parent steer does. This covers steers, operator messages, interrupts, and releases, and the runaway guard's warning, which is a parent steer.
- Input addressed to the parent waits while the open delegation's child starts, as after a reattachment, so the runaway guard's restored warning reaches the resumed child.
- With no live or starting child, or for a child that ended, the receipt is `InterventionRejected`. Input before `Started` or after the terminal envelope fails with `AgentFailure`, because the channel admits no receipt there.
- Before the child applies the input, the journal stores the Hold and pause that the input implies with `supervise`, and a message with `queueInput`. The coordinator then corrects them to what the child reports, or restores them if the child refuses the input, so an input that the child applied survives a stop. A held child keeps its result until `Release`, so the attempt's outcome waits for it. A resumed child after a restart gets its stored Hold and pause, and its idle report with whether that report answered the operator.
- A working child queues a message: the journal keeps it until the child reports it. A message that the child read at once is forgotten. A read gets a second `InterventionApplied`. An unread input stays stored, so a child resumed after a restart reads it, and is rejected once the child's delegation ends, or before the `Interrupted` of a cancel that stops the child. `forgetInput` removes the input and reserves its second receipt in one journal write, so a stop can't repeat the receipt or keep a settled input. Every receipt for a child's input precedes the envelopes of the event that its end produces.

`routerLayer` in `src/coordinator/router.ts` provides `AttemptRuntime` over `PiAttemptRuntime` and `CoordinatorRuntime`. `execute` sends an attempt to the coordinator if the journal has it, to the Pi runtime if pi-durable has it, and otherwise by `RunSpec.coordinator`, which decodes as `session` for attempts stored without it. A journal migration rewrites a stored `RunSpec.parent` of `pi` or `none` as `session` or `events`. Every other operation looks the attempt up in the journal and falls back to the Pi runtime, so an attempt stays on the runtime that started it. A Worker notice for an attempt that neither runtime has waits for its `execute` call.

## Testing

```ts
import { answer, delegate, layer, StubChildren } from "@usine/durable/testing";

const attempts = layer({
  database: "/tmp/attempt.sqlite",
  parent: [delegate("Fix the flaky test"), answer("Fixed it.")],
});
```

- `layer({ database, parent })` provides `AttemptRuntime`, `DurableHarness`, `ChildBackend`, and `StubChildren` on a SQLite file. To simulate a restart, build a second layer on the file with the remaining answers. Attempts go through the router, with the event-driven coordinator on an in-memory journal; `routedRuntimeLayer` is that router without the harness and children.
- `parent` lists the parent model's answers, one per request: `delegate(task)` calls `subagent`, `answer(text)` is a final answer, and a function gets the request's context and returns an answer.
- `PARENT_MODEL`, `faux/faux-1`, is the scripted model. It accepts efforts up to `high`; an empty `RunSpec.parentModel` selects it.
- `StubChildren.next` waits for the next child. A `StubChild` exposes `request`, `emit(event)`, `reply(message)`, `readQueued`, `block(message)`, `crash(message)`, `interrupted`, and its `interventions`. `crash` ends the child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails. A held child replies after `Release`. A reply answers the operator if the child read an operator message after its last emitted `ToolStarted`.
- `fauxParent(steps)` and `stubChildBackendLayer` are the two halves, to compose `DurableHarness` with other storage.
- `stubAttemptRuntime(storage, parent)` is an in-memory `AttemptRuntime` for executor and engine tests without a parent model. `parent` scripts each attempt's final message or `AttemptReport` (`completes`, `worksFor(millis)`, or a `StubParent`). Rebuilding it on the same `StubStorage` simulates a restart. `StubStorage.unsupervised` contains what `recordUnsupervised` stored, and `attached` completes when `execute` starts recording.

Push refusals recorded as `GitHubPushFailure` retain their diagnostic when serialized as a failed task outcome.

A child's provider capacity refusal remains `ProviderCapacityFailure` when the parent relays `[usine:provider-capacity]`, ends without relaying the child's report, or reports its own blocker, question, or failure. The saved child report keeps the usage-limit reset time, so the engine's retry waits for it. The saved child report retains the classification across a restart. Direct Pi parent capacity errors also preserve the provider's message for the engine's delayed retry. The testing stub's `fail` method classifies message-only harness failures in the same way, and its `limit` method ends a child with a usage limit and its reset time.

Live restart contracts for Claude Code, Codex, and Pi run with `pnpm --filter @usine/durable test:integration`. Set `USINE_CLAUDE_INTEGRATION_MODEL`, `USINE_CODEX_INTEGRATION_MODEL`, and `USINE_PI_INTEGRATION_MODEL` and supply each harness's credentials. For gateway-authenticated children, set the matching `USINE_<HARNESS>_INTEGRATION_GATEWAY_CREDENTIAL` to `api-key` or `subscription`. Claude Code and Codex run locally and through the SSH shim; Pi runs locally. Each contract stops an active attempt, rebuilds the durable runtime on the same SQLite database, and checks that the saved child returns its final report.

Recorded Claude Code and Codex restart scenarios run in `pnpm --filter @usine/durable test` and CI. They replace only the child transport, keep the real adapters and durable `subagent` tool, and rebuild `AttemptRuntime` on the same SQLite file during an active command. The credential-change case simulates a gateway change from subscription to API-key credentials on resume. It checks the derived billing pool on resumed child usage events and the pool and login on Codex rate-limit events. Vendor traffic remains the recorded subscription session. See the [agents recording commands](../agents/README.md#transport-replay-tests) to refresh the fixtures.

The `home-gone-fallback` child recovery case deletes a test directory between runtimes and reports the missing file through a stub child backend. It covers only the replacement fallback: the failed resume returns as interrupted, and the parent can delegate a replacement using another child-session slot. It does not exercise executor home removal or a real harness.

## Test storage

Durable storage fixtures use the shared [SQLite fixture directory helper](../../tooling/test/sqlite.mts).

See [Development](../../CONTRIBUTING.md#development) for temporary storage selection and worker concurrency.

A child's `SessionOperationError` is recorded as an infrastructure failure. This classification takes precedence over a later parent blocker, so the engine can retry the attempt from its recorded salvage.

## Coordinator journal

`AttemptJournal` stores what the event-driven coordinator from [#1150](https://github.com/basaltbytes/usine/issues/1150) needs to resume an attempt: the stored request, an append-only ledger of events with their decisions, the coordinator state, the delegations it decided with what each child saved and the event that ended it, an outbox of channel envelopes that the sink hasn't acknowledged, the harvested result, the runaway guard's unsupervised time, and the operator's supervision and queued input for each child. It doesn't use pi-durable.

- `open` creates the journal, or returns the existing one unchanged.
- `decide` records the first decision for an event and returns it to every later caller, so a restarted coordinator applies the recorded decision instead of deciding again.
- `transition` appends the event with that decision, replaces the state, records `Delegate` and `Finish` intents, and reserves envelopes in one transaction. It fails with `StaleRevision` if the expected revision isn't current.
- `reserve` and `acknowledge` keep the outbox in sequence order across restarts.
- `startDelegation` marks a decided delegation started, or returns the progress saved since an earlier run started it. `saveProgress` applies one typed `ProgressChange`, and `settleDelegation` keeps the first event that ended the delegation.
- `recordResult` stores the harvested result, and `recordUnsupervised` keeps the longest unsupervised time.
- `supervise` replaces a child's Hold and pause; a child with neither has no stored supervision. `queueInput` and `forgetInput` keep the operator inputs that children queued, and `forgetInput` reserves the input's receipts in the same transaction. `recordInbound` advances the sequence of the next operator input.
- `settle` keeps the outcome and the outbox, and advances the revision, so a late transition fails as stale.

The coordinator encodes events, decisions, and state as JSON; the journal stores them without reading them. Breaking a ledger invariant is a defect: an operation on an attempt that was never opened, a transition after `Finish`, a decision other than the recorded one, or an envelope out of sequence.

`memoryAttemptJournalLayer` from `/coordinator/memory` keeps the journal in a `Ref`. `sqliteAttemptJournalLayer` from `/coordinator/sqlite` requires `SqlClient`; the application supplies the runtime database's connection. Its dialect SQL, Drizzle schema, and embedded migrations are in `src/coordinator/sqlite/`, with their own `usine_attempt_journal_migrations` ledger. Run `pnpm db:generate` after changing the schema. `test/contracts/` runs one contract suite against both adapters, plus a SQLite write-failure check.

## Storage contracts

`DurableHarnessOptions.openStorage` supplies pi-durable storage independently of the engine's runtime database. The Node composition uses a separate `.usine/durable.sqlite`; pi-durable owns its schema and migrations. `test/storage.test.ts` runs the pinned pi-durable storage conformance suite against `MemoryStorage` and Node SQLite as part of `pnpm test`. See the [persistence inventory](../../docs/persistence.md) for the storage boundaries and adapter test matrix.

The `/backup` operation requires `FileSystem` and `Path`. Provide `NodeServices.layer` at the application entry point.

## Schema contracts

Attempt runtime records and errors use nominal Schema brands. Task-input and failed-outcome encoders are pure functions over validated values. Encoding failures in runtime operations are defects; storage failures use the durable harness error channel.

Run `pnpm --filter @usine/durable check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## Step outputs

`AttemptRuntime.recordResult` stores a `StepCompletion` containing the step result and full output documents. `finished` returns that completion after a restart, so the engine can persist bodies before recording success even after checkout cleanup. Durable records containing an older step result decode as completions with no output bodies.

Child recovery checkpoints the native session reference before the first prompt and continuation timestamps before each recovery turn. In-flight tool calls and unread operator-message IDs restore from SQLite. The agents package supplies the same continuation policy for durable restart and live transport recovery: supervised children wait for guidance, working children receive one continuation followed by unread input, and a fourth continuation within ten minutes fails. Failed reopening returns the tool's committed output as interrupted without spending another child-session slot. A replacement child clears the superseded child's infrastructure blocker for every harness.
