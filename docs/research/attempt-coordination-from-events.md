# Coordinating an attempt from lifecycle events, version 2

Second version of the design for [#1150](https://github.com/basaltbytes/usine/issues/1150) and [#1149](https://github.com/basaltbytes/usine/issues/1149). [Version 1](./attempt-coordination-from-events-v1.md) kept pi-durable as the coordinator's store. This version removes it from the coordinator, makes the wake-up seam a core part of the design, and admits three handler kinds behind that seam.

Read on 2026-11-11 against usine `origin/main` at `658c8c444ded5141ca71c76fe5e360f862d40a20`. Pinned sources: `@earendil-works/pi-durable` 1.4.0, `effect` 4.0.6, `@anthropic-ai/claude-agent-sdk` 0.3.311 (type declarations), and the Codex app-server schema generated at 0.164.0. CLI flags were checked on the locally installed Claude Code 2.1.322 and Codex CLI 0.153.4, which differ from the pins (Claude Code 2.1.311 in worker images, Codex 0.164.0); those checks are marked. Claims not checked against a pinned source are marked **unverified**.

The goal is a quickstart that requires no subscription from a specific model provider. A new instance must start and complete runs with whichever single harness login or key the person has for the children (Claude subscription, ChatGPT subscription, API key, or local endpoint), with no separate coordinator credential.

## Recommendation

Build the event-driven coordinator without pi-durable. It implements the existing `AttemptRuntime` port and keeps the attempt journal in usine tables, behind an `AttemptJournal` port with an in-memory adapter, a SQLite adapter in the runtime database, and a contract suite; Postgres follows with the other ports. The Pi parent stays on pi-durable beside it, and pi-durable leaves with the Pi parent. Each lifecycle event wakes one handler behind one seam: the handler receives the event and an attempt context rebuilt from the journal, and records one `Decision`. A handler is a rule, a direct API call to a small JSON model, or a short Claude Code session with decision tools. Rules handle every event in the first release, so the quickstart goal holds after issue 8 (configure `parent: none`), with the quickstart rewritten in issue 9. A model-handled event then takes one follow-up pull request per handler kind, with no redesign.

## Version 1 and version 2

| | Version 1 | Version 2 |
| --- | --- | --- |
| Coordinator store | New pi-durable tasks (`usine.coordinator`, `usine.delegation`) in `.usine/durable.sqlite` | `AttemptJournal` tables in the runtime database |
| Postgres | Not reachable, except by implementing pi-durable's 16-method `Storage` interface | Reachable through the same port pattern as the engine |
| Backup and restore | Two files, copied one after the other, not one snapshot (ADR 0010 amendments of 2026-10-08 and 2026-10-12) | One file for every `parent: none` attempt |
| Pull requests to the quickstart goal | 7 (critical path of 4) | 9 (critical path of 5: one of 1 to 4, then 5, 6, 8, 9) |
| Model at decision points | Deferred | Seam and context builder land with the coordinator; first model handler is one follow-up pull request |
| When the Pi parent is removed | pi-durable stays for the coordinator | pi-durable and `@earendil-works/chord` leave the dependency tree |
| Critical-path risk | Medium: new tasks over tested documents | Higher: a new journal adapter and a new outbox on the critical path, mitigated by the contract suite and the existing replay fixtures |

Version 2 costs two more pull requests, mainly the journal port and splitting the runtime in two. In return, the coordinator never has to be migrated off pi-durable, and the instance returns to one runtime file.

## 1. What pi-durable provides once there is no Pi conversation

Counted from `packages/durable/src` on `origin/main` (6,155 lines): 37 `tx.doc`, 30 `durable.use`, 16 `harness.commit`, 14 `api.commit`, and a few `watchDoc`, `waitForTask`, `abortTask`, `submissionByRequest`, and conversation calls.

| Capability used today | Used for | What provides it in version 2 |
| --- | --- | --- |
| Task store and checkpoints (`defineTask`, phases, `NextTaskState`) | The `usine.attempt` task, its `prepare` and `run` phases, and the terminal outcome | The coordinator's state row and the event ledger in `AttemptJournal`. The engine's run fiber is the driver: it already restarts each open run at startup and calls `StepExecutor.execute` with `reattach` (ADR 0003 amendment of 2026-10-11). |
| Documents in one transaction (`AttemptRecordDoc`, `HoldDoc`, `SubagentDoc`) | Children count, child blocker, budget, relay cursor, pending outbound envelopes, queued inputs, holds, pauses, each delegation's saved session, output, idle report, continuations, and in-flight tools | Journal tables, written through `SqlClient` transactions (table list below) |
| Document watches (`watchDoc` with `firstAccepted`) | Waiting for a hold to end, guidance to arrive, and the budget flag | An in-process `SubscriptionRef` per attempt in the hub, signalled after each commit. One orchestrator process owns the runtime database (ADR 0010), so an in-process signal is enough; a multi-process Postgres deployment would need a notification channel (out of scope). |
| Task ownership (`createTask`, `waitForTask`, `abortOwned`) | Version 1's delegation tasks | The delegation row and its intent, resumed by the coordinator's own fiber |
| Restart resume (`durable.resume`, `repairUnreadableConversations`, `abortEndedAttempts`) | Re-running unfinished tasks at layer build; repairing unreadable pi-durable conversations | `AttemptRuntime.execute` with `reattach`, called by the engine as today. Repair has no equivalent: it exists for pi-durable's own storage. |
| Idempotent submission (`requestId`, `submissionByRequest`) | Exactly one parent turn per guidance; queued operator input to the parent | Not needed without a parent conversation. Operator input to children is already acknowledged by ID (ADR 0005 amendment of 2026-11-06). |
| The `subagent` tool's replay path (`replay: "safe"`, `ToolExecutionApi`) | Resuming the saved child after a restart | The delegation core behind a `DelegationJournal` of domain operations (issue 1), with a journal adapter in version 2 and a pi-durable adapter for the Pi parent |
| Outbox for channel envelopes (`pendingOutbound`, `nextOutbound`) | Relaying to the sink exactly once in order across restarts | An outbox table in the journal. The engine keeps the first copy of a resent envelope by attempt, direction, and sequence (ADR 0010 amendment of 2026-10-08). |

Can pi-durable's storage meet the storage direction of 2026-11-03? Only partly. pi-durable 1.4.0 defines a pluggable `Storage` interface (`dist/types.d.ts:982`: 16 methods, including `mintId`, `findLatestHeadMarker`, and scans of conversations, entries, submissions, tasks, and documents) and ships `testing/storage-conformance`. Its adapters are memory, IndexedDB, JSONL, Node SQLite, and Cloudflare SQLite; there is no Postgres adapter. usine could write one against the conformance suite, but the schema, migrations, and semantics would be pi-durable's, not usine's dialect module, and pi-durable "controls its format, assumes one writer, and commits through its own connection" (ADR 0010 amendment of 2026-10-08). That doesn't meet "usine's own ports, dialect SQL in one module per adapter".

### Where the attempt journal lives

It goes in the runtime database, owned by the coordinator module, with its own migrations, as `@usine/config` does in `configuration/sqlite/migrations.ts`. The port is platform-free; adapters use `SqlClient` only, following the #637 reference and the engine's contract suites (`packages/engine/test/contracts/`).

| Table | Rows |
| --- | --- |
| `usine_attempt_coordination` | One per attempt: stored request, coordinator state, status (`open`, `terminal`, `settled`), terminal outcome, harvested result, unsupervised time, outbound and inbound sequences, and a revision for optimistic writes |
| `usine_attempt_events` | Append-only ledger: attempt, sequence, event, and the decision recorded for it |
| `usine_attempt_delegations` | One per child: number, session ID, assignment, saved session, prompted flag, idle report, continuation history, in-flight tools, retained output, outcome, and status (`intended`, `running`, `settled`) |
| `usine_attempt_supervision` | Holds and pauses per session |
| `usine_attempt_inputs` | Queued operator input per target session, with its delivery state |
| `usine_attempt_outbox` | Reserved channel envelopes not yet acknowledged by the sink |

## 2. Target design

### Seam

```text
engine run fiber ─▶ StepExecutor.execute ─▶ AttemptRuntime (router)
                                              ├─ parent: pi   ─▶ pi-durable runtime (unchanged)
                                              └─ parent: none ─▶ coordinator runtime
                                                                    │
            event ─▶ AttemptContext.build(journal) ─▶ WakeUp handler ─▶ Decision
                                                     (rule | small JSON model | harness session)
                                                                    │
                            clamp ─▶ apply ─▶ one transaction: event, decision, state, effect intents, outbox
                                                                    │
                                              effects after commit: delegate (launch or resume a child),
                                                                    flush outbox, finish
```

`AttemptRuntime` (`packages/durable/src/attempt-runtime.ts`) stays the seam to the executor; `packages/executor/src/durable-session.ts` doesn't change. A router implements it: `execute` dispatches on `RunSpec.parent`, and every other operation looks the attempt up in the journal first and falls back to the Pi runtime.

### Ports

```ts
// coordinator/journal.ts: platform-free.
export class AttemptJournal extends Context.Service<
  AttemptJournal,
  {
    readonly open: (request: StoredRequest) => Effect.Effect<CoordinatorSnapshot, JournalError>;
    readonly load: (attemptId: AttemptId) => Effect.Effect<Option.Option<CoordinatorSnapshot>, JournalError>;
    /** Appends the event, records its decision, and applies the transition in one transaction. */
    readonly transition: (
      attemptId: AttemptId,
      expected: JournalRevision,
      step: Transition,
    ) => Effect.Effect<CoordinatorSnapshot, JournalError | StaleRevision>;
    /** Records the first decision for an event; returns the recorded one if another came first. */
    readonly decide: (
      attemptId: AttemptId,
      event: EventSequence,
      decision: RecordedDecision,
    ) => Effect.Effect<RecordedDecision, JournalError>;
    readonly delegation: (attemptId: AttemptId, number: ChildSessionCount) => DelegationJournal["Service"];
    readonly supervise: (attemptId: AttemptId, change: SupervisionChange) => Effect.Effect<Supervision, JournalError>;
    readonly queueInput: (attemptId: AttemptId, input: QueuedInput) => Effect.Effect<void, JournalError>;
    readonly reserve: (attemptId: AttemptId, envelopes: ReadonlyArray<AttemptChannel.Outbound>) => Effect.Effect<void, JournalError>;
    readonly acknowledge: (attemptId: AttemptId, through: AttemptChannel.Sequence) => Effect.Effect<void, JournalError>;
    readonly settle: (attemptId: AttemptId) => Effect.Effect<void, JournalError>;
  }
>()("@usine/durable/coordinator/journal/AttemptJournal") {
  static readonly memory: Layer.Layer<AttemptJournal>;
}

// delegation/journal.ts: domain operations only, no storage types.
export class DelegationJournal extends Context.Service<
  DelegationJournal,
  {
    readonly admit: Effect.Effect<Admission, JournalError>; // count, replayed state, budget, superseded infra failure
    readonly restoredInputs: (session: AgentSessionId) => Effect.Effect<ReadonlyArray<QueuedInput>, JournalError>;
    readonly supervision: (session: AgentSessionId) => Effect.Effect<Supervision, JournalError>;
    readonly awaitRelease: (session: AgentSessionId) => Effect.Effect<void, JournalError>;
    readonly saveSession: (saved: SavedChild) => Effect.Effect<void, JournalError>;
    readonly markPrompted: Effect.Effect<void, JournalError>;
    readonly saveContinuations: (at: ReadonlyArray<number>) => Effect.Effect<void, JournalError>;
    readonly saveProgress: (progress: DelegationProgress) => Effect.Effect<void, JournalError>; // in-flight tools, idle report, output, usage
    readonly recordReport: (report: ChildReport) => Effect.Effect<boolean, JournalError>; // first report wins
    readonly recordInfraFailure: (session: AgentSessionId, message: string) => Effect.Effect<void, JournalError>;
    readonly clearRecoveredInfraFailure: (session: AgentSessionId) => Effect.Effect<boolean, JournalError>;
  }
>()("@usine/durable/delegation/journal/DelegationJournal") {}
```

The SQLite adapter puts its dialect SQL in one module (`coordinator/sqlite/`), as the engine does in `database/dialect.ts`; the Postgres adapter adds a sibling module. One contract suite runs against memory and SQLite in CI.

### The wake-up seam

```ts
// coordinator/wake-up.ts
export class WakeUp extends Context.Service<
  WakeUp,
  {
    /** Returns one decision for `event`, or `None` to apply the rule. Never fails the attempt. */
    readonly handle: (
      event: CoordinatorEvent,
      context: AttemptContext,
    ) => Effect.Effect<Option.Option<RecordedDecision>>;
  }
>()("@usine/durable/coordinator/wake-up/WakeUp") {
  /** Every event goes to its rule. */
  static readonly rules: Layer.Layer<WakeUp>;
}
```

A rule is a pure function, `ruleFor(event, context): Decision`. A model handler returns `None` on any failure, so the rule applies. The coordinator then runs `clamp(decision, context)` and `apply(state, decision)` from the rules module, whatever the handler kind.

### Does `rules.ts` from version 1 (#1155) survive?

Mostly. Its state, events, and outcome mapping carry over. Its single `next(state, event)` becomes three pure functions: `ruleFor` (the rule handler), `clamp` (budget, reserved markers that rules always honor, and the at-most-one replacement), and `apply` (state and effect intents). If #1155 has already merged as `next`, the split is a small change inside the coordinator issue.

### Lifecycle events

| Event | Source | Rule | Model-eligible |
| --- | --- | --- | --- |
| `AttemptStarted` | `execute` on a new attempt | `Delegate` with the rendered task | No |
| `ChildReported` with a reserved marker | Delegation outcome | `Fail` with the mapped failure, or `Question` | No; markers are typed facts |
| `ChildReported` without a marker | Delegation outcome | `Complete` with the report; the engine's `CompletionCheck` verifies outcome labels | Yes, the only one with evidence of value (version 1, answer 1) |
| `ChildInterrupted` (resume refused, no saved session, worker or checkout gone) | Delegation outcome after a restart | `RetryChild` once within budget, else `Fail` with `InfraFailure` | Later, if needed |
| `ChildAtCapacity` | `AgentCapacityError` | `Fail` with `ProviderCapacityFailure`; the engine waits and retries | No |
| `ChildFailed` (launch or transport) | `AgentSessionError` | `Fail` with `InfraFailure` | No |
| `BudgetExceeded` | Admission | `Fail` with `ChildSessionBudgetFailure` | No |

Some inputs are deliberately not coordinator events:

- **Restart.** The coordinator resumes its open intents from the journal; a resume that fails becomes `ChildInterrupted`.
- **Operator input.** Messages, steers, interrupts, and releases go to the live child through `intervene`, as interventions do today, never as events (ADR 0018). With no live child, the input is refused.
- **A provider limit on a decision call.** It makes that handler return `None`, so the rule applies.

### Atomic transitions

Each event is handled in four steps:

1. Build the context from the journal.
2. Call the handler.
3. Record the decision with `AttemptJournal.decide`, keyed by attempt and event sequence; the first decision wins.
4. In one transaction, run `transition`: append the event, store the decision, update the state, insert the effect intents (a delegation row with status `intended`, or the terminal outcome), and reserve the outbound envelopes.

Effects run only after the commit. On restart, `execute` loads the snapshot. If the event's decision is recorded but its transition isn't, the coordinator applies the recorded decision instead of calling the handler again. It then resumes `intended` and `running` delegations through the delegation core's replay path and flushes the outbox.

### Restart matrix

| Restart point | Expected | Test |
| --- | --- | --- |
| Before `open` commits | `execute` starts the attempt again; one delegation | Contract suite plus a coordinator unit test on SQLite |
| After a decision is recorded, before its transition | The recorded decision is applied; the handler isn't called again | Unit test with a counting handler |
| After the transition, before the child saves its session | `ChildInterrupted`; one replacement within budget | Unit test interrupting at `saveSession` |
| While the child works | Saved child resumes; same child ID and budget slot | Replay fixtures `restart` (Claude, Codex) through the coordinator runtime |
| After the child finished, before `ChildReported` commits | The delegation's settled outcome is read; no second child | Unit test interrupting after `recordReport` |
| Held or paused child | Supervision restored before any turn | `held-child-recovery` cases ported to the coordinator |
| Queued operator input | Delivered to the resumed child | `child-recovery-inputs` cases ported |
| Outbox pending | Flushed in order; the engine keeps the first copy | Unit test with a duplicating sink |
| Credential kind changed | The resumed child uses the current route | Replay fixture `credential-changed` |
| `parent` changed during the attempt | The attempt stays on the runtime it started with | Router unit test |
| During a model decision | The handler is called again unless a decision was recorded; one transition | Unit test with a scripted handler |

Compared with pi-durable today:

- **Stronger:** one database, so a backup is one snapshot for `parent: none` attempts; no class of unreadable conversations to repair; transitions and their intents commit together in usine's own schema.
- **Equal:** child resume, holds, inputs, and continuation, which are the same delegation code.
- **Weaker until proven:** pi-durable's commit and watch semantics have run in production for a month; the journal adapter and outbox are new critical-path code. The contract suite and the existing replay fixtures are the mitigation.

### What gets deleted when the Pi parent goes

`packages/durable/src` has 6,155 lines. With the Pi parent removed, these go: `harness.ts` (509), `attempt/task.ts` (541), `attempt/runtime.ts` (699, replaced by the coordinator runtime), `attempt/relay.ts` (812, replaced by the outbox), `attempt/subagent.ts` (807, whose policy has moved into the delegation core), `testing.ts` (578), `attempt/repair.ts` (248), `attempt/parent.ts` (236), `gateway.ts` (217), `attempt/documents.ts` (158), `attempt/events.ts` (145), `backup.ts` (120), `live.ts` (98), `http-dispatcher.ts` (97), `attempt/steering.ts` (83), `attempt/extension.ts` (42), and the small helpers. That is about 5,900 lines deleted against an estimated 2,500 to 3,000 lines of coordinator, journal, adapters, and delegation core. Dependencies leaving `packages/durable` are `@earendil-works/pi-durable`, `@earendil-works/chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-mcp`, `pi-telemetry`, and `pi-tui`. Pi children keep the `pi-*` packages in `packages/agents`, which has no pi-durable dependency (checked in `packages/agents/package.json`). `apps/server/src/backup.ts` drops its durable copy.

## 3. Migration

The coordinator is built beside the Pi parent with no shared state. The router sends new `parent: none` attempts to the coordinator and everything else to the Pi runtime, which keeps `.usine/durable.sqlite` until it is removed. They share code, not storage: the delegation core, the continuation policy, `ChildBackend`, and the hub's in-memory child map. The Pi runtime's `subagent` tool calls the delegation core through a pi-durable adapter of `DelegationJournal`.

Fastest order to "a Claude-subscription-only instance runs":

1. In parallel: the delegation core behind a domain journal (issue 1), the rules split (issue 2), the parent-optional channel (issue 3), and the journal port with its adapters (issue 4).
2. The coordinator runtime with rules-only wake-up and the context builder (issue 5).
3. Interventions (issue 6), with the restart replays (issue 7) in parallel.
4. Configuration (issue 8). The goal holds here: an instance with `parent: none` needs no Pi credential.
5. The quickstart rewrite (issue 9).

Pi as a child harness needs nothing from pi-durable. It runs `pi-coding-agent` sessions from `packages/agents`, which has no pi-durable dependency.

## 4. The decision step

### One contract, two transports

`Decision` is a Schema union. From it come the JSON Schema for the API model (`Schema.toJsonSchemaDocument`, `effect` 4.0.6 `Schema.d.ts:11630`) and the tool definitions for the harness session (`effect/ai` `Tool` and `Toolkit`, served with `McpServer.toolkit`; all three exist in `effect` 4.0.6 `dist/ai/`). Both transports decode into the same value, and `clamp` validates it.

```ts
export const Decision = Schema.Union([
  Schema.TaggedStruct("Complete", { message: Schema.optional(Schema.NonEmptyString) }), // default: the child's report
  Schema.TaggedStruct("RetryChild", { assignment: Schema.optional(Schema.NonEmptyString) }), // default: the continuation instruction
  Schema.TaggedStruct("Blocked", { message: Schema.optional(Schema.NonEmptyString) }),
  Schema.TaggedStruct("Question", { question: Schema.NonEmptyString }),
  Schema.TaggedStruct("Failed", { message: Schema.NonEmptyString }),
]);

export class RecordedDecision extends Schema.Class<RecordedDecision>("@usine/durable/RecordedDecision")({
  decision: Decision,
  handler: Schema.Literals(["rule", "endpoint", "harness"]),
  session: Schema.OptionFromNullOr(HandlerSession), // model, route, pool, usage
}) {}
```

Free-text fields are optional wherever a rule can supply them, so a model that only picks a label still produces a full decision.

### The context builder

`AttemptContext.build(journal, attemptId, event)` reads only the journal and the stored request. A small model gets no read tools, so this context must be enough on its own:

| Field | Source | Bound |
| --- | --- | --- |
| Event | The ledger row | Whole |
| Loop, agent name, repository, item kind and number | Stored `RunSpec` | Whole |
| Rendered task | `RunSpec.task` | First 4,000 characters |
| Expected outcome labels and CI policy | `RunSpec`; issue 5 adds `outcomeLabels`, which the engine has on `Submission` | Whole |
| Delegations so far | `usine_attempt_delegations`: number, status, outcome kind, and final report | The last two reports up to 4,000 characters each; earlier ones as one line |
| Last child output | Retained output of the current delegation | Last 2,000 characters |
| Budget | State and `maxChildren` | Whole |
| Supervision and pending input | Supervision and input tables | Counts and the newest message, up to 500 characters |

The total cap is 16,000 characters, about 4,000 tokens. Run `2c33c58d` gives typical sizes: a child prompt of 10,700 to 11,900 characters (mostly the rendered task), final reports of 112 and 3,413 characters, and a payload of 14,700 characters that the context leaves out because the task is already rendered from it. A typical context is 6,000 to 8,000 characters.

Without read tools, a small model can't check GitHub state (labels, pull request head, review), read files in the checkout, or see child tool calls. Those facts stay with rules and the engine's `CompletionCheck`.

### Handler kinds

**Rule.** Always available, and the fallback for every failure below.

**Small JSON model over an API.** No harness, no tools, no conversation. `effect` 4.0.6 ships `effect/ai` `DecisionModel` and `Decision` (`dist/ai/DecisionModel.d.ts`, `Decision.d.ts`). A definition pairs one JSON input schema with named `classify`, `rate`, or `probability` decisions, answered in one provider call. Answers are validated, and refusals and missing answers are typed (`decideSettled`). That matches the class the owner describes; I didn't assume a product. The handler classifies the event into a `Decision` tag with probabilities, applies a confidence threshold (below it the rule applies), and lets rules fill the text fields. For a model that writes text, the same handler can use `LanguageModel.generateObject` with the `Decision` schema. No `effect/ai` provider package is installed; the handler implements `DecisionModel.make({ decide })` over an OpenAI-compatible chat completions endpoint with `effect` `HttpClient`. Whether `@effect/ai-openai` exists for `effect` 4 is **unverified**.

- **Configuration:** an instance-level `decision_endpoint` with a base URL, a model, and the name of the environment variable that holds the key, or a key saved under Provider connections. A local endpoint may have no key.
- **Pool:** `apiKeys`, with the endpoint name recorded, as decision 4 of the harness-adapters study set for endpoints. A local model records no cost.
- **Admission:** configuration load checks only the shape. The endpoint is never required; an unreachable or refusing endpoint makes the handler return `None`.

**Harness session through the unmodified client.** This is the subscription route. For Claude Code it is the Agent SDK `query()`, which drives the same binary the children use, with these options:

| Option | Value |
| --- | --- |
| `tools` | `[]`, which disables every built-in tool (`sdk.d.ts:1680-1689`) |
| `mcpServers` | `{ usine: createSdkMcpServer(...) }`: the decision tools for this attempt and event, plus `attempt_context`, `child_report(number)`, and `child_output(number, characters)` |
| `allowedTools` | `mcp__usine__*` |
| `permissionMode` | `"dontAsk"` ("deny if not pre-approved", `:2028-2039`) |
| `strictMcpConfig` | `true` |
| `settingSources` | `[]` |
| `persistSession` | `false` |
| `maxTurns` | 4 |
| `outputFormat` | The `Decision` JSON Schema, used only as a fallback when no tool was called |

Constraints:

- **Replay-safe recording.** Each decision tool calls `AttemptJournal.decide`, and the runtime applies the decision.
- **One decision per wake-up.** A second decision tool call gets "already decided" as its result, and the handler interrupts the query after the first recorded decision. A session that ends with none returns `None`, so the rule applies.
- **The MCP server exposes only this attempt's tools**, because it is built per wake-up in the orchestrator process.
- **A 429 or any SDK error** returns `None`.

The `claude -p` form has the same shape with `--tools ""`, `--mcp-config` and `--strict-mcp-config`, `--allowedTools`, `--permission-mode dontAsk`, `--no-session-persistence`, `--output-format json`, and `--json-schema` (flags checked on Claude Code 2.1.322; the 2.1.311 pin is **unverified**). The SDK is preferred because it serves the tools in process.

For Codex, `codex exec` has `--output-schema` and `--ephemeral` (checked on CLI 0.153.4), and the app-server has `turn/start.outputSchema` and `thread/start.ephemeral` (0.164.0 schema). Turning off Codex's shell and edit tools for one turn is **unverified**, and the tools need an MCP server that Codex can reach. So the Codex handler starts with structured output only, and gains tools once #879's `/api/mcp` can be reached from the worker with an attempt-scoped token. Pi's in-process `pi-ai` call can take the API-model path.

### Placement: the attempt's worker, with the child's route

The decision session runs where the child runs, through the Claude adapter's existing spawner, with the attempt's environment and credential route. The decision tools stay in the orchestrator: SDK MCP servers answer `tools/call` as `mcp_message` control frames over the CLI's stdio (`sdk.d.ts:4695`), so they work over the SSH spawner the adapter already uses.

Reasons:

- It needs no coordinator credential, which is the goal.
- It uses the child's admitted route and pool, so terms and accounting are the children's.
- It needs no network path from the worker to the orchestrator.
- It runs in the attempt container.

The alternative, the orchestrator host behind the gateway with its own caller scope, needs a new gateway scope and, without a gateway, a Claude login on the orchestrator host. It belongs to the supervisor (#799, decision 10 of the harness-adapters study) and can be shared later.

### Relation to #879

#879 serves the operator API as MCP tools with permission filtering, using `effect/ai` `McpServer`. The decision tools reuse the same machinery but not the operator toolkit: a decision session must not hold operator powers such as approve, cancel, or edit. Claude doesn't depend on #879. Codex tools and GitHub read tools do.

### Does the version 1 finding still hold?

Yes. No event observed in the run history needs a model in the first release. The one model-eligible point with evidence, a report without a marker, is better fixed in the Claude adapter (#1147) for the 429 case. The seam lands with the coordinator, so routing that event to a model later is a configuration change plus one handler pull request.

## 5. Fate of the filed issues

| Issue | Fate |
| --- | --- |
| #1154 delegation core | **Reword.** `DelegationJournal` must expose domain operations, not pi-durable's `Tx` or `DocDefinition`. If the in-progress branch already exposes them, change the interface before merge. |
| #1155 rules | **Survives with a small change**: split `next` into `ruleFor`, `clamp`, and `apply`, and add `Decision`. If it merges as `next`, issue 5 does the split. |
| #1156 relay without a parent session | **Survives for core and web.** The `relay.ts` change isn't needed by version 2, because the Pi parent always has a model; it is harmless if already done. |
| #1157 run attempts without a parent | **Replaced** by issues 4, 5, and 6 below. |
| #1158 configure `parent: none` | **Survives**, with blocked-by changed to issue 6. |
| #1159 replay restart scenarios | **Reword**: run against the coordinator runtime over the SQLite journal. |
| #1160 quickstart | **Survives**; blocked by #1158. |

## 6. Implementation issues, in order

Parallel groups share no files: **{1, 2, 3, 4}**, then 5, then **{6, 7, 10, 11}**, then 8, then 9. Issue 12 is the Pi removal. Each issue amends the ADRs and docs that its behavior change touches.

### 1. Extract the delegation core behind a domain journal (rewords #1154)

**Context.** The `subagent` tool holds the delegation policy: budget accounting, saved-session resume, restored supervision and input, event forwarding, and report mapping. The event-driven coordinator needs the same policy over usine's own tables, and the Pi parent keeps it over pi-durable.

**Scope.** Move the policy into `attempt/delegation/delegation.ts` and return a `DelegationOutcome` (`Reported`, `Reserved`, `Interrupted`, `BudgetExceeded`). Define `DelegationJournal` as a `Context.Service` of domain operations: `admit`, `restoredInputs`, `supervision`, `awaitRelease`, `saveSession`, `markPrompted`, `saveContinuations`, `saveProgress`, `recordReport`, `recordInfraFailure`, and `clearRecoveredInfraFailure`. No pi-durable type appears in its interface. The `subagent` tool provides a pi-durable adapter. No behavior change.

**Acceptance criteria.**
- The existing durable suite passes unchanged, including the replay tests.
- An in-memory `DelegationJournal` drives unit tests for every `DelegationOutcome`.
- `delegation/` imports nothing from `@earendil-works/*`.

**Files.** `packages/durable/src/attempt/subagent.ts`, new `attempt/delegation/{delegation,journal}.ts`, `attempt/child.ts`, tests.

**Blocked by.** None.

### 2. Coordinator rules and the `Decision` contract (rewords #1155)

**Context.** Version 2 handles each event with a rule or a model behind one seam, and validates both the same way.

**Scope.** In `packages/durable/src/attempt/coordinator/rules.ts`, define `CoordinatorState`, `CoordinatorEvent`, `Decision`, `ruleFor`, `clamp`, and `apply`, all pure. `apply` returns the next state and the effect intents (`Delegate`, `Finish`).

**Acceptance criteria.**
- Unit tests cover each row of the lifecycle-events table.
- `clamp` turns `RetryChild` past the budget into `Failed`, keeps a reserved marker over any decision, and allows at most one replacement per interruption.
- `Schema.toJsonSchemaDocument(Decision)` produces a schema with one branch per tag, checked by a snapshot test.
- No IO; no pi-durable or harness runtime import.

**Files.** New `attempt/coordinator/rules.ts`, `packages/durable/test/coordinator-rules.test.ts`.

**Blocked by.** None.

### 3. Make the parent model optional in the channel (narrows #1156)

**Scope.** Make `Started.parentModel` optional with a decoding default, and show "No parent session" on the run page. Regenerate the operator API schema. The `relay.ts` change is optional.

**Acceptance criteria.** Stored transcripts decode unchanged; the web transcript tests pass with and without a parent model.

**Files.** `packages/core/src/attempt/channel.ts`, `apps/web/src/components/runs/transcript/attempt-meta.tsx`, `apps/web/src/lib/runs/transcript/{model,document/model}.ts`, `apps/docs/public/openapi.json`.

**Blocked by.** None.

### 4. Add the attempt journal port with memory and SQLite adapters

**Context.** The event-driven coordinator keeps its journal in usine tables, so pi-durable can leave with the Pi parent and a Postgres adapter can follow the engine's.

**Scope.** Add `AttemptJournal` as a `Context.Service` in `packages/durable/src/coordinator/journal.ts`, with `memory` and SQLite adapters. The SQLite adapter puts its dialect SQL in one module, `coordinator/sqlite/`, and its migrations live in the runtime database under their own migration table. Add a contract suite run against both adapters. Add `DelegationJournal` adapters over the journal.

**Acceptance criteria.**
- The contract suite covers: `open` is idempotent; `transition` applies the event, decision, state, intents, and outbox in one transaction or not at all; a stale revision fails; `decide` keeps the first decision; outbox order and acknowledgement survive reopen; settle.
- An injected write failure leaves no partial transition.
- No `@earendil-works/*` import.

**Files.** New `packages/durable/src/coordinator/{journal,memory}.ts`, `coordinator/sqlite/{schema,migrations,store}.ts`, `packages/durable/test/contracts/`, `packages/durable/package.json` (`@effect/sql-sqlite-node`).

**Blocked by.** None.

### 5. Run attempts with the event-driven coordinator (replaces #1157, part 1)

**Context.** Issues 1, 2, and 4 give the policy, the decisions, and the store. This issue runs an attempt from them, with the wake-up seam in place.

**Scope.**
- Add the coordinator runtime implementing `AttemptRuntime` in `coordinator/runtime.ts`: `execute`, `isLive`, `finished`, `recordResult`, `recordUnsupervised`, `unsupervised`, `request`, `attached`, `cancel`, `settle`, and `notify`. `intervene` refuses all input until issue 6.
- Add `WakeUp` with its `rules` layer, and `AttemptContext.build` with the bounds in the design.
- Add the router `AttemptRuntime` that dispatches on `RunSpec.parent` and on journal lookup.
- Add `parent: "pi" | "none"` (decoding as `pi`) and `outcomeLabels` to `RunSpec`.
- Add the outbox relay, which emits `Started` without a parent session.
- Amend ADRs 0003, 0005, and 0010.

**Acceptance criteria.**
- With `parent: none` and a scripted child, an attempt completes, fails with each reserved kind, fails with `ProviderCapacityFailure` and `InfraFailure`, and replaces an interrupted child once.
- Every unit-test row of the restart matrix passes on SQLite.
- `AttemptContext.build` stays within 16,000 characters for a context built from the `2c33c58d` sizes.
- `parent: pi` attempts behave as before, and the executor is unchanged.

**Files.** New `packages/durable/src/coordinator/{runtime,wake-up,context,router,outbox}.ts`, `packages/durable/src/live.ts`, `packages/core/src/attempt/channel.ts`, `packages/engine/src/engine/submission.ts`, `docs/adr/0003-*.md`, `0005-*.md`, `0010-*.md`, tests.

**Blocked by.** 1, 2, 3, 4.

### 6. Operator input to the event-driven coordinator (replaces #1157, part 2)

**Scope.**
- Route parent-addressed steers, operator messages, interrupts, and releases to the live child.
- Persist supervision and queued input in the journal, and refuse input when no child is live.
- Add `answeredOperator` to the child's result from the shared conversation, for ADR 0018's rule.
- Apply the runaway guard's warning steer the same way. Amend ADR 0018.

**Acceptance criteria.**
- Each action is applied or rejected with the existing transcript envelopes.
- Holds and pauses survive a restart.
- An answer to the operator with no commit, pull request, comment, or output fails the attempt.

**Files.** `coordinator/runtime.ts`, `attempt/hubs.ts`, `packages/agents/src/harness/conversation.ts`, `packages/agents/src/runtime.ts`, `docs/adr/0018-*.md`, tests.

**Blocked by.** 5.

### 7. Replay restart scenarios through the coordinator (rewords #1159)

**Scope.** Run the recorded `restart` and `credential-changed` scenarios for Claude and Codex through the coordinator runtime over the SQLite journal, with no scripted parent.

**Acceptance criteria.** Both scenarios pass in CI: one interrupted native tool call closed, two `SessionStarted` for the same child ID, one terminal outcome. The `parent: pi` replays still pass.

**Files.** `packages/durable/test/replay.ts`, `packages/durable/test/support.ts`.

**Blocked by.** 5.

### 8. Configure `parent: none` (#1158, unchanged except blocked-by)

**Blocked by.** 6.

### 9. Run the quickstart on whichever single login or key the person has (#1160, broadened)

**Scope.** As #1160. Also cover the API-key and local-endpoint paths in one prerequisites paragraph: the children's harness credential is the only one needed.

**Blocked by.** 8. Closes #1149.

### 10. Handle a report without a marker with a Claude Code decision session

**Context.** The wake-up seam from issue 5 sends every event to a rule. This adds the subscription-route handler.

**Scope.**
- Add a harness handler for Claude Code: the Agent SDK `query()` on the attempt's worker with the child's route and the options in the design.
- Add an in-process SDK MCP server per wake-up with the decision tools and three read tools.
- Handle `ChildReported` without a marker when `decision_model` is set for the agent (a model of the agent's harness; unset means rules).
- Record usage under the child route's pool.
- Add **Decision call** to CONTEXT.md.

**Acceptance criteria.**
- A replay fixture records one decision tool call, and the runtime applies it.
- A second decision call is refused.
- A session with no decision, a 429, a timeout, or an SDK error falls back to the rule.
- A restart after the decision is recorded applies it without a second session.
- The MCP server lists only this attempt's tools.

**Files.** New `coordinator/handlers/claude.ts`, `packages/agents/src/harness/claude/{sdk,claude}.ts`, `packages/agents/test/replay/`, configuration and docs.

**Blocked by.** 5.

### 11. Handle a report without a marker with a small JSON model over an API

**Scope.**
- Add an endpoint handler over `effect/ai` `DecisionModel`, with a provider implementation for OpenAI-compatible chat completions using structured output.
- Add the instance-level `decision_endpoint` (base URL, model, key variable or saved key), a confidence threshold, and rule-filled text fields.
- Record usage under `apiKeys` with the endpoint name.

**Acceptance criteria.**
- A refused, missing, invalid, or low-confidence answer falls back to the rule.
- A missing endpoint changes nothing.
- A test server returning a malformed body produces the rule's decision and a logged reason.

**Files.** New `coordinator/handlers/endpoint.ts`, configuration, settings docs.

**Blocked by.** 5. Can run in parallel with 10.

### 12. Remove the Pi parent

**Scope.** Delete the Pi runtime, the router's Pi branch, `parent_model`, `parent_effort`, the `coordinator` role, `durable-coordination`, the pi-durable adapter of `DelegationJournal`, and the durable backup. Remove `@earendil-works/pi-durable` and `@earendil-works/chord`. Amend ADRs 0005, 0010, and 0021.

**Blocked by.** 9 and the owner's decision on multi-child orchestration. Two pull requests: runtime, then configuration and docs.

## How each choice serves the goal

| Choice | Effect on "no separate coordinator credential" |
| --- | --- |
| Rules handle every event | No model call, so no credential beyond the children's |
| Harness handler on the attempt's worker with the child's route | A model-handled event uses the same login or key as the child |
| Endpoint handler | Opt-in; never required; absent means rules |
| `parent: none` written by new bootstrap files | A new instance never needs a Pi credential |

The goal holds after issue 8 for any configuration that sets `parent: none`, and for the documented quickstart after issue 9.

## Questions for the owner

1. **Default.** New bootstrap files write `parent: none`, and existing instances keep `pi` until the default flips. Recommended: yes, and flip the default after a month of dogfood on `none`.
2. **Removing pi-durable now versus later.** Recommended: now, as version 2 does. Building the coordinator on pi-durable first and moving it later costs about four more pull requests (a second store, a migration of in-flight attempts, and two sets of tests) and keeps the two-file backup in the meantime.
3. **Which events a model may handle.** Recommended: a code table of model-eligible events (`ChildReported` without a marker first), enabled per agent by setting `decision_model` or by an instance `decision_endpoint`. No per-event configuration until a second eligible event exists.
4. **Endpoint handler interface.** `DecisionModel` (labels with probabilities and a threshold; rules fill the text) or `LanguageModel.generateObject` (the full `Decision`, including text)? Recommended: `DecisionModel` first, because it suits very small models and keeps all text in rules.
5. **Codex decision sessions.** Structured output only until #879 provides an MCP endpoint that workers can reach. Recommended: yes.
6. **Multi-child orchestration.** Recommended: remove it with the Pi parent; multi-agent work stays in loop handoffs.
