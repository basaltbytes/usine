# Coordinating an attempt from lifecycle events, version 2

Second version of the design for [#1150](https://github.com/basaltbytes/usine/issues/1150) and [#1149](https://github.com/basaltbytes/usine/issues/1149). [Version 1](./attempt-coordination-from-events-v1.md) kept pi-durable as the coordinator's store. This version removes it from the coordinator, makes the wake-up seam a core part of the design, and admits three handler kinds behind that seam.

Read on 2026-11-11 against usine `origin/main` at `658c8c444ded5141ca71c76fe5e360f862d40a20`. Revised on 2026-11-12 against `origin/main` at `c222289b666831c7fb2f482b3372a5596fc0ac61`, where the code wins over this note. Pinned sources: `@earendil-works/pi-durable` 1.4.0, `effect` 4.0.6, and `@anthropic-ai/claude-agent-sdk` 0.3.311 (type declarations). Claims not checked against a pinned source are marked **unverified**.

The goal is a quickstart that requires no subscription from a specific model provider. A new instance must start and complete runs with whichever single harness login or key the person has for the children (Claude subscription, ChatGPT subscription, API key, or local endpoint), with no separate coordinator credential.

## Status

Built: the delegation core (#1179), the rules and the `Decision` contract (#1169), the relay without a parent session (#1171), the attempt journal with memory and SQLite adapters (#1181), the coordinator runtime and router with rules-only wake-up (#1197), the widened wake-up seam (#1244), the restart replays (#1245), operator input to the coordinator (#1163), and configuration as `coordinator: session | events`, with an optional agent `decision: { model, effort }` (#1158). The router sends an attempt to the coordinator when its `RunSpec.coordinator` is `events`.

Decided, not built: the quickstart (#1160); the decision session (#1164); the structured completion (#1165); removing the Pi parent (#1166); and the design-review follow-ups (#1237).

## Recommendation

Build the event-driven coordinator without pi-durable. It implements the existing `AttemptRuntime` port and keeps the attempt journal in usine tables, behind an `AttemptJournal` port with an in-memory adapter, a SQLite adapter in the runtime database, and a contract suite; Postgres follows with the other ports. The Pi parent stays on pi-durable beside it, and pi-durable leaves with the Pi parent (#1166). Each lifecycle event wakes one handler behind one seam: the handler receives the event and an attempt context rebuilt from the journal, and returns at most one `Decision`, which the coordinator records. A handler is a rule, a structured completion, or a short decision session on the child's harness; both model handlers go through the harness contract ([harness-contract-and-roles.md](./harness-contract-and-roles.md)). Rules handle every event in the first release, so the quickstart goal holds once configuration selects `coordinator: events` (#1158), with the quickstart rewritten in #1160. A model-handled event then takes one pull request per handler kind (#1164, #1165), with no redesign.

## Version 1 and version 2

| | Version 1 | Version 2 |
| --- | --- | --- |
| Coordinator store | New pi-durable tasks (`usine.coordinator`, `usine.delegation`) in `.usine/durable.sqlite` | `AttemptJournal` tables in the runtime database |
| Postgres | Not reachable, except by implementing pi-durable's 16-method `Storage` interface | Reachable through the same port pattern as the engine |
| Backup and restore | Two files, copied one after the other, not one snapshot | One file for every `coordinator: events` attempt |
| Pull requests to the quickstart goal | 7 (critical path of 4) | 9 (critical path of 5: one of #1154, #1155, #1156, #1162, then #1157, #1163, #1158, #1160) |
| Model at decision points | Deferred | Seam and context builder land with the coordinator; each model handler is one follow-up pull request |
| When the Pi parent is removed | pi-durable stays for the coordinator | pi-durable and `@earendil-works/chord` leave the dependency tree |
| Critical-path risk | Medium: new tasks over tested documents | Higher: a new journal adapter and a new outbox on the critical path, mitigated by the contract suite and the existing replay fixtures |

Version 2 costs two more pull requests, mainly the journal port and splitting the runtime in two. In return, the coordinator never has to be migrated off pi-durable, and the instance returns to one runtime file.

## 1. What pi-durable provides once there is no Pi conversation

Counted and quoted at `658c8c4`, before the coordinator landed. The ADR amendments cited by date were later folded into rewritten ADRs or deleted with them (#1214, #1225).

Counted from `packages/durable/src` (6,155 lines): 37 `tx.doc`, 30 `durable.use`, 16 `harness.commit`, 14 `api.commit`, and a few `watchDoc`, `waitForTask`, `abortTask`, `submissionByRequest`, and conversation calls.

| Capability used today | Used for | What provides it in version 2 |
| --- | --- | --- |
| Task store and checkpoints (`defineTask`, phases, `NextTaskState`) | The `usine.attempt` task, its `prepare` and `run` phases, and the terminal outcome | The coordinator's state row and the event ledger in `AttemptJournal`. The engine's run fiber is the driver: it already restarts each open run at startup and calls `StepExecutor.execute` with `reattach` (ADR 0003 amendment of 2026-10-11). |
| Documents in one transaction (`AttemptRecordDoc`, `HoldDoc`, `SubagentDoc`) | Children count, child blocker, budget, relay cursor, pending outbound envelopes, queued inputs, holds, pauses, each delegation's saved session, output, idle report, continuations, and in-flight tools | Journal tables, written through `SqlClient` transactions (table list below) |
| Document watches (`watchDoc` with `firstAccepted`) | Waiting for a hold to end, guidance to arrive, and the budget flag | An in-process `SubscriptionRef` per attempt in the hub, signalled after each commit. One orchestrator process owns the runtime database ([ADR 0010](../adr/0010-runtime-state-in-sqlite-or-postgres-behind-domain-ports.md)), so an in-process signal is enough; a multi-process Postgres deployment would need a notification channel (out of scope). |
| Task ownership (`createTask`, `waitForTask`, `abortOwned`) | Version 1's delegation tasks | The delegation row and its intent, resumed by the coordinator's own fiber |
| Restart resume (`durable.resume`, `repairUnreadableConversations`, `abortEndedAttempts`) | Re-running unfinished tasks at layer build; repairing unreadable pi-durable conversations | `AttemptRuntime.execute` with `reattach`, called by the engine as today. Repair has no equivalent: it exists for pi-durable's own storage. |
| Idempotent submission (`requestId`, `submissionByRequest`) | Exactly one parent turn per guidance; queued operator input to the parent | Not needed without a parent conversation. Operator input to children is already acknowledged by ID (ADR 0005 amendment of 2026-11-06). |
| The `subagent` tool's replay path (`replay: "safe"`, `ToolExecutionApi`) | Resuming the saved child after a restart | The delegation core behind a `DelegationJournal` of domain operations, with a journal adapter for the coordinator and a pi-durable adapter for the Pi parent |
| Outbox for channel envelopes (`pendingOutbound`, `nextOutbound`) | Relaying to the sink exactly once in order across restarts | An outbox table in the journal. The engine keeps the first copy of a resent envelope by attempt, direction, and sequence (ADR 0010 amendment of 2026-10-08). |

Can pi-durable's storage meet the storage direction of 2026-11-03? Only partly. pi-durable 1.4.0 defines a pluggable `Storage` interface (`dist/types.d.ts:982`: 16 methods, including `mintId`, `findLatestHeadMarker`, and scans of conversations, entries, submissions, tasks, and documents) and ships `testing/storage-conformance`. Its adapters are memory, IndexedDB, JSONL, Node SQLite, and Cloudflare SQLite; there is no Postgres adapter. usine could write one against the conformance suite, but the schema, migrations, and semantics would be pi-durable's, not usine's dialect module, and pi-durable "controls its format, assumes one writer, and commits through its own connection" (ADR 0010 amendment of 2026-10-08). That doesn't meet "usine's own ports, dialect SQL in one module per adapter".

### Where the attempt journal lives

It is in the runtime database, owned by the coordinator module, with its own migrations under the `usine_attempt_journal_migrations` ledger, as `@usine/config` does in `configuration/sqlite/migrations.ts`. The port is platform-free; the SQLite adapter uses `SqlClient`, following the #637 reference and the engine's contract suites (`packages/engine/test/contracts/`).

| Table | Rows |
| --- | --- |
| `usine_attempt_coordination` | One per attempt: stored request, revision for optimistic writes, coordinator state, status (`Open`, `Terminal` with its outcome, `Settled`), next outbound sequence, harvested result, and the runaway guard's unsupervised time |
| `usine_attempt_events` | The ledger: attempt, sequence, event, and the decision recorded for it. A row with a decision and no event holds a decision whose transition hasn't committed. |
| `usine_attempt_delegations` | One per child: number, assignment, progress (saved session, prompted flag, idle report, continuation times, in-flight tools, retained output), and the event that ended it. A row without progress is intended; with progress and no ending event, running. |
| `usine_attempt_outbox` | Reserved channel envelopes not yet acknowledged by the sink |

Holds, pauses, and queued operator input have no table until #1163 stores them; the coordinator refuses operator input until then.

## 2. Target design

### Seam

```text
engine run fiber ─▶ StepExecutor.execute ─▶ AttemptRuntime (router)
                                              ├─ coordinator: session ─▶ Pi parent on pi-durable (until #1166)
                                              └─ coordinator: events  ─▶ coordinator runtime
                                                                    │
                         child ends ─▶ settleDelegation: the event on the delegation row
                                                                    │
            event ─▶ buildAttemptContext(snapshot) ─▶ WakeUp handler ─▶ Option<RecordedDecision>
                                                     (rule | completion | session)
                                                                    │
            decide (first wins) ─▶ clamp ─▶ apply ─▶ transition: one transaction of
                                                     event, decision, state, intents, outbox
                                                                    │
                                              effects after commit: delegate (launch or resume a child),
                                                                    flush outbox, finish
```

`AttemptRuntime` (`packages/durable/src/attempt-runtime.ts`) stays the seam to the executor; `packages/executor/src/durable-session.ts` doesn't change. A router (`coordinator/router.ts`) implements it. `execute` keeps an attempt on the runtime that started it: the coordinator if the attempt journal has it, the Pi runtime if pi-durable has it, and otherwise the kind that `RunSpec` names. Every other operation looks the attempt up in the journal first and falls back to the Pi runtime. The `RunSpec` field is `coordinator: session | events`.

### Ports

`AttemptJournal` (`coordinator/journal.ts`) is a platform-free `Context.Service` with these operations:

- `open` (idempotent) and `load`.
- `decide`: records the first decision for an event sequence and returns the recorded one.
- `transition`: at an expected revision, appends the event with its decision, replaces the state, records the intents, and reserves the envelopes in one transaction. A stale revision fails with `StaleRevision`.
- `startDelegation`, `saveProgress`, and `settleDelegation`: a child's start, its progress, and the first event that ended it.
- `reserve` and `acknowledge` for the outbox; `recordResult` and `recordUnsupervised`.
- `settle`, and `settleOpen`, which settles only an `Open` attempt and returns the status it found.

The memory adapter (`coordinator/memory.ts`) and the SQLite adapter (`coordinator/sqlite/store.ts`) share the invariants in `coordinator/ledger.ts`, and one contract suite (`packages/durable/test/contracts/attempt-journal.ts`) runs against both. The SQLite adapter keeps its dialect SQL in `coordinator/sqlite/`, as the engine does in `database/dialect.ts`; a Postgres adapter adds a sibling module.

The delegation core (`attempt/delegation/delegation.ts`) takes a `DelegationJournal` (`attempt/delegation/journal.ts`) of domain operations with no storage types: `start` (admission, replayed progress, budget), `queuedInputs`, `supervision`, `holdEnded`, `releaseSupervision`, `saveSession`, `savePrompted`, `saveContinuations`, `saveUsage`, `toolStarted`, `toolFinished`, `saveIdle`, and `saveOutput`. It is a plain value bound to one attempt and child number: `journalDelegation` in `coordinator/delegation.ts` for the coordinator, and an adapter over pi-durable documents in `attempt/subagent.ts` for the Pi parent. It returns a `DelegationOutcome` (`Reported`, `Reserved`, `Interrupted`, `BudgetExceeded`).

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
      attempt: WakeUpAttempt, // attempt ID, event sequence, stored RunSpec, attached AttemptRequest
    ) => Effect.Effect<Option.Option<RecordedDecision>>;
  }
>()("@usine/durable/coordinator/wake-up/WakeUp") {
  /** Every event goes to its rule. */
  static readonly rules: Layer.Layer<WakeUp>;
}
```

A rule is a pure function, `ruleFor(event, context): Decision`, in `attempt/coordinator/rules.ts`. A model handler returns `None` on any failure, so the rule applies. The coordinator records the handler's decision with `decide`, then runs `clamp(decision, context)` and `apply(state, decision)` from the rules module, whatever the handler kind. The handler returns its decision instead of recording it through a tool, so recording and replay stay in one place for every handler kind. `WakeUpAttempt.request` gives a session handler the host, worker, environment, and gateway credential of the attached `execute` call (#1236). A cancel interrupts the handler, so a handler must release what it opened in its finalizers.

### Lifecycle events

| Event | Source | Rule | Model-eligible |
| --- | --- | --- | --- |
| `AttemptStarted` | `execute` on a new attempt | `StartChild`: delegate the rendered task | No |
| `ChildReported` with a reserved marker (`blocked`, `question`, `failed`) | Delegation outcome | `Blocked`, `Question`, or `Failed` | No; markers are typed facts |
| `ChildReported` without a marker | Delegation outcome | `Complete` with the report; the engine's `CompletionCheck` verifies outcome labels | Yes, the only one with evidence of value (version 1, answer 1) |
| `ChildInterrupted` (resume refused, no saved session, worker or checkout gone) | Delegation outcome after a restart | `RetryChild` within budget, else `InfraFailed` | No: an interrupted child has no report to complete with (#1236) |
| `ChildAtCapacity` | `AgentCapacityError` | `AtCapacity`, which fails with `ProviderCapacityFailure`; the engine waits and retries | No |
| `ChildFailed` (launch or transport) | `AgentSessionError` | `InfraFailed`, which fails with `InfraFailure` | No |
| `BudgetExceeded` | Admission | `OverBudget`, which fails with `ChildSessionBudgetFailure`. The coordinator numbers each delegation within the budget, so this can't occur on its path (#1237). | No |

Some inputs are deliberately not coordinator events:

- **Restart.** The coordinator resumes its latest delegation from the journal; a resume that fails becomes `ChildInterrupted`.
- **Operator input.** Messages, steers, interrupts, and releases go to the live child through `intervene`, as interventions do today, never as events ([ADR 0018](../adr/0018-takeover-and-edit-and-retry.md)). With no live child, the input is refused. Until #1163, the coordinator refuses all operator input.
- **A provider limit on a decision call.** It makes that handler return `None`, so the rule applies.

### Atomic transitions

Each event is handled in five steps:

1. When a child ends, record its event on the delegation row with `settleDelegation`; the first one wins. A restart then handles the recorded event instead of running another child.
2. Build the context from the journal snapshot.
3. Call the handler, unless the snapshot holds a decision recorded for this event before a restart.
4. Record the decision with `AttemptJournal.decide`, keyed by attempt and event sequence; the first decision wins.
5. Run `clamp` and `apply`, then commit `transition` in one transaction: append the event, store the decision, replace the state, insert the intents (`Delegate` with a numbered delegation, or `Finish` with the terminal outcome), and reserve the outbound envelopes.

Effects run only after the commit. On restart, `execute` loads the snapshot, applies a recorded decision without calling the handler again, resumes the latest delegation through the delegation core's replay path, and flushes the outbox.

A cancel settles an open journal before the children stop, so a process stop during the cancel can't resume the attempt. A handler running at that moment is interrupted, and no transition commits after the settle.

### Restart matrix

Tests are in `packages/durable/test/` unless the row names an issue.

| Restart point | Expected | Test |
| --- | --- | --- |
| Before `open` commits | `execute` starts the attempt again; one delegation | Contract suite: `open` keeps the first request |
| After a decision is recorded, before its transition | The recorded decision is applied; the handler isn't called again | `coordinator-runtime.test.ts`, with a counting handler |
| After the transition, before the child saves its session | `ChildInterrupted`; one replacement within budget | `coordinator-runtime.test.ts` on SQLite |
| While the child works | Saved child resumes; same child ID and budget slot | `coordinator-runtime.test.ts`; replay fixtures `restart` (Claude, Codex) through the coordinator |
| After the child ended, before its transition commits | The event recorded on the delegation is handled; no second child | `coordinator-runtime.test.ts` on SQLite |
| Held or paused child | Supervision restored before any turn | `held-child-recovery` cases, ported in #1163 |
| Queued operator input | Delivered to the resumed child | `child-recovery-inputs` cases, ported in #1163 |
| Outbox pending | Flushed in order; the engine keeps the first copy | `coordinator-runtime.test.ts`: a reserved terminal envelope is delivered again |
| Credential kind changed | The resumed child uses the current route | Replay fixture `credential-changed` |
| Coordinator kind changed during the attempt | The attempt stays on the runtime it started with | `coordinator-router.test.ts` |
| During a model decision | The handler is called again unless a decision was recorded; one transition | `coordinator-runtime.test.ts`, with a scripted handler |
| During a cancel, after the journal is settled | The attempt doesn't resume | `coordinator-runtime.test.ts` on SQLite |

Compared with pi-durable today:

- **Stronger:** one database, so a backup is one snapshot for `coordinator: events` attempts; no class of unreadable conversations to repair; transitions and their intents commit together in usine's own schema.
- **Equal:** child resume and continuation, which are the same delegation code. Holds and inputs join them with #1163.
- **Weaker until proven:** pi-durable's commit and watch semantics have run in production for a month; the journal adapter and outbox are new critical-path code. The contract suite and the replay fixtures are the mitigation. #1237 lists the design review's open findings, including decode failures of stored rows after an upgrade and the write cost per child event.

### What gets deleted when the Pi parent goes

At `c222289`, `packages/durable/src` has 10,279 lines. With the Pi parent removed, these go: `attempt/relay.ts` (844), `attempt/runtime.ts` (700), `attempt/task.ts` (559), `harness.ts` (509), `attempt/subagent.ts` (438, whose policy moved into the delegation core), `attempt/repair.ts` (248), `attempt/parent.ts` (228), `gateway.ts` (217), `attempt/documents.ts` (171), `attempt/events.ts` (145), `backup.ts` (120), `http-dispatcher.ts` (97), `attempt/steering.ts` (83), `attempt/extension.ts` (42), and the small helpers, about 4,400 lines; `live.ts` and `testing.ts` lose their Pi parts. The coordinator, journal, adapters, rules, and delegation core that replace them are 4,393 lines. Dependencies leaving `packages/durable` are `@earendil-works/pi-durable`, `@earendil-works/chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-mcp`, `pi-telemetry`, and `pi-tui`. Pi children keep the `pi-*` packages in `packages/agents`, which has no pi-durable dependency (checked in `packages/agents/package.json`). `apps/server/src/backup.ts` drops its durable copy.

## 3. Migration

The coordinator runs beside the Pi parent with no shared state. The router sends new `coordinator: events` attempts to the coordinator and everything else to the Pi runtime, which keeps `.usine/durable.sqlite` until #1166. They share code, not storage: the delegation core, the continuation policy, and `ChildBackend`. The Pi runtime's `subagent` tool calls the delegation core through a pi-durable adapter of `DelegationJournal`.

The remaining order is #1160, then #1166; [harness-contract-and-roles.md](./harness-contract-and-roles.md#where-the-coordinator-slices-and-799-plug-in) shows it with the harness steps that #1164 and #1165 wait for. Each issue carries its scope, acceptance criteria, and files.

Pi as a child harness needs nothing from pi-durable. It runs `pi-coding-agent` sessions from `packages/agents`, which has no pi-durable dependency.

## 4. The decision step

### One contract, two transports

`ModelDecision` is the Schema union that a model handler answers with; `Decision` adds the tags only a rule makes. The structured completion asks `complete` for one `ModelDecision` value; the decision session offers one decision tool per tag. Both decode into the same value, and `clamp` checks it. A snapshot test checks that the JSON Schema of `ModelDecision` has one branch per tag.

```ts
// attempt/coordinator/rules.ts
export const ModelDecision = Schema.Union([
  Complete, // message?, default: the child's report
  RetryChild, // assignment?, default: the replacement instruction
  Blocked, // message?, default: the child's report
  Question, // question
  Failed, // message
  InfraFailed, // message
  AtCapacity, // message, resetsAt?
]);
export const Decision = Schema.Union([StartChild, ...ModelDecision.members, OverBudget]);

// coordinator/wake-up.ts
export class RecordedDecision extends Schema.Class<RecordedDecision>("@usine/durable/RecordedDecision")({
  decision: Decision,
  handler: Schema.Literals(["rule", "completion", "session"]),
  session: Schema.OptionFromOptionalKey(HandlerSession), // brain, route, pool, usage; only for a model
}) {}
```

Free-text fields are optional wherever the event supplies them, so a model that only picks a tag still produces a full decision.

### The context builder

`buildAttemptContext(snapshot, event)` (`coordinator/context.ts`) reads only the journal snapshot, which holds the stored request. A small model gets no read tools, so this context must be enough on its own:

| Field | Source | Bound |
| --- | --- | --- |
| Event | The event being handled | Whole |
| Agent name and repository | Stored `RunSpec` | Whole |
| Rendered task | `RunSpec.task` | First 4,000 characters |
| Expected outcome labels and CI policy | `RunSpec.outcomeLabels` and `requiresCi` | Whole |
| Delegations so far | Delegation rows: number, status, how each ended, and its report or reason | The last two reports up to 4,000 characters each, counting the event's own report; earlier ones as one line |
| Last child output | Retained output of the latest delegation | Last 2,000 characters |
| Budget | `maxChildren` | Whole |

The total cap is 16,000 characters, about 4,000 tokens. Run `2c33c58d` gives typical sizes: a child prompt of 10,700 to 11,900 characters (mostly the rendered task), final reports of 112 and 3,413 characters, and a payload of 14,700 characters that the context leaves out because the task is already rendered from it. A typical context is 6,000 to 8,000 characters. Supervision and pending input have no field until #1163 stores them.

Without read tools, a small model can't check GitHub state (labels, pull request head, review), read files in the checkout, or see child tool calls. Those facts stay with rules and the engine's `CompletionCheck`.

### Handler kinds

**Rule.** Always available, and the fallback for every failure below.

**Structured completion (#1165).** No tools and no saved conversation. The handler builds a prompt from the attempt context, calls `complete` on the harness contract (#1208) with the agent's `decision` brain, and asks for one `ModelDecision` value. An OpenAI-compatible endpoint is a Pi credential route behind the same admission, pools, and usage events, so the handler has no configuration of its own. A refusal, an invalid value, capacity, or any other error returns `None`, so the rule applies.

**Decision session on the child's harness (#1164).** A short session on the attempt's worker, with the child's harness and route and the agent's `decision` model. It is a role against the harness contract: a closed tool set with this event's decision tools and three read tools (`attempt_context`, `child_report(number)`, and `child_output(number, characters)`), the harness's own tools off, no saved conversation, and at most 4 turns. [harness-contract-and-roles.md](./harness-contract-and-roles.md) gives the role shape (section 5) and each harness's tool delivery (section 6). A harness that can't close its tool set refuses the role with a reason, and the rule applies.

Constraints on the decision session:

- **The runtime records the decision.** The handler returns the first decision tool call as a `RecordedDecision` with its `HandlerSession`, and the runtime records it with `decide`.
- **One decision per wake-up.** A second decision tool call gets "already decided" as its result, and the handler interrupts the session after the first. A session that ends with none returns `None`.
- **The tool set holds only this attempt's tools**, because the handlers are built per wake-up in the orchestrator process.
- **A 429, a timeout, or any harness error** returns `None`.

On Claude Code, the adapter is the Agent SDK `query()`, which drives the same binary the children use, with these options:

| Option | Value |
| --- | --- |
| `tools` | `[]`, which disables every built-in tool (`sdk.d.ts:1680-1689`) |
| `mcpServers` | `{ usine: createSdkMcpServer(...) }`: the decision tools and read tools for this attempt and event |
| `allowedTools` | `mcp__usine__*` |
| `permissionMode` | `"dontAsk"` ("deny if not pre-approved", `:2028-2039`) |
| `strictMcpConfig` | `true` |
| `settingSources` | `[]` |
| `persistSession` | `false` |
| `maxTurns` | 4 |
| `outputFormat` | Unset; `complete` on Claude Code uses it with the `ModelDecision` JSON Schema (#1208) |

SDK MCP servers answer `tools/call` as `mcp_message` control frames over the CLI's stdio (`sdk.d.ts:4695`), so the tools work over the SSH spawner the adapter already uses. Pi serves the tool set as `customTools` (#1205). Codex delivery, and whether Codex can turn off its shell and edit tools for one thread, are **unverified**; until #1206 settles them, the Codex descriptor refuses the role with a reason.

### Placement: the attempt's worker, with the child's route

The decision session runs where the child runs, opened through the child's harness runtime with the attempt's environment and credential route, which `WakeUpAttempt.request` supplies. The decision tools stay in the orchestrator and reach the session in band, over the transport the adapter already owns.

Reasons:

- It needs no coordinator credential, which is the goal.
- It uses the child's admitted route and pool, so terms and accounting are the children's.
- It needs no network path from the worker to the orchestrator.
- It runs in the attempt container.

The alternative, the orchestrator host behind the gateway with its own caller scope, needs a new gateway scope and, without a gateway, a harness login on the orchestrator host. It belongs to the supervisor (#799, decision 10 of the harness-adapters study) and can be shared later.

### Relation to #879

#879 (merged as #1209) serves the operator API as MCP tools with permission filtering, using `effect/ai` `McpServer`. The decision tools reuse the same machinery but not the operator toolkit: a decision session must not hold operator powers such as approve, cancel, or edit. In-band delivery doesn't depend on #879. The session-scoped MCP endpoint (step 22 of the harness plan), the fallback for Codex and for Pi on workers, does.

### Does the version 1 finding still hold?

Yes. No event observed in the run history needs a model in the first release. The one model-eligible point with evidence, a report without a marker, had its 429 case fixed in the Claude adapter (#1147). The seam landed with the coordinator, so routing that event to a model is a configuration change plus one handler pull request.

## How each choice serves the goal

| Choice | Effect on "no separate coordinator credential" |
| --- | --- |
| Rules handle every event | No model call, so no credential beyond the children's |
| Decision session on the attempt's worker with the child's harness and route | A model-handled event uses the same login or key as the child |
| Structured completion through `complete` | Uses the agent's harness and route with its `decision` model; no `decision` means rules |
| `coordinator: events` written by new bootstrap files | A new instance never needs a Pi credential |

The goal holds for any configuration that sets `coordinator: events` (#1158), and for the documented quickstart after #1160.

## Owner decisions

Decided:

- **Removing pi-durable now.** As version 2 does; the journal and runtime are built (#1181, #1197).
- **Model path.** One way to call a model: the structured completion calls `complete` on the harness contract, with no `effect/ai` client or endpoint configuration of its own (2026-11-11, #1165).
- **Configuration.** `coordinator: session | events`, set on the instance and overridable per agent; an agent's optional `decision: { model, effort }` uses the agent's harness; `parent_model` and `parent_effort` go with #1166 (2026-11-11, #1158).
- **Which events a model may handle.** Only `ChildReported` without a marker, fixed in `rules.ts` (`modelEligible`, #1236), and only for an agent with a `decision` brain (#1158).
- **Codex decision sessions.** Codex joins once its tool sets land (#1206); until then its descriptor refuses the role.

Open:

1. **Default.** New bootstrap files write `coordinator: events` (#1160), and existing instances keep `session` until the default flips. Recommended: flip the default after a month of dogfood on `events`, with #1237 done first.
2. **Multi-child orchestration.** Recommended: remove it with the Pi parent; multi-agent work stays in loop handoffs.
