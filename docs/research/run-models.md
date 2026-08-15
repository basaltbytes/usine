# Prior art: run models in n8n, Temporal and Inngest

Resolves [#5](https://github.com/basaltbytes/usine/issues/5). Research date: 2026-08-15. Sources are the official docs of each system, plus n8n source code where its docs are thin. Every claim carries its URL.

The question: how do these three systems model triggers, runs, steps, retries and idempotency — and which of their data-model choices would usine later regret, given that v1 is trigger → single agent run but the model must stay open to multi-step graphs?

---

## 1. n8n

### What fires

A trigger node is "a special node responsible for executing the workflow in response to certain conditions" ([key-concept-glossary](https://docs.n8n.io/key-concept-glossary.md)). "Production executions occur when a triggering event or schedule automatically runs a workflow"; manual executions run from the canvas ([types-of-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions.md)). The trigger→execution mapping differs by trigger kind: schedule triggers count "one execution every time the node fires, regardless of outcome", polling nodes "count one execution only when new data is found — polls that return no results don't count as an execution", and webhooks count each inbound request ([understand-executions](https://docs.n8n.io/build/understand-workflows/understand-executions.md)). The Webhook node has distinct test and production URLs and several response modes (immediate, after last node, via a Respond node, streaming) ([webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook.md)). No deduplication happens at the trigger.

### What a run is

"An execution is a single run of a workflow" ([understand-executions](https://docs.n8n.io/build/understand-workflows/understand-executions.md)). The UI filters executions by "Failed, Running, Success, or Waiting" ([view-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md)); the source's full `ExecutionStatus` union is `'canceled' | 'crashed' | 'error' | 'new' | 'running' | 'success' | 'unknown' | 'waiting'` ([packages/workflow/src/execution-status.ts](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/src/execution-status.ts)). There is no run identity beyond the auto-assigned execution id: the execution *is* the trigger firing. A retried execution is a *new* execution linked to the old one via `execution.retryOf`, "only present when the execution is a retry of a failed execution" ([handle-errors-gracefully](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md)).

### What a step is

A node: "nodes are individual components that you compose to create workflows" ([key-concept-glossary](https://docs.n8n.io/key-concept-glossary.md)). n8n is graph-native from day one — a workflow is a DAG of nodes, and per-execution output is stored per node.

### Retries

Two disjoint layers:

- **Per node**, fields on the node definition itself: `retryOnFail?: boolean; maxTries?: number; waitBetweenTries?: number; alwaysOutputData?: boolean; onError?: OnError` with `type OnError = 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow'` ([packages/workflow/src/interfaces.ts](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/src/interfaces.ts)).
- **Per execution**, from the executions list: "Retry with currently saved workflow" (re-run with your fixed workflow) or "Retry with original workflow" (re-run the snapshot) ([view-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md)).

Failures can also route to a separate **error workflow**: "For each workflow, you can set an error workflow in Workflow Settings. It runs if an execution fails", starting from an Error Trigger node that receives the error message, failed node and execution id ([handle-errors-gracefully](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md)).

### Idempotency / dedup

Not a property of the run model. Dedup is an opt-in *node*: Remove Duplicates in mode "Remove Items Processed in Previous Executions" "compares items in the current input to items from previous executions" against a stored dedup database ("Value Is New", or high-water marks "Value Is Higher than Any Previous Value" / "Value Is a Date Later than Any Previous Date"), default history 10,000 items, scoped per node or per workflow, manually clearable ([removeduplicates node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.removeduplicates.md)). Nothing stops the same webhook delivery or re-observed state from producing two executions.

### Human in the loop

The Wait node: "When the workflow pauses it offloads the execution data to the database. When the resume condition is met, the workflow reloads the data and the execution continues." Resume modes: after a time interval, at a specified time, on webhook call (a generated `$execution.resumeUrl`), or on form submitted. Waits under 65 seconds stay in memory instead of offloading ([wait node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait.md)). The execution sits in the `waiting` status meanwhile ([execution-status.ts](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/src/execution-status.ts)).

### State storage

"By default, n8n uses SQLite as the database", via TypeORM. Workflows live in `workflow_entity` (with `workflow_history` for versions); executions span `execution_entity` (the record), `execution_data` ("the workflow at time of running, and the execution data" — i.e. a per-execution snapshot of the workflow plus all node outputs), and `execution_metadata` (custom key/values) ([understand-the-database](https://docs.n8n.io/deploy/host-n8n/understand-the-architecture/understand-the-database.md)).

---

## 2. Temporal

### What fires

Temporal has no trigger concept of its own: a client (your code, a Schedule/Cron, or a parent workflow) explicitly starts a Workflow Execution; run chains can be connected by "Continue-As-New, Retries, [or] Temporal Cron Job" ([workflow-execution](https://docs.temporal.io/workflow-execution)). External happenings reach a *running* workflow as messages (below). Ingesting "events" (e.g. GitHub webhooks) is your application's job.

### What a run is

A Workflow Execution is uniquely identified by "its Namespace, Workflow Id, and Run Id" ([workflow-execution](https://docs.temporal.io/workflow-execution)). Two-level identity is the load-bearing design:

- **Workflow Id** — "a customizable, application-level identifier … unique to an Open Workflow Execution within a Namespace"; Temporal "guarantees that there can be at most one Workflow Execution with a given ID running at any point in time" ([workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid)).
- **Run Id** — "a globally unique, platform-level identifier"; it changes on retry, Continue-As-New or cron while the Workflow Id stays constant. "A Workflow Execution Chain is a sequence of Workflow Executions that share the same Workflow Id" ([workflow-execution](https://docs.temporal.io/workflow-execution), [workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid)).

States split into open (Running, Paused) and closed (Completed, Failed, Cancelled, Terminated, Timed Out, Continued-As-New). Every execution carries an **Event History** — an append-only ledger; on replay the system "checks [generated] Commands against an existing Event History" so a recovered worker can "pick up where the last recorded event occurred" ([workflow-execution](https://docs.temporal.io/workflow-execution)).

The price is determinism: "Workflow code must be deterministic to support replay"; on replay "the Commands that are emitted are compared with the existing Event History" and any mismatch is a non-determinism error; no random branching, local-clock branching, or direct network calls in workflow code — "put them in Activities" ([workflow-definition](https://docs.temporal.io/workflow-definition)).

### What a step is

An Activity: "a normal function or method that executes a single, well-defined action", whose "code can be non-deterministic". Activity Definition (the code) is distinct from Activity Execution (a runtime attempt run by a Worker). Failed attempts restart "from the initial state, unless your code uses … Heartbeat details payloads for checkpointing". Execution is at-least-once, hence: "We recommend that it be idempotent" ([activities](https://docs.temporal.io/activities)).

### Retries

Asymmetric by design: "Temporal's default behavior is to automatically retry an Activity that fails", while "Workflow Executions do not retry by default". Default activity Retry Policy: initial interval 1 s, backoff coefficient 2.0, maximum interval 100 s, **maximum attempts unlimited** (0 = infinite), no non-retryable error types; non-retryable errors "will not be retried, regardless of a Retry Policy" ([retry-policies](https://docs.temporal.io/encyclopedia/retry-policies)).

### Idempotency / dedup

Start-time dedup rides on the Workflow Id, i.e. on the *caller choosing a business key as the id*:

- **Workflow Id Conflict Policy** (vs an open execution): Fail (default, "Workflow execution already started"), Use Existing (return the running execution), Terminate Existing.
- **Workflow Id Reuse Policy** (vs closed executions): Allow Duplicate (default), Allow Duplicate Failed Only, Reject Duplicate, Terminate if Running ([workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid)).

Inside a run, exactly-once *recording* comes from the event history, but activity side effects remain at-least-once — idempotency of effects is on you ([activities](https://docs.temporal.io/activities)).

### Human in the loop

Message passing to running workflows: "Queries are read requests … cannot block"; "Signals are asynchronous write requests … you cannot await any response"; "Updates are synchronous, tracked write requests" recorded in Event History whose sender "can wait for a response on completion or an error on failure" ([workflow-message-passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)). An approval gate is a workflow blocked awaiting a Signal/Update; the wait is durable because the whole run is.

### State storage

The Temporal Service persists histories and task queues; Workers "poll for Tasks in Task Queues via synchronous RPC" — "Workflow and Activity Tasks persist in a Task Queue. When a Worker Process goes down, the messages remain until the Worker recovers." Workers need no exposed ports or DNS registration ([task-queue](https://docs.temporal.io/task-queue)). This buys enormous durability, but it means operating a dedicated server cluster plus its datastore alongside your app.

---

## 3. Inngest

### What fires

Everything is an event. Payload format: required `name` ("Event `name`s are used to trigger functions") and `data` (any nested JSON); optional `id` — "a unique identifier for the event used to prevent duplicate events" — plus `ts` (ms epoch, set on receipt if absent) and `v` (payload schema version) ([event-format](https://www.inngest.com/docs/features/events-triggers/event-format)). "Events act as a convenient mapping between your application actions (ex, `user.signup`) and your application's code"; "events can trigger multiple Inngest Functions" (fan-out), a function can have multiple triggers including cron, and triggers support filter expressions, delays and batching ([events-triggers](https://www.inngest.com/docs/features/events-triggers)).

### What a run is

A function run is one execution of a function for a triggering event. "Inngest functions execute incrementally, *step by step*": the function is invoked repeatedly, and on each invocation completed steps are skipped — "Internally, the SDK uses the hash of the step name to look up the result in the state data", injecting memoized results instead of re-running. "The results of each step are returned to Inngest and persisted in a managed function state store." Orchestration state lives with Inngest; the function code runs on your infrastructure ("serverless, containers, or servers"), written "using standard language primitives" — no determinism regime, no special runtime ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)).

### What a step is

A `step.run()` block with a unique id — "an independent, durable checkpoint". On failure "the function is re-executed from the point of failure with the state of all previous step executions" ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)). Code *between* steps re-runs on every invocation; only step results are memoized.

### Retries

Default: "the initial attempt plus up to 4 retries, totaling 5 attempts", for functions and steps alike; configurable per function (`retries: N`, 0 disables). "Each `step.run()` has its own independent retry counter." Backoff is "exponential back-off with some jitter". `NonRetriableError` fails immediately; `RetryAfterError` schedules the next attempt at an exact time (e.g. honoring rate-limit headers) ([retries](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries)).

### Idempotency / dedup

Two first-class layers, both windowed at 24 h ([handling-idempotency](https://www.inngest.com/docs/guides/handling-idempotency)):

- **Event-level**: the producer sets `id`; it acts as an idempotency key "over a 24 hour period". A duplicate is stored (visible in event history) but does not trigger functions.
- **Function-level**: an `idempotency` config takes a CEL expression over the event (e.g. concatenating `userId` + `organizationId`) producing "a unique string key which idempotently prevents duplicate execution of the function", one run per unique key "per 24 hour period" — for when you don't control the producer (webhooks).

Adjacent flow control is separate and also first-class: concurrency limits (keyed), throttling, rate limiting ("skipping events beyond a specific limit"), debounce ("de-duplicating events over a sliding time window"), priority ([flow-control](https://www.inngest.com/docs/guides/flow-control)).

### Human in the loop

`step.waitForEvent()`: the run pauses until a matching event arrives or a timeout (e.g. `"3d"`) expires, returning the event or `null` for the fallback branch. Matching uses `if` expressions over both payloads (e.g. same `data.userId`). "Events fan out to many functions: you can resume many runs from a single event, without changing application code" ([wait-for-event](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event)). An approval is just an event that a waiting step matches.

### State storage

Split-brain by design: Inngest hosts the event log, queue and "managed function state store" (memoized step results); your servers only run function code and report step results back ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)).

---

## 4. Side-by-side

| Axis | n8n | Temporal | Inngest |
|---|---|---|---|
| What fires | Trigger node (webhook/schedule/poll) starts an execution directly | Client/Schedule starts a workflow; no event concept | Event (`name`+`data`, optional `id`) — decoupled from functions; fan-out |
| Run identity | Auto execution id; execution *is* the firing | Caller-chosen Workflow Id (business key) + platform Run Id; chains | Run created per (event, function); event `id` is the dedup handle |
| Run states | canceled/crashed/error/new/running/success/unknown/waiting | Open: Running, Paused; Closed: Completed/Failed/Cancelled/Terminated/TimedOut/Continued-As-New | Run + per-step checkpoints in state store |
| Step | Node in a DAG; outputs stored per node | Activity execution, recorded in append-only Event History | `step.run` result memoized by step-name hash |
| Retries | Per-node retryOnFail/maxTries/wait; whole-execution retry = new execution (`retryOf`) | Activities: auto, unlimited attempts by default; workflows: none | 5 attempts default, per-step independent counters, jittered backoff |
| Idempotency | None built-in; opt-in Remove Duplicates node with side DB | Workflow Id conflict/reuse policies (at most one open run per Id) | Event `id` dedup + function `idempotency` CEL key, 24 h windows |
| Human gate | Wait node; execution offloaded to DB in `waiting`; resume URL/form | Signal/Update to a durably blocked workflow | `step.waitForEvent` with match expression + timeout |
| State | SQLite/Postgres tables; execution_data JSON snapshot per run | Temporal Service cluster: event histories + task queues, polled by workers | Hosted event log + step-state store; code on your infra |

---

## 5. What this means for usine

### The minimal trigger→run shape that stays graph-ready

Four entities, not two:

1. **`event`** — one row per observed GitHub state change, with a **deterministic dedup key** derived from the state itself (e.g. `review-requested:{repo}:{pr}:{head_sha}`), unique-indexed per loop. This is Inngest's event `id` made explicit ([event-format](https://www.inngest.com/docs/features/events-triggers/event-format)) — except usine should *not* copy the 24 h window: "never act twice on the same GitHub state" wants an unbounded unique constraint, with the key versioned by the state that matters (`head_sha` changing legitimately produces a new key).
2. **`run`** — created from (event, loop), with its own id; status as an explicit open/closed state machine borrowed from Temporal: open `pending | running | waiting` vs closed `succeeded | failed | canceled` ([workflow-execution](https://docs.temporal.io/workflow-execution)). The Temporal invariant worth enforcing at the DB level: **at most one open run per dedup key per loop** ([workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid)).
3. **`step`** — one row per step with a stable step id and a stored result. v1 always has exactly one step (`agent`), but run→steps is 1:N from day one. This is the whole graph-readiness trick: Inngest added arbitrary DAG-ish workflows to a single-function model *because* results were already memoized per named step ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed)); n8n stores per-node output for the same reason. Adding multi-step later then means adding edges/ordering, not migrating run state.
4. **`attempt`** — retries live *under* a step (attempt number, error, timing), not as new runs. Both Temporal (Activity Executions within one workflow) and Inngest (per-step retry counters) do this ([activities](https://docs.temporal.io/activities), [retries](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries)).

Human gates fall out for free: an approval is an `event` that a `waiting` step's match predicate consumes — Inngest's `waitForEvent` semantics ([wait-for-event](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event)) on top of n8n's honest `waiting` run status and durable offload-while-paused ([wait node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait.md)).

### Choices usine would later regret

- **Conflating trigger firing with run identity** (n8n's model: the execution *is* the firing, dedup is a bolt-on node with a side database and a 10k-item cap ([removeduplicates](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.removeduplicates.md))). Without a separate event row + dedup key there is nowhere to hang "have we seen this GitHub state?", no fan-out later, and no audit trail of *why* a run exists.
- **Baking single-step into the run** — agent output/exit status as columns on `run`. Every system that grew workflows keeps step results addressable by step identity; flattening them into the run row is the one migration you can't do without rewriting history.
- **Retry-as-new-run** (n8n's `retryOf` chain). It fragments the story of one piece of work across rows and makes "did we already act on this PR?" a graph query. Attempts under a stable run identity keep the dedup invariant queryable with one index.
- **Unbounded retry defaults** — Temporal's activity default is *unlimited attempts* ([retry-policies](https://docs.temporal.io/encyclopedia/retry-policies)); for expensive agent invocations against live GitHub state, that is a footgun. Inngest's capped default (5 attempts) plus `NonRetriableError`/`RetryAfterError` style typed error control is the right shape ([retries](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries)).
- **Buying replay determinism** (Temporal). Its guarantees cost a server cluster, worker fleets and a determinism discipline on all orchestration code ([workflow-definition](https://docs.temporal.io/workflow-definition), [task-queue](https://docs.temporal.io/task-queue)) — mismatched with a single-operator local-first engine, and unnecessary: memoized step results give resumability without replaying code.
- **Time-windowed idempotency as the only dedup** (Inngest's 24 h windows ([handling-idempotency](https://www.inngest.com/docs/guides/handling-idempotency))). Fine for an event bus, wrong for "never review the same PR twice" — usine's key must be durable and derived from GitHub state, not TTL'd.

### Which model fits

**Inngest's, adapted.** Event-sourced triggers with a first-class dedup key, run = f(event, loop), steps as named memoized checkpoints with independent capped retries, and wait-for-event human gates — all of it implements cleanly on one SQLite/Postgres file with Effect, with no determinism regime and no cluster to operate. Take Temporal's two ideas that Inngest lacks: the business-key uniqueness invariant (one open run per dedup key, enforced in the DB the way Workflow Id Conflict Policy enforces it ([workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid))) and the explicit open/closed status taxonomy. Take n8n's UI ergonomics — `waiting` as a visible run status, per-step output inspection, and "retry with original vs current definition" ([view-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md)) — as observe/intervene features, not as data-model shape.
