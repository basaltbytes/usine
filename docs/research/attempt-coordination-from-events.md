# Coordinating an attempt from lifecycle events

Research for [#1150](https://github.com/basaltbytes/usine/issues/1150) and [#1149](https://github.com/basaltbytes/usine/issues/1149). Read on 2026-11-11 against usine `origin/main` at `658c8c444ded5141ca71c76fe5e360f862d40a20`, with `@earendil-works/pi-durable` 1.4.0, `@anthropic-ai/claude-agent-sdk` 0.3.311 (type declarations read from an installed copy of that exact version), and the Codex app-server schema generated at 0.164.0 (`packages/agents/src/protocol/codex/upstream-schema.json`). The dogfood instance's operator API was read with GET requests only. Claims that this note couldn't check against a pinned source are marked **unverified**.

## Recommendation

Accept #1150. Coordinate each attempt with a rules-driven durable task that starts one child with the rendered task, maps the child's typed result to the attempt outcome, and routes operator input to the live child; keep pi-durable as the store for that task and its delegations, and keep the Pi parent beside it, selected per agent with `parent: pi` or `parent: none`. Every decision point seen in the run history can be a rule, so the first release has no model call at all and an instance with only a Claude subscription runs from the first slice that exposes `parent: none`. Deliver in this order: extract the delegation core, the pure rules module, and a parent-optional attempt channel in parallel; then the event-driven attempt task; then configuration and replay tests in parallel; then the quickstart on a Claude subscription (seven pull requests, three of them parallel, before #1149 closes). Build the stateless decision call afterwards, only if classifying reports without a marker shows rules mislabel outcomes, and remove the Pi parent once `parent: none` is the default and nothing needs multi-child orchestration.

## Evidence

### Run history

From #1149's comment and #1150: 1,034 attempts in 991 runs, 2026-10-28 to 2026-11-11. 990 attempts had one child, 24 had two, 1 had three, and 19 had none (17 failed). 22 of the 25 multi-child attempts were reattached after a restart. Parent sessions used 7.9M of 155M tokens.

Read for this note:

- **Run `2c33c58d` (review-pr, reviewer).** Attempt 1's parent wrote its own paraphrase of the task as the `subagent` argument (about 600 characters restating the rendered task). The child's only output after its first sentence was `API Error: Request rejected (429) · This request would exceed your account's rate limit.` and then `SessionFinished`; the child's result reached the parent as an ordinary report, not as `AgentCapacityError`. The parent delegated again, got the same text, and ended with `[usine:blocked]`, so the attempt failed with `BlockedFailure` and `providerRetry` stayed null. Attempt 2, after a manual retry, succeeded with one child. The misclassification starts in the Claude adapter, not the parent: the parent only wrapped a report it was given (#1147, in progress).
- **The dogfood personas encode a pass-through parent.** `developer` and `finisher`: "If and only if a tool literally named `subagent` is available, delegate the full task to it once, passing the task text word for word, and return its result unchanged." `reviewer`: "If the subagent tool is available, delegate the full review to one child and return its result." Children read the persona too (`assembleChildPrompt`), and the reviewer's child in `2c33c58d` began with "I'll delegate the full review to one child agent", so it used Claude Code's own subagent tool: one usine child plus one nested Claude subagent for a task one session can do.
- **Settings.** `max_children: 4`, `parent_model: openai-codex/gpt-5.6-terra`, `parent_effort: medium`.

### Code

- **The rendered task already reaches the child unchanged** (`assembleChildPrompt` in `packages/agents/src/prompt.ts`; ADR 0005 amendment of 2026-11-02). The parent's `task` argument is "supplemental context".
- **The parent's whole instruction set** (`parentGuidance` in `packages/durable/src/attempt/extension.ts`) is: delegate, relay a reserved report verbatim, delegate again after an interrupted call with "inspect the checkout and continue", answer an operator message and wait, and act on a steer that couldn't be forwarded. Each is a rule.
- **Restart durability lives outside the parent conversation.** `subagent` is `replay: "safe"` (`subagent.ts:803`): a replay reuses the delegation's count and saved child session, restores holds, pauses, idle reports, unread operator input, and continuation history, and resumes the child through the shared continuation policy (`packages/agents/src/harness/continuation.ts`). The documents are `AttemptRecordDoc`, `HoldDoc`, and the task-scoped `SubagentDoc` (`attempt/documents.ts`, `attempt/child.ts`).
- **Outcome mapping already prefers the child.** `run` in `attempt/task.ts` fails the attempt with the child's stored report (`childBlocker`: blocked, question, failed, capacity, infra) when the parent relays none, and an infrastructure failure always wins.
- **Operator input to the parent is already forwarded** to the single live child for a steer (`routeParent`, `runtime.ts:374-397`). Operator messages, interrupts, and releases to the parent act on the Pi conversation and the parent's hold.
- **pi-durable tasks can own tasks.** `TaskRuntime` in pi-durable 1.4.0 has `waitForTask`, `ownedTasks`, `abortOwned`, and `outcomes`, and `TaskOptions.ownership` accepts a task owner (`dist/types.d.ts:235-262`, `:341`). A coordinator task can create one delegation task per child and wait on it, and both resume after a restart. Whether aborting an owner cascades to task-owned tasks is **unverified**; `abortOwned` covers it explicitly.
- **The relay is coupled to the parent session.** `relayAttempt` emits `Started` only once `record.parentModel` is set and holds early worker notices until then (`relay.ts:587-628`). `Started.parentModel` is a required `ModelId` (`core/src/attempt/channel.ts:95`).
- **The engine already handles the rest.** `ProviderCapacityFailure` and `InfraFailure` are the retryable failures (`core/src/attempt/failure.ts:126`), and the engine waits for a provider limit through `providerRetry`. `CompletionCheck` verifies outcome labels after a successful attempt and fails the run with `AgentFailure` when they're missing (`engine/src/completion-check.ts`).

## Answers to the questions in #1150

### 1. Which decision points need a model?

None of the observed ones. Each row below is a rule, and the table names what the rule reuses.

| Decision point | Rule | Reuses |
| --- | --- | --- |
| Attempt starts | Delegate with the rendered task and a fixed one-line context. | `assembleChildPrompt` |
| Child returns a report with a reserved marker | Fail with the mapped failure. | `childReportFailure` |
| Child returns a report without a marker | Complete with the report as the attempt's message. The engine's `CompletionCheck` still verifies outcome labels. | `completedOutcome`, `CompletionCheck` |
| Child hits a provider limit | Fail with `ProviderCapacityFailure`; the engine waits and retries. Requires the adapter to classify the limit (#1147). | `AgentCapacityError`, `providerRetry` |
| Child fails to launch or loses its transport | Fail with `InfraFailure`; the engine retries from salvage. | `recordInfrastructureFailure` |
| Restart while a child runs | Resume the saved child session. | `subagent` replay path |
| Restart, and the child can't resume (no saved session, other worker or checkout, resume refused) | Delegate one replacement within the child-session budget, with the context the parent prompt prescribes today: inspect the checkout and continue. Otherwise fail with `InfraFailure`. | Child-session budget, `childBlocker` precedence |
| Budget exceeded | Fail with `ChildSessionBudgetFailure`. | `childBudgetExceeded` |
| The run ends without its outcome label | Unchanged: the engine fails the run. A follow-up child here is an option (owner question 3), not a requirement. | `CompletionCheck` |

The only point where a model could add judgement is a report without a marker whose text contradicts success, like the `API Error … (429)` report in `2c33c58d`. The right fix for that case is in the adapter (#1147), because a classifier can be wrong in the same way a parent was. A decision call stays useful for free-text reports that no adapter can classify; whether those occur is the classification below.

**Classification still to do.** The operator API has no list of runs, so the 19 attempts without a child and the two uninspected multi-child runs (`d35305c2`, `f74f34a7`; only short IDs were available) couldn't be fetched by ID. The classification needs, per attempt: the attempt ID, its outcome and failure tag, the number of child `SessionStarted` events, and the parent's last `TextOutput`. A read-only query on `usine_attempts` joined with `usine_attempt_transcripts` on the dogfood host gives all four. For the 19, the expected classes are a parent start failure (unknown model, refused credential, ChatGPT window exhausted), a parent that answered without delegating, and a cancellation before the first delegation; all three disappear or become a child failure under `parent: none`.

### 2. Is planned multi-child work a use case to keep?

Not in one attempt. No attempt split a task, and all three personas tell the parent not to. Multi-agent work already exists between loops: review hands to act-on-findings through labels, and step outputs ([ADR 0034](../adr/0034-step-outputs.md)) carry typed results from one run to the next. Keep `parent: pi` as the opt-in for in-attempt orchestration during migration, and remove it unless a loop shows a need that a handoff can't serve (owner question 2).

### 3. Typed contract of a decision call

The call is optional and never on the path that keeps an instance running.

- **Input** (`DecisionRequest`): the attempt ID, the question tag (`UnclearReport` first), the rendered task truncated to a fixed size, the child's final report truncated to a fixed size, the reserved markers and their meanings, children used and the budget, and the loop's outcome labels.
- **Output** (`Decision`, decoded with Schema from the model's structured output): `Accept`, `Fail { kind: "blocked" | "question" | "failed", message }`, or `Delegate { context }`. The rules clamp it: `Delegate` past the budget becomes `Fail { kind: "failed" }` with the budget in the message.
- **Failure mode**: every failure is `DecisionUnavailable { reason }`, never an attempt failure. No admitted route, a refused credential, a provider limit, a timeout, or output that doesn't decode all fall back to the rule for that point, which for `UnclearReport` is `Accept`, today's behavior when the Pi parent returns plain text. An instance with no decision route behaves exactly like rules-only.
- **Durability**: the coordinator commits `Decide` as its checkpoint before the call and commits the decision with the next transition. A restart reruns the call; it is at least once and costs tokens only.

### 4. A stateless call on a Claude subscription

Run it through the agent's own harness, on the attempt's worker, with the attempt's credential route, as one tool-less turn. For Claude Code that is the Agent SDK `query()` driving the unmodified Claude Code binary, which is the same client path the children use today and the one [model-access.md](./model-access.md) requires. Verified in SDK 0.3.311 `sdk.d.ts`: `tools: []` disables every built-in tool (`:1680-1689`), `outputFormat: { type: "json_schema", schema }` constrains the result (`:2005-2021`, `OutputFormat` at `:2528`), the result carries `structured_output` (`:6097`) or fails with `error_max_structured_output_retries` (`:5943`), and `persistSession: false` keeps no transcript (`:1863`). `maxTurns` limits the call (`:1973`).

For Codex, `thread/start` accepts `ephemeral` and `turn/start` accepts `outputSchema` in the 0.164.0 schema. Disabling Codex's shell and edit tools for that turn is **unverified**, so Codex doesn't declare the capability until a probe shows a tool-less turn. Pi calls a pi-ai provider directly, which is stateless by construction; its structured output is **unverified** in pi-ai 1.4.0.

Terms: this adds no route. The call uses the credential that already pays for the child, through the client already admitted for it ([ADR 0027](../adr/0027-gateway-credential-proxy.md), amendment of 2026-10-26). The Agent SDK overview's restriction on third-party products offering claude.ai login applies to it exactly as it applies to the children today, no more.

### 5. Operator input with more than one live child

The event-driven coordinator runs children one at a time, so at most one is live. A parent-addressed message, steer, interrupt, or release goes to that child, with the child's hold and pause semantics. When no child is live (between a finished child and the outcome commit, or during a decision call), the coordinator refuses the input with "No session is working on this attempt", recorded as `InterventionRejected`. Concurrent children exist only under `parent: pi`, where today's rule stays: a steer is forwarded only when exactly one child is live, and other input goes to the Pi parent.

### 6. Migration beside the Pi parent

Yes. `RunSpec` gains a `parent` field that decodes as `pi` for older attempts, and `createOrFind` creates either the existing `usine.attempt` task or the new `usine.coordinator` task. The choice is stored in the task input, so an attempt keeps its coordinator across a configuration change and a restart. Configuration selects it per agent with an instance default. Both tasks share `AttemptRuntime`, the hubs, the relay, the documents, and the delegation core.

### 7. What remains of `packages/durable` and pi-durable

pi-durable stays: it is the transactional store, the task scheduler, document watches, and restart resume for the coordinator and delegation tasks. After the Pi parent is removed, `packages/durable` keeps `harness.ts` (storage and resume), `attempt-runtime.ts`, `attempt/runtime.ts` without `routeParent`'s conversation branches, `hubs.ts`, `relay.ts` without parent entries and parent usage, `documents.ts`, `child.ts`, `repair.ts`, `request.ts`, `outcome.ts`, `watch.ts`, the delegation core, and `coordinator/`. It deletes `attempt/parent.ts`, `attempt/task.ts`, `attempt/extension.ts`, `attempt/steering.ts`, `attempt/events.ts`, `gateway.ts`, the parent half of `live.ts`, and `fauxParent` in `testing.ts`. `@earendil-works/pi-ai` and `pi-coding-agent` stay only while Pi is a child harness. A later move off pi-durable, for example to Durable Objects, gets easier: a rules coordinator waits on events and can hibernate, which a model parent couldn't ([event-driven-orchestrator.md](./event-driven-orchestrator.md), "Consequences for an Attempt").

## Decision

Coordinate attempts from lifecycle events with rules, as #1150 proposes. The model parent's recorded reason, in-run orchestration ([ADR 0005](../adr/0005-pi-parent-agent-layer-team-roster.md), "Considered options"), isn't used: one child per attempt in 96% of attempts, no split in any, and personas that forbid it. The durable state is the delegation journal, which this design keeps. The decision call is deferred until the classification in answer 1 shows a need. Step 11 of [harness-adapters.md](./harness-adapters.md) (the journaled vendor coordinator) is dropped.

## Options compared

| | A. Journaled vendor coordinator | B. Event-driven coordinator (#1150) | C. Wider Pi routes | D. t3code practices |
| --- | --- | --- | --- | --- |
| Claude-subscription-only user | Gets a Claude Code parent on the orchestrator host, billed to the plan | Gets every loop with no parent; optional decision calls bill the plan through Claude Code | Nothing: Anthropic's terms exclude Pi from the Claude plan | Not an option on its own; informs B |
| Restart recovery versus pi-durable today | Weaker: the in-flight parent turn and its tool call are lost and reconciled by message; duplicate delegation needs single-flight guards | Equal for children (same replay path); stronger for the coordinator, which has no turn to lose: each transition is one commit | Unchanged | — |
| Critical-path risk | High: second coordinator implementation, per-vendor restart matrix | Medium: one new task over existing documents; relay decoupling | Low per provider, but pools are a core schema change | — |
| Pull requests to the quickstart goal | 4 to 6 on the critical path, plus configuration | 7, three in parallel | Not reachable | — |
| Maintenance | Two coordinators, vendor transcript reconciliation | One coordinator; the Pi parent is deleted later | One pool per provider, terms tracking per OAuth client | — |

**A.** Claude SDK 0.3.311 has what A needs: `createSdkMcpServer` (`sdk.d.ts:633`), `sessionId` and `resume` (`:2133-2139`), and an alpha `sessionStore` that mirrors transcripts to external storage (`:1875`, `:6867`). Codex 0.164.0 has the `item/tool/call` server request and `DynamicToolSpec`, but `dynamicTools` isn't in the stable `ThreadStartParams`; it sits behind `experimentalApi`, and MCP is the stable path. None of this removes the need for usine's journal and a reconciliation step after resume, which is the cost #1150 avoids. Replaced if this design is accepted.

**C.** Pi 1.4.0 has subscription OAuth for `github-copilot`, `openai-chatgpt`, `anthropic`, `meta`, `kimi-coding`, `openai-codex`, and `xai` (`isSubscription: true` in `dist/auth/oauth/*.js`), and API-key providers such as OpenRouter, DeepSeek, Z.ai, Groq, and the token-plan providers. On the orchestrator host, `resolvePiPool` already admits every API-key provider into `apiKeys`, including OpenAI-compatible endpoints and local models through `models.json`; only the gateway path (`gatewayModelAccess`) restricts the parent to `anthropic`, `openai`, and `openai-codex`. Adding a subscription OAuth provider needs a new `BillingPool` literal (core, accounting, web) and a terms review per OAuth client; GitHub's and xAI's terms for third-party clients are **unverified**. None of it helps a Claude-only user. Not worth a slice. One sentence in #1148 can say that any Pi API-key provider, including OpenRouter and a local OpenAI-compatible endpoint, already runs the parent.

**D.** t3code has no parent session either: delegation is an app-owned durable record, and recovery and continuation are harness-neutral policies above the adapters ([t3code-harness-encapsulation.md](./t3code-harness-encapsulation.md)). usine has adopted the continuation policy, the process owner, usine-assigned IDs, and replay tests. Two points apply here: each t3code driver instance carries a text-generation service next to its orchestration adapter (`driver.ts:35-117`), which is the shape of the `decide` primitive below; and finalization replays from persisted events after a restart (`orchestrator-mcp-server.md:510-513`), which is what committing each coordinator transition gives.

## Design

### Seam

The coordinator is a pi-durable task whose phases react to one event each and commit the resulting action with the next checkpoint. Events are the typed results that already exist: the attempt start, a delegation's outcome, and a decision's outcome. Operator input doesn't pass through the coordinator; `AttemptRuntime.intervene` routes it to the live child. No new event bus: the delegation task's terminal receipt (`waitForTask`) is the event, and the task checkpoint is the journal.

```text
engine run fiber ─ AttemptRuntime.execute ─ relay ─ attempt channel ─ transcript
                         │
           usine.coordinator task (parent: none)        usine.attempt task (parent: pi)
             start ─▶ delegate ─▶ [decide] ─▶ terminal       Pi conversation + subagent tool
                         │                                          │
                 usine.delegation task ◀── delegation core ──▶ subagent tool
                         │
                 ChildBackend.launch / resume (Harnesses, continuation policy)
```

### Modules

```text
packages/durable/src/attempt/
  delegation/
    delegation.ts   delegate(): one child from launch or resume to a typed outcome (moved from subagent.ts)
    journal.ts      DelegationJournal: the commits, reads, watches, and output a delegation needs
  coordinator/
    rules.ts        platform-free and pure: next(state, event) -> [state, action]
    task.ts         usine.coordinator and usine.delegation pi-durable tasks
    decision.ts     DecisionCalls service; rulesOnly layer (added with the decision slice)
  subagent.ts       the Pi tool: a DelegationJournal over ToolExecutionApi, then delegate()
```

### Interface sketch

```ts
// delegation/delegation.ts
export const DelegationOutcome = Schema.Union([
  Schema.TaggedStruct("Reported", { sessionId: AgentSessionId, report: Schema.String, answeredOperator: Schema.Boolean }),
  Schema.TaggedStruct("Reserved", { sessionId: AgentSessionId, kind: ReservedKind, message: Schema.NonEmptyString }),
  Schema.TaggedStruct("Interrupted", { sessionId: AgentSessionId, reason: Schema.NonEmptyString, output: Schema.String }),
  Schema.TaggedStruct("BudgetExceeded", { attempted: ChildSessionCount, max: ChildSessionBudget }),
]);
export type DelegationOutcome = typeof DelegationOutcome.Type;

/** Runs one delegation; fails with `AgentSessionError` only for a launch failure on a fresh delegation. */
export const delegate: (
  journal: DelegationJournal,
  assignment: string,
) => Effect.Effect<DelegationOutcome, AgentSessionError | DurableHarnessError, ExtensionServices | Scope.Scope>;

// delegation/journal.ts: one value per delegation, built by the tool or the delegation task.
export interface DelegationJournal {
  readonly attemptTaskId: TaskId;
  readonly delegationId: TaskId; // keys SubagentDoc
  readonly commit: <A>(change: (tx: Tx) => A | Promise<A>) => Effect.Effect<A, DurableHarnessError>;
  readonly snapshot: <D>(doc: DocDefinition<D>, id: string) => Effect.Effect<D | undefined, DurableHarnessError>;
  readonly watch: <D>(doc: DocDefinition<D>, id: string, accept: (value: D) => boolean) => Effect.Effect<D, DurableHarnessError>;
  readonly output: (text: string) => Effect.Effect<void, DurableHarnessError>;
  readonly aborted: Effect.Effect<void>; // completes when the owning call or task aborts
}

// coordinator/rules.ts
export const CoordinatorEvent = Schema.Union([
  Schema.TaggedStruct("AttemptStarted", {}),
  Schema.TaggedStruct("Delegated", { outcome: DelegationOutcome }),
  Schema.TaggedStruct("DelegationFailed", { message: Schema.NonEmptyString }),
  Schema.TaggedStruct("Decided", { decision: Decision }),
  Schema.TaggedStruct("DecisionUnavailable", { reason: Schema.NonEmptyString }),
]);
export const CoordinatorAction = Schema.Union([
  Schema.TaggedStruct("Delegate", { assignment: Schema.String }),
  Schema.TaggedStruct("Decide", { request: DecisionRequest }),
  Schema.TaggedStruct("Complete", { message: Schema.NonEmptyString, answeredOperator: Schema.Boolean }),
  Schema.TaggedStruct("Fail", { failure: AttemptFailure }),
]);
export class CoordinatorState extends Schema.Class<CoordinatorState>("@usine/durable/CoordinatorState")({
  delegations: Schema.Int,
  replacements: Schema.Int,
  maxChildren: ChildSessionBudget,
}) {}

/** Returns the next state and action; the only place coordinator policy lives. */
export const next: (
  state: CoordinatorState,
  event: typeof CoordinatorEvent.Type,
) => readonly [CoordinatorState, typeof CoordinatorAction.Type];

// coordinator/decision.ts (decision slice)
export class DecisionCalls extends Context.Service<
  DecisionCalls,
  { readonly decide: (request: DecisionRequest) => Effect.Effect<Decision, DecisionUnavailable> }
>()("@usine/durable/attempt/coordinator/DecisionCalls") {
  static readonly rulesOnly: Layer.Layer<DecisionCalls>;
}
```

The `usine.coordinator` task has three phases. `start` commits `CoordinatorState` and the first `Delegate`. `delegate` creates the `usine.delegation` task in the same commit as its checkpoint (so a restart finds it), waits for it with `waitForTask`, applies `next`, and commits the following checkpoint or the terminal outcome. `decide` exists only with the decision slice. A terminal `Complete` or `Fail` waits under `hub.routing`, like `run` in `task.ts` today, until no forwarded steer is pending.

`answeredOperator` comes from the child: the shared conversation (`packages/agents/src/harness/conversation.ts`) already knows whether the turn that produced the final report started from an operator message, and `RunningSession.result` gains that flag. This keeps ADR 0018's rule that an answer to the operator with no commit, pull request, comment, or step output fails the attempt.

### Configuration

| Key | Where | Values | Default |
| --- | --- | --- | --- |
| `parent` | `settings` and agent frontmatter | `pi`, `none` | `pi` until the default flips (owner question 1) |
| `parent_model`, `parent_effort` | unchanged | Pi model and effort | Used only with `parent: pi`; set with `parent: none` is a configuration error |
| `decision_model`, `decision_effort` | added by the decision slice | a model of the agent's harness | the agent's model at `low` effort |

`parent_harness` from decision 3 of the harness-adapters study isn't added: no second harness fills the coordinator role.

### Admission

- With `parent: none`, configuration load, reload, and startup skip the coordinator admission (`packages/orchestrator/src/parent-admission.ts`), so an instance without a Pi credential starts and quarantines no agent. The child brain is still admitted as `coding-agent` on every worker.
- The decision call runs as the agent's harness on the attempt's worker with the child's admitted route. It needs one new capability, `structured-output`, declared by Claude Code; Pi and Codex declare it after their probes.
- `durable-coordination` and the `coordinator` role stay for `parent: pi` and are removed with the Pi parent.

### Restart matrix

| Restart point | Expected | Test |
| --- | --- | --- |
| Before `start` commits | `start` reruns; one delegation | Unit test with SQLite storage and a scripted `ChildBackend` (`packages/durable/test/support.ts`) |
| After the delegation task commits, before the child saves its session | The delegation returns `Interrupted`; one replacement child within budget; the replacement clears the earlier infrastructure failure | Unit test, interrupting the `execute` fiber at the journal's `started` |
| While the child works | The saved child resumes with one continuation instruction; same child ID and budget slot | `packages/durable/test/replay.ts` `restart` scenario for Claude and Codex, without `fauxParent` |
| After the child finished, before the coordinator's transition commits | The delegation task's terminal receipt is read; no second child | Unit test, interrupting between `waitForTask` and the transition commit |
| While the child is held or paused | Hold and pause restored before any turn; Release returns the saved report | `held-child-recovery.test.ts` cases run under `parent: none` |
| While releasing | One terminal outcome | Unit test |
| With queued operator input | Unread input delivered to the resumed child | `child-recovery-inputs.test.ts` cases under `parent: none` |
| Credential kind changed | The resumed child uses the current route | `replay.ts` `credential-changed` scenario |
| Configuration changed from `pi` to `none` during the attempt | The attempt keeps `usine.attempt` | Unit test on `createOrFind` |
| During a decision call (decision slice) | The call reruns; one transition | Unit test with a scripted `DecisionCalls` |

### Docs, glossary, and ADR amendments

- **ADR 0005**: amendment. The attempt coordinator is a durable task driven by child outcomes, with no model unless a decision point asks for one. The original reason for a model parent, in-run orchestration, isn't used (run history above). `parent: pi` keeps the Pi parent during migration.
- **ADR 0003**: the amendment of 2026-10-11 says an attempt is the pi-durable task running its Pi parent. Amend: with `parent: none`, the attempt task owns delegation tasks instead of a conversation.
- **ADR 0018**: "message the parent" addresses the live child under `parent: none`; the answered-operator rule reads the child's final turn.
- **ADR 0021**: an attempt with `parent: none` has no parent pool; decision calls record the child route's pool.
- **harness-adapters.md**: decisions 2 and 3 superseded; step 11 dropped.
- **CONTEXT.md**: Reattach ("if its Pi parent's durable task is still live") becomes "if its durable task is still live"; Hold, Worker, and Child-session budget drop "Pi parent" where it no longer holds. No new term is needed until the decision slice, which adds **Decision call** if the owner keeps it.
- **Docs**: `reference/configuration/agents.md` ("Parent selection"), `reference/configuration/settings.md`, `guides/message-an-agent.md`, `guides/answer-an-agent.md`, `get-started/quickstart.mdx`, and the README feature list.

## Implementation issues, in order

Parallel groups touch no common file: **{1, 2, 3}**, then 4, then **{5, 6}**, then 7. Issue 8 can run in parallel with any of 4 to 7. Each issue amends the ADRs and docs its behavior change touches, in the same pull request.

### 1. Extract the delegation core from the `subagent` tool

**Context.** The `subagent` tool in `packages/durable/src/attempt/subagent.ts` holds the whole delegation: budget accounting, saved-session resume, hold and input restoration, event forwarding, and report mapping. A coordinator without a Pi conversation needs the same logic outside a tool call. See the design note for #1150.

**Scope.** Move the delegation into `attempt/delegation/delegation.ts` behind a `DelegationJournal` interface and return a `DelegationOutcome` tagged union (`Reported`, `Reserved`, `Interrupted`, `BudgetExceeded`). The tool builds a journal over `ToolExecutionApi` and maps the outcome to its `ToolExecutionResult`. No behavior change.

**Acceptance criteria.**
- The existing durable tests pass unchanged, including `subagent-recovery`, `subagent-progress`, `held-child-recovery`, `child-recovery-inputs`, `continuation-limit`, and the replay tests.
- New unit tests cover each `DelegationOutcome` variant through `delegate` with an in-memory journal.
- `subagent.ts` contains no delegation policy, only the journal adapter and result mapping.

**Files.** `packages/durable/src/attempt/subagent.ts`, new `attempt/delegation/{delegation,journal}.ts`, `attempt/child.ts`, `packages/durable/test/`.

**Blocked by.** None.

### 2. Add the coordinator rules as a pure module

**Context.** #1150 coordinates an attempt from lifecycle events. Its policy (delegate, map the outcome, replace an interrupted child within budget) must live in one testable place.

**Scope.** Add `packages/durable/src/attempt/coordinator/rules.ts` with `CoordinatorState`, `CoordinatorEvent`, `CoordinatorAction`, and `next`. It imports only `@usine/core` schemas and has no IO. Not wired yet.

**Acceptance criteria.**
- Unit tests cover every row of the rules table in the design note: start, reported, each reserved kind, capacity, infrastructure failure, interrupted with and without budget, budget exceeded.
- A replacement after an interruption happens at most once per interruption and never past `maxChildren`.
- The module has no dependency on pi-durable or `@usine/agents` runtime code.

**Files.** New `packages/durable/src/attempt/coordinator/rules.ts`, new `packages/durable/test/coordinator-rules.test.ts`.

**Blocked by.** None.

### 3. Relay an attempt whose parent has no session

**Context.** `relayAttempt` emits `Started` and releases early worker notices only after the Pi parent's model is recorded, and `Started.parentModel` is required. An attempt without a parent session can't start its channel.

**Scope.** Make `Started.parentModel` optional with a decoding default for stored transcripts. Emit `Started` when the attempt task starts, independent of the parent session; keep the parent session and its usage relay when one exists. Show "No parent session" on the run page's attempt details when the model is absent. Regenerate the operator API schema.

**Acceptance criteria.**
- Stored transcripts with `parentModel` decode unchanged; the web transcript model tests pass.
- A relay test with no parent model emits `Started`, then early worker notices, then child events.
- Pi-parent attempts emit the same envelopes in the same order as before.

**Files.** `packages/core/src/attempt/channel.ts`, `packages/durable/src/attempt/relay.ts`, `apps/web/src/components/runs/transcript/attempt-meta.tsx`, `apps/web/src/lib/runs/transcript/model.ts`, `apps/web/src/lib/runs/transcript/document/model.ts`, `apps/docs/public/openapi.json`, tests.

**Blocked by.** None.

### 4. Run attempts without a parent session

**Context.** With the delegation core (1), the rules (2), and a parent-optional channel (3), an attempt can run as a durable task that starts one child and maps its outcome, with no model. See the design note for #1150.

**Scope.**
- Add the `usine.coordinator` and `usine.delegation` pi-durable tasks in `attempt/coordinator/task.ts`, driven by `next`.
- Add `parent: "pi" | "none"` to `RunSpec`, decoding as `pi`; `createOrFind` picks the task from it.
- Route parent-addressed operator input to the live child under `parent: none`, and refuse it when no child is live.
- Add `answeredOperator` to the child's result from the shared conversation and use it for the attempt report.
- Amend ADRs 0003, 0005, and 0018.

**Acceptance criteria.**
- With `parent: none`, an attempt with a scripted child completes, fails with each reserved kind, fails with `ProviderCapacityFailure` on `AgentCapacityError`, and fails with `InfraFailure` on a launch failure.
- Each unit-test row of the restart matrix in the design note passes against SQLite storage.
- Steer, operator message, interrupt, and release addressed to the parent act on the live child, and the transcript records them as applied or rejected.
- `parent: pi` attempts behave as before; the existing durable suite passes.
- Cancel stops the delegation task and its child.

**Files.** `packages/durable/src/attempt/{runtime,request,outcome,documents}.ts`, new `attempt/coordinator/task.ts`, `packages/core/src/attempt/channel.ts`, `packages/agents/src/harness/conversation.ts`, `packages/agents/src/runtime.ts`, `packages/executor/src/durable-session.ts`, `docs/adr/0003-*.md`, `0005-*.md`, `0018-*.md`, tests.

**Blocked by.** 1, 2, 3.

### 5. Configure `parent: none` per agent and instance

**Context.** Issue 4 runs attempts without a parent when `RunSpec.parent` is `none`. Operators need to select it, and an instance without a Pi credential must start.

**Scope.** Add `parent` to instance settings and agent frontmatter (snake_case key, encoded at the parse boundary), resolve it like `parent_model`, and pass it to `RunSpec`. Skip coordinator admission for `parent: none` at load, reload, and startup. Refuse `parent_model` or `parent_effort` together with `parent: none`. Add the field to the configuration forms and views. Update the agents and settings reference pages, CONTEXT.md, and the harness-adapters decisions.

**Acceptance criteria.**
- An instance with `parent: none` and no Pi credential starts, quarantines no agent, and runs a loop.
- Import, reload, and saved edits accept `parent: none` and refuse it with `parent_model` set, with a field path in the problem.
- An agent override wins over the instance setting.
- The web configuration pages show and edit the setting.

**Files.** `packages/config/src/{factory,parser,agent}.ts`, `packages/core/src/agent/agent.ts`, `packages/orchestrator/src/parent-admission.ts`, `packages/orchestrator/src/parent-models.ts`, `packages/engine/src/engine/submission.ts`, `apps/web/src/features/configuration/`, `apps/docs/src/content/docs/reference/configuration/{agents,settings}.md`, `CONTEXT.md`, `docs/research/harness-adapters.md`.

**Blocked by.** 4.

### 6. Replay restart scenarios through the event-driven coordinator

**Context.** The durable replay tests (#1005) run recorded Claude and Codex traffic through a scripted Pi parent. The event-driven coordinator needs the same evidence without one.

**Scope.** Run the `restart` and `credential-changed` scenarios in `packages/durable/test/replay.ts` with `parent: none`, using the existing fixtures in replay mode.

**Acceptance criteria.**
- Both scenarios pass for Claude and Codex in CI with `parent: none`: one interrupted native tool call closed, two `SessionStarted` events for the same child ID, one terminal outcome.
- The existing `parent: pi` replay cases still pass.

**Files.** `packages/durable/test/replay.ts`, `packages/durable/test/support.ts`.

**Blocked by.** 4.

### 7. Run the quickstart on a Claude subscription

**Context.** #1149: an instance with only a Claude subscription can't start a run. After issue 5, it can.

**Scope.** Rewrite the quickstart prerequisites and bootstrap files so the path works with either a Claude or a ChatGPT subscription: `parent: none` in `usine.yaml`, and the developer agent's harness chosen to match the connected provider. Update the README feature list and replace the parent limit that #1148 documents.

**Acceptance criteria.**
- The quickstart lists a Claude or ChatGPT subscription as the requirement and needs no API key.
- The bootstrap `usine.yaml` sets no `parent_model`.
- `pnpm` docs checks pass; the README no longer says the coordinating session needs a ChatGPT login or an API key.

**Files.** `apps/docs/src/content/docs/get-started/quickstart.mdx`, `apps/docs/quickstart/usine.yaml`, `apps/docs/quickstart/agents/developer.md`, `README.md`.

**Blocked by.** 5. Closes #1149.

### 8. Add a structured-output call to harness runtimes (after owner question 4)

**Context.** A stateless decision call needs one tool-less turn with a JSON Schema result, through the agent's harness and route.

**Scope.** Add `structured-output` to `Capability` and an optional `structured` operation to the harness runtime: Claude Code through `query()` with `tools: []`, `outputFormat`, `persistSession: false`, and `maxTurns`; Pi through a pi-ai provider call if a probe shows structured output. Codex declares the capability only if a probe shows a turn without shell or edit tools. Record replay fixtures for Claude.

**Acceptance criteria.**
- A Claude replay test returns a decoded value and maps `error_max_structured_output_retries` to a typed error.
- Admission refuses `structured-output` with a reason for harnesses that don't declare it.
- No tool call appears in the recorded Claude traffic.

**Files.** `packages/agents/src/harness/{capability,harness,runtime}.ts`, `packages/agents/src/harness/claude/{claude,descriptor,sdk}.ts`, `packages/agents/src/harness/pi/`, `packages/agents/test/replay/`.

**Blocked by.** None for the code; the owner's answer to question 4.

### 9. Ask a decision model about reports without a marker (after issue 8 and the classification)

**Scope.** Add `DecisionCalls` with a `rulesOnly` layer and a harness-backed layer, the `decide` phase, `decision_model` and `decision_effort`, and the `UnclearReport` point. Record decision usage on the attempt's parent session with the child route's pool. Add **Decision call** to CONTEXT.md.

**Acceptance criteria.** `DecisionUnavailable` for every failure falls back to the rule; a restart during a call reruns it once; usage appears under the recorded pool.

**Blocked by.** 4, 8.

### 10. Default new instances to `parent: none`

**Scope.** Setup and `usine init` bootstrap files write `parent: none`; the settings default changes only after the owner decides (question 1).

**Blocked by.** 7.

### 11. Remove the Pi parent

**Scope.** Delete the files listed in answer 7, `parent_model`, `parent_effort`, the `coordinator` role, and `durable-coordination`; configuration import warns about and drops the removed keys. Amend ADRs 0005 and 0021.

**Blocked by.** 10 and owner question 2. Likely two pull requests: runtime, then configuration and docs.

## Questions for the owner

1. **Key and default.** Use `parent: pi | none` in settings and agent frontmatter? Recommended: yes, with `pi` as the default for existing instances, `none` written by new bootstrap files (issue 10), and the default flipped after a month of dogfood on `none`.
2. **Keep in-attempt multi-child orchestration?** Recommended: no. Keep `parent: pi` until the default flips, then remove it (issue 11); multi-agent work stays in loop handoffs.
3. **A missing outcome label.** Start one follow-up child that is told which label is missing, or keep failing the run as today? Recommended: keep today's behavior, and decide after classifying the runs that failed this way (`d35305c2` is one).
4. **Build the decision call now?** Recommended: not yet. Run the classification in answer 1 first; build issues 8 and 9 only if reports without a marker mislabel outcomes after #1147 lands.
5. **Interrupted child with no saved session.** Replace it in the same checkout within the budget, or fail with `InfraFailure` so the engine retries from salvage? Recommended: replace once in the same checkout, which is what the Pi parent is told to do today and keeps the work without a salvage round trip.
6. **Dogfood personas.** The three personas carry "if the subagent tool is available, delegate once" clauses, and the reviewer's wording led its child to start a nested Claude subagent. Recommended: remove the clauses when the dogfood agents switch to `parent: none`, and stop documenting the pattern.

## Rough edges found

- `2c33c58d`: a Claude child that printed `API Error: Request rejected (429)` finished as an ordinary report instead of `AgentCapacityError`. Tracked by #1147.
- The `reviewer` persona's delegation clause lacks the "literally named `subagent`" guard that `developer` and `finisher` have, so its Claude child delegates to a nested Claude subagent.
- The operator API has no list of runs or attempts, so run-history classification needs host SQL access.
