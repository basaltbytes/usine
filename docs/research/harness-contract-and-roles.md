# Harness contract and role seam

Design note for "an abstraction over harness and model combos that any role can use". Read on 2026-11-11 against usine `origin/main` at `0e8713dfd`, PR #1197 (`issue/1157-event-driven-coordinator`), PR #1153 (`docs/research/attempt-coordination-from-events.md`, version 2), and PR #1200 (`docs/provider-agnostic-principle`). Paths without a PR are on `origin/main`. Claims marked **inferred** were reasoned from code or docs, not read. Claims marked **unverified** could not be checked against a pinned source.

The principle, as PR #1200 states it in `AGENTS.md`: usine maintains three harnesses, Pi, Claude Code, and Codex, which together cover every provider and login. Every role is written against the harness and model seam in `@usine/agents`. A role works on all three harnesses, and a descriptor refuses a role with a reason only when its harness can't provide a capability.

This note continues the [harness adapter plan](./harness-adapters.md#migration-plan) and the [t3code study](./t3code-harness-encapsulation.md#recommendations). It doesn't repeat them.

## Summary

### Current gap

- The harness seam is shaped for one role. `HarnessRuntime` extends `ChildBackendService` and launches only a `ChildRequest` (`packages/agents/src/harness/runtime.ts:37-48`, `packages/agents/src/runtime.ts:88-150`), and a session is either a Pi `ParentSession` or a `ChildSession` (`packages/core/src/agent/session.ts:44-83`). A decision call, a structured completion, or an orchestrator agent has no way through it.
- Two primitives that new roles need don't exist on any harness: delivering a usine tool set to a session, and returning a structured result. Claude Code and Codex descriptors still declare `usine-tools` (`claude/descriptor.ts:65,87`, `codex/descriptor.ts:99,123`), but no code in `packages/agents/src` passes tools to either harness.
- Roles are a closed literal with role-name branches inside `admitBrain` (`admission.ts:6-14`, `:57-77`), so adding a role means editing admission.
- The Pi parent sits outside the registry and calls `pi-ai` directly with `Harness.make("pi")` in six places (`packages/durable/src/attempt/parent.ts:2,52,110,143,175,202,219`). Configuration and docs name it (`parent_model` "for the Pi parent", PR #1197's `ParentKind = ["pi", "none"]`), and two orchestrator-agent issues name a harness in their titles (#880, #884). Pi children run only on local workers (`pi/descriptor.ts:15-60`), so an operator with only a Pi route can't use SSH or container workers.
- The contract suite covers 9 replay scenarios for Claude Code and Codex (`packages/agents/test/fixtures/replay/*/{claude,codex}.json`) and none for Pi. No scenario checks a capability a descriptor declares.

### Target concepts

- **Harness contract**: one Effect service per harness with seven primitives: `describe`, `preflight`, `open` (new or resume, with an optional usine tool set), `send`, `interrupt`, `stop`, and `complete` (one structured result). Sessions emit the existing `AgentSessionEvent` stream.
- **Session spec**: the role-neutral input to `open` and `complete`. It says where the session runs, with which admitted route, whether the harness's own coding tools are on, whether the conversation is saved, and which output schema applies.
- **Requirements derived from the spec**: a role declares a session spec template. Admission computes the required capabilities from the template, so no table lists capabilities per role name.
- **Tool set**: one `effect/ai` `Toolkit` with handlers. Each adapter delivers it in band over its own transport: an SDK MCP server for Claude Code, client-served dynamic tools for Codex, and `customTools` for Pi. A session-scoped MCP endpoint (t3code recommendation 7) is the out-of-band fallback.
- **One contract suite**: shared scenarios, a replay fixture per harness, and a map from each capability to the scenarios that prove it. A descriptor can't declare a capability whose scenarios its adapter fails.

### Slices

Steps 16 to 23 continue the harness adapter plan. Steps 16 to 19 come before #1164. Steps 20 to 23 can wait.

| Step | Change | Before |
| --- | --- | --- |
| 16 | Session spec and a role-neutral runtime seam; `ChildRequest` becomes one builder | #1164 |
| 17 | Roles as declarations, requirements derived from the spec, new capabilities, truthful descriptors, capability-to-scenario map in the contract suite | #1164 |
| 18 | Tool sets on Claude Code and Pi (in-process) | #1164 |
| 19 | Tool sets on Codex: spike client-served dynamic tools, else MCP configuration | #1164 closes for Codex |
| 20 | `complete` on all three harnesses | #1165 |
| 21 | Pi sessions on workers as `pi --mode rpc` (t3code recommendation 6) | Pi-only operators on remote workers |
| 22 | Session-scoped MCP endpoint and idempotent delegation (t3code recommendation 7) | Pi tool sets on workers, laptop use |
| 23 | Orchestrator agent role through the contract (replaces plan step 10) | #799 turns (#880, #884) |

#1157, #1163, #1159, #1158, and #1160 need no harness change, with one rename before #1158 ships: the configuration value `parent: pi` names a harness.

### Owner decisions

1. **#1165 path.** Recommended: a structured completion through the harness contract (step 20), where an OpenAI-compatible endpoint is a Pi credential route. Default: that.
2. **Codex tool delivery.** Recommended: spike the app-server's client-served dynamic tools first and fall back to an MCP server in thread configuration. Default: spike first.
3. **Configuration keys for role brains.** Recommended: replace `parent_model` and `parent_effort` with a `decision` brain override on agents (harness inherited from the agent) and an instance `orchestrator` brain, and rename `parent: none`. Default: that.
4. **When Pi sessions move to workers.** Recommended: in parallel with #1164, before the orchestrator agent. Default: after #1164.

## 1. What the merged plan steps delivered

| Step | Issue, PR | What it delivered toward "any role on any harness" |
| --- | --- | --- |
| 1 | #950, #963 | One folder per harness under `packages/agents/src/harness/{claude,codex,pi}`. |
| 2 | #951, #968 | Descriptors as data in one catalog (`catalog.ts:7`), with worker requirements, credential wiring, prices, and handoff (`harness.ts:87-170`). The harness ID is an open, catalog-validated set (`packages/core/src/agent/brain.ts:10-15`, `harness.ts:189-195`). |
| 3 | #952, #972 | `HarnessRuntime` and the `Harnesses` registry, which fails startup on a descriptor without a runtime (`registry.ts:27-107`, `node.ts:18-40`). The runtime is child-only (`runtime.ts:37-48`). |
| 4 | #953, #979 | Capability profiles per placement and credential route, each capability supported or refused with a reason (`capability.ts:40-65`), and one pure `admitBrain` with a typed `BrainRefused` (`admission.ts:26-114`), called at child launch (`launch.ts:34-73`), preflight (`runtime.ts:54-91`), and parent start (`parent.ts:170-193`). Roles are a closed literal (`admission.ts:6`). |
| 5 | #954, #973 | The pool is recorded on each session at launch. Each adapter computes it (`claude/claude.ts:499-503`, `codex/account.ts:71,95`, `pi/pi.ts:146`). The legacy inference still switches on the harness for older records (`packages/core/src/agent/session.ts:266-279`). |
| 6 | #955, #974 | Worker image inputs generated from descriptors (`catalog.ts:10-20`). |
| 7 | #956, #966 | Claude plan rate windows as `PoolRateLimitsUpdated` (`claude/rate-limits.ts:44-82`). |
| 8 | #957, #988 | Credential wiring per route in descriptors (`harness.ts:28-85`), gateway slots by wire protocol. |
| 12 | #1005, #1014 | Replay tests at the transport boundary: 9 scenarios (`packages/agents/test/replay/scenarios.ts:25`), fixtures for Claude Code and Codex only. |
| 13 | #1006, #1023 | One process owner on the worker with a lease (`packages/agents/src/child-host/`). Pi children, which run in the orchestrator process, don't use it. |
| 14 | #1007, #1030 | One continuation policy above the adapters (`continuation.ts:107-183`) over a required native `open` primitive (`ChildAdapter`, `continuation.ts:191-198`) that all three adapters implement (`claude.ts:887`, `codex.ts:844`, `pi.ts:259`). |
| 15 | #1008, #1015 | Environments scoped to the launched harness (`harness.ts:198-219`, applied in `registry.ts:51-74`) and the credential route resolved at every launch (`launch.ts:12-32`). |

Open: step 9 (#958, OpenCode 2.x). Step 10 (supervisor through `Harnesses`) isn't built. Step 11 (journaled coordinator decorator) is superseded by #1150: the event-driven coordinator has no long-lived parent session to journal.

The plan's design moved data, admission, credentials, recovery, and process ownership behind neutral seams. What it didn't do, by its own scope, is widen the runtime seam beyond the child role. That is the remaining work.

## 2. Roles in code today

| Role | Code | Harness and model selection | Admission | Status |
| --- | --- | --- | --- | --- |
| Attempt agent (child) | Launched through `Harnesses` (`registry.ts:58-74`) from the delegation core (`packages/durable/src/attempt/delegation/delegation.ts:191,306`) | Agent frontmatter `harness`, `model`, `effort` (`packages/config/src/parser.ts:94-103`) | `coding-agent`, hard-coded at `launch.ts:47` and `runtime.ts:67` | Built on all three; Pi only on local workers |
| Coordinator, Pi parent | `packages/durable/src/attempt/parent.ts`, pi-durable | `parent_model` in Pi's `provider/model` form, else Pi's default, else the first Pi model with a credential (`parent.ts:96-150`) | `coordinator`, requires `durable-coordination` (`admission.ts:11`), which only Pi declares (`pi/descriptor.ts:20`) | Built; removed by #1166 |
| Coordinator, event-driven | PR #1197: `packages/durable/src/coordinator/{runtime,router,wake-up}.ts` | None: rules only (`WakeUp.rules` in PR #1197 `wake-up.ts`) | None needed | In PR #1197 |
| Decision call, harness session | #1164 | `decision_model`, "a model of the agent's harness" (#1164 body) | Not designed | Planned. #1164 scopes Pi and Claude Code; Codex is a follow-up |
| Decision call, structured completion | #1165 | `decision_endpoint`: base URL, model, key (#1165 body) | "Configuration load checks only the shape" (PR #1153 note, section 4) | Planned as a second model path through `effect/ai`, outside the harness seam |
| Orchestrator agent (supervisor) | #799, slices #879, #880, #881, #884, #885 | Owner decision of 2026-11-04 (#799 comments): on the orchestrator host, logins through the gateway | `supervisor`, requires `usine-tools` and `resume-session`, orchestrator placement, gateway credential (`admission.ts:13,57-77`) | Not built |

### Where a provider or harness name leaks

| Place | Leak |
| --- | --- |
| `packages/durable/src/attempt/parent.ts:2-10,52,110,143,175,202,219` | The parent imports `pi-ai` and Pi authentication helpers and builds `Harness.make("pi")` six times. It bypasses `Harnesses`. |
| `packages/core/src/agent/session.ts:44,53` | `ParentSession` is documented as "The Pi session" with "The Pi brain". |
| `packages/core/src/agent/session.ts:266-279` | Legacy `sessionPool` switches on `"claude"`, `"codex"`, `"pi"` and the `openai-codex/` model prefix. Acceptable as a decoding fallback for old records. |
| `packages/agents/src/harness/admission.ts:6,57-77` | Role names and their placement and credential rules are `if` branches in the admission function. |
| `packages/config/src/parser.ts:99-100`, `packages/config/src/factory.ts:702-703` | `parent_model` and `parent_effort`, whose values are Pi model IDs. |
| PR #1197, `packages/core/src/agent/agent.ts` (hunk at line 42) | `ParentKind = Schema.Literals(["pi", "none"])`, which #1158 makes the configuration key `parent: pi | none`. |
| `apps/docs/src/content/docs/reference/configuration/agents.md:20-21,39-44`, `settings.md:18-19` | "Model for the Pi parent", "Every attempt has a Pi parent". |
| `apps/docs/src/content/docs/get-started/quickstart.mdx:88`, `apps/docs/quickstart/usine.yaml:11`, `guides/configure-a-gateway.md:84` | The quickstart and gateway guide require an `openai-codex/` parent model, so a prerequisite names a provider. #1160 removes this. |
| `CONTEXT.md:210-212` | **Harness**: "The coding-agent CLI in an agent's brain spec". The definition ties a harness to the coding role. |
| `packages/core/src/agent/brain.ts:9,28` | `Harness` is "A coding-agent CLI ID". Same tie. |
| Issue titles #880 ("as resumed Claude Code sessions"), #884 ("on Codex") | A generic feature split by harness in the title. |
| #1164 scope | "A Codex adapter is out of scope here". Under the corrected principle, Codex is refused only if it can't provide a capability, and it can (section 5). |

Outside adapters and descriptors, no other production code under `packages/` or `apps/` branches on a harness name. Checked with a search for `harness === "…"`, `case "…":`, and `Harness.make("…")`; web fixtures and tests excluded.

## 3. What admission gets right and where it falls short

### Right

- **Capabilities per placement and credential route.** A descriptor states, for each pair, what it supports and why it lacks the rest, and the schema rejects a profile that leaves a capability unexplained (`capability.ts:56-64`) or two profiles for one pair (`harness.ts:138-150`). This is the shape the principle asks for.
- **One pure function with a typed refusal.** `admitBrain` does no IO and returns `BrainRefused` with every missing capability and its reason (`admission.ts:38-114`). It runs at configuration load, preflight, and every launch.
- **The route is resolved per launch from metadata only** (`launch.ts:12-32`), and the environment carries only the launched harness's variables (`harness.ts:198-219`).
- **Harness IDs are open.** The catalog validates membership; nothing exhaustively switches on IDs.

### Short of "any role on any harness"

1. **Roles are code paths, not declarations.** `Role` is a literal of three names (`admission.ts:6`). Placement rules are `role !== "coding-agent"` branches (`:57-68`), and the supervisor's gateway rule is a fourth branch (`:69-77`). A new role edits this function.
2. **The capability list describes long sessions only.** No capability says a harness can turn off its own tools, return a schema-checked result, or run without saving a conversation. The decision call needs all three.
3. **Declarations aren't tested.** `usine-tools` is declared by Claude Code and Codex with no implementation. `model-check` is declared by Codex and Pi; nothing in the contract suite checks that a declared capability works.
4. **The runtime seam takes a child request.** `ChildRequest` carries a `ChildSession` with a `parentId` (`session.ts:60-81`), a required prompt, and child restart state (`runtime.ts:88-150`). `ProbeTarget` uses a third credential vocabulary (`runtime.ts:25`: `host-login`, `gateway`, `api-key`, `sandbox-api-key`) next to `CredentialRoute` (`capability.ts:20-26`).
5. **`AdmittedBrain` doesn't carry the route's pool** (`admission.ts:21-24`). The plan intended it to (`harness-adapters.md:277`). Each adapter recomputes the pool. That works for children, but a decision call billed "under the child route's pool" (#1164) has to repeat the computation.
6. **Pi's profiles are narrower than Pi.** Pi declares only `orchestrator` and `local` placements and no `api-key` route (`pi/descriptor.ts:15-60`), because its sessions run in the orchestrator process. Pi itself reaches API keys, OpenAI-compatible endpoints, and several subscriptions (`harness-adapters.md:73-75`).

## 4. The harness contract

### Primitives and their status

"Neutral" means a harness-neutral seam exists on `main`. "Per adapter" means each adapter implements it behind no shared interface. "Missing" means no harness implements it.

| Primitive | What usine needs | Status on `main` |
| --- | --- | --- |
| `describe` | Capabilities per placement and credential route, worker requirements, wiring, prices, handoff | Neutral: `HarnessDescriptor` (`harness.ts:132-170`) |
| `preflight` | Check a brain at a target without a prompt | Neutral seam (`runtime.ts:44-47`), per-adapter checks, which is right. Admission inside it is hard-coded to `coding-agent` (`runtime.ts:67`) |
| `open` with a prompt | Start a session with instructions and a first message | Per adapter behind `ChildAdapter.open` (`continuation.ts:191-198`), child-shaped |
| `open` with a reference | Reopen a saved conversation without a prompt | Neutral: required primitive with one continuation policy (#1007, `continuation.ts:201-260`) |
| Session reference before the first prompt | So a crash before `init` can resume | Neutral rule (ADR 0005 amendment, #1007), per-adapter implementation |
| `send` | Queue or start a turn; acknowledge by message ID | Neutral seam: the `send` option of `sessionConversation` (`conversation.ts:38-42`); implemented in `claude.ts:542` and `codex.ts:494` |
| Steer, hold, pause, release | Operator interventions | Neutral, above the harness: `RunningSession.steer` and `intervene` (`runtime.ts:471-496`), `conversation.ts`. These are usine policy, not harness primitives |
| `interrupt` | Stop the turn, keep the session | Neutral: `RunningSession.interrupt` |
| `stop` | Stop a retained process without a turn | Neutral: `ChildBackendService.stop` (`runtime.ts:503-511`) |
| Tool set | Expose usine tools; optionally turn off the harness's own tools | Missing for Claude Code and Codex. Pi has only `customTools` for its bash environment (`pi/sdk.ts:142-152`); the Pi parent's `subagent` tool is a pi-durable extension |
| `complete` | One schema-checked result, no tools, no saved conversation | Missing |
| Normalized events | `AgentSessionEvent` | Neutral (`packages/core/src/agent/session.ts:117-360`); mapping per adapter codec, which is right |
| Usage | Tokens, USD, rate windows | Neutral events (`SessionTokensUpdated`, `PoolRateLimitsUpdated`); pricing in the descriptor (`harness.ts:157-169`). Pi reports no plan windows (`pi/descriptor.ts:31-33`) |
| Process ownership | One owner, lease, lifeline | Neutral for subprocess harnesses (#1006); Pi runs in process |
| Credential route and environment | Resolve per launch, scope variables | Neutral (#957, #1008) |

Eleven of the fifteen rows are neutral. The two missing ones are the ones new roles need, and `open` is neutral in policy but child-shaped in its input.

### Interface sketch

Names follow `@usine/agents` and `@usine/core/agent`. This is a sketch for review. It reuses `AgentSessionEvent`, `AgentSessionError` (`runtime.ts:355-369`), `HarnessSession`, `ChildHost`, and the continuation policy.

```ts
// packages/agents/src/harness/contract.ts: platform-free.

/** What a session runs and where; built by a role, never by an adapter. */
export class SessionSpec extends Schema.Class<SessionSpec, Brand.Brand<"…/SessionSpec">>(
  "@usine/agents/SessionSpec",
)({
  session: RoleSession, // id, role name, agent, brain, optional parent id
  admitted: AdmittedBrain, // brain, placement, credential route, pool
  host: ChildHost,
  worker: Schema.Option(WorkerName),
  machine: Schema.Option(MachineId),
  cwd: Schema.Option(WorkingDirectory),
  environment: Schema.Record(Schema.String, Schema.String),
  instructions: Schema.Option(Schema.NonEmptyString),
  /** Whether the harness's own read, edit, and shell tools are on. */
  nativeTools: Schema.Boolean,
  /** `ephemeral` saves no conversation and returns no reference. */
  persistence: Schema.Literals(["saved", "ephemeral"]),
  /** A cap on model turns for short sessions. */
  maxTurns: Schema.Option(PositiveInt),
}) {}

export type Start =
  | { readonly _tag: "Prompt"; readonly text: string }
  | { readonly _tag: "Resume"; readonly reference: HarnessSession };

/** An open native session. Policy such as holds and continuation sits above it. */
export interface NativeSession {
  /** Known before the first prompt when `persistence` is `saved`. */
  readonly reference: Option.Option<HarnessSession>;
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  readonly send: (
    message: string,
    id: OperatorMessageId,
  ) => Effect.Effect<MessageTaken, AgentSessionError>;
  readonly interrupt: Effect.Effect<void, AgentSessionError>;
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  /** Whether a reopened process was already in a turn. */
  readonly active: boolean;
}

export class Completion<A> /* value, usage, pool, model */ {}

export class CompletionInvalid extends Schema.TaggedError<CompletionInvalid>()(
  "CompletionInvalid",
  { session: AgentSessionId, message: Schema.NonEmptyString },
) {}
export class CompletionRefused extends Schema.TaggedError<CompletionRefused>()(
  "CompletionRefused",
  { session: AgentSessionId, message: Schema.NonEmptyString },
) {}
export type CompletionError =
  | CompletionInvalid
  | CompletionRefused
  | AgentCapacityError
  | SessionOperationError;

// packages/agents/src/harness/runtime.ts: Node only.

export interface HarnessRuntime {
  readonly id: Harness;
  readonly preflight: (
    admitted: AdmittedBrain,
    target: ProbeTarget,
  ) => Effect.Effect<HarnessReadiness, SessionOperationError>;
  /** The tool handlers come from the caller's context, so a role scopes them. */
  readonly open: <Tools extends Record<string, Tool.Any>>(
    spec: SessionSpec,
    start: Start,
    tools: Option.Option<Toolkit.Toolkit<Tools>>,
  ) => Effect.Effect<NativeSession, AgentSessionError, Scope.Scope | Tool.HandlersFor<Tools>>;
  readonly complete: <S extends Schema.Top>(
    spec: SessionSpec,
    prompt: string,
    output: S,
  ) => Effect.Effect<Completion<S["Type"]>, CompletionError>;
  readonly stop: (spec: SessionSpec) => Effect.Effect<void, AgentSessionError>;
}
```

`Harnesses` stays as it is (`registry.ts:27-33`), and its wrapper keeps applying environment scoping and admission before every call (`registry.ts:49-80`). `childContinuation` (`continuation.ts:201`) becomes a decorator over `open` for any spec with `persistence: "saved"`, and returns the `RunningSession` that roles with interventions use. `ChildRequest` becomes a builder that produces a `SessionSpec` plus child restart state (`inFlight`, `unread`, `held`, `paused`, `idle`, `continuations`), which belong to the continuation decorator, not to the harness.

`RoleSession` is a third `AgentSession` member with a role name and an optional parent ID. `ParentSession` and `ChildSession` stay decodable for stored transcripts.

`Tool` and `Toolkit` are `effect/ai` modules in the pinned `effect` 4.0.6 (`node_modules/.pnpm/effect@4.0.6/node_modules/effect/dist/ai/Toolkit.d.ts:337`, `McpServer.d.ts:380-388`). Using them means one schema per tool for every delivery path, and the same toolkit can be served by #879's `McpServer`.

### Contract suite

One suite in `packages/agents/test/contract/` runs every scenario against every adapter over replay fixtures, extending the step 12 recorder (`packages/agents/test/replay/`).

- **Existing scenarios**, kept: `simple`, `steer`, `queued-message`, `hold-release`, `interrupt-guidance`, `transport-loss`, `restart`, `credential-changed`, `early-exit`.
- **New scenarios**: `host-tool` (one usine tool called, its result read, the call shown as `ToolStarted` and `ToolFinished` with the usine tool name and no harness prefix); `closed-tools` (with `nativeTools: false`, the session lists only the given tools); `structured-result` (a valid value, and an invalid one that fails with `CompletionInvalid`); `ephemeral` (no reference, nothing written under the session directory); `max-turns`.
- **Capability map**: each `Capability` names the scenarios that prove it. For each descriptor profile, the suite runs the scenarios of every supported capability and expects the adapter to pass, and checks that admission refuses every lacking one with the descriptor's reason. A descriptor that declares `usine-tools` without a passing `host-tool` scenario fails CI.
- **Pi fixtures**: none exist. Pi runs in process today, so the recording boundary is the `pi-ai` provider stream; the `faux` provider already used in tests (`packages/orchestrator/test/current-instance.test.ts:311`) can carry recorded streams (**inferred**). After step 21, Pi records at the RPC stdio boundary like the other two.

## 5. Roles as declarations

### Requirements from the spec

A role is a value in the module that owns it, not a literal in `admission.ts`:

```ts
export class RoleSpec extends Schema.Class<RoleSpec>("@usine/agents/RoleSpec")({
  name: RoleName, // open, kebab-case
  /** The placements the role may run at, or the placement of another session it follows. */
  placement: Schema.Union([Schema.Array(Placement), FollowsSession]),
  credential: Schema.Array(CredentialRoute), // empty means any
  nativeTools: Schema.Boolean,
  hostTools: Schema.Boolean,
  persistence: Schema.Literals(["saved", "ephemeral"]),
  interventions: Schema.Boolean, // steer, interrupt, operator messages
  output: Schema.Literals(["text", "structured"]),
}) {}
```

`requirements(role)` derives the capabilities: `hostTools` needs `usine-tools`; `nativeTools: false` needs `closed-tools`; `output: "structured"` needs `structured-output`; `persistence: "ephemeral"` needs `ephemeral`; `persistence: "saved"` needs `resume-session`; `interventions` needs `steer` and `interrupt`. `token-usage` is always required. `admitBrain(catalog, role, brain, context)` keeps its signature and its `BrainRefused`, loses its role-name branches, and adds a refusal for a placement or route outside the role's lists with the role's reason. `durable-coordination` leaves with the Pi parent (#1166).

This keeps the capability list as the one vocabulary, which the descriptors already state, and adds no per-role table.

### Brain resolution

```text
role spec ──┐
brain       ├─▶ resolve route ──▶ admitBrain ──▶ AdmittedBrain ──▶ Harnesses.runtime(id)
context ────┘   (placement,        (descriptor     (brain, placement,    .open / .complete
                 environment,       profile ⊇      route, pool)
                 gateway slot)      requirements)
       refusals: BrainRefused (missing capabilities, placement, or route, with reasons)
                 UnknownHarnessError (no runtime)
                 HarnessUnavailableError (preflight: binary, version, login)
```

The route resolution is `childAdmissionContext` (`launch.ts:12-32`) generalized to any spec. The pool moves into `AdmittedBrain`, computed once from the route, which also gives the decision call its child-route pool without extra code.

### The four role shapes

| | (a) Attempt agent | (b) Decision session | (c) Structured completion | (d) Orchestrator agent |
| --- | --- | --- | --- | --- |
| Spec | `nativeTools`, `saved`, interventions, text | Closed tool set (decision tools and three read tools, PR #1153 section 4), `ephemeral`, `maxTurns` 4, text | No tools, `ephemeral`, structured | `hostTools` (usine operator tools), `saved`, interventions, text |
| Required | `resume-session`, `steer`, `interrupt`, `token-usage` | `usine-tools`, `closed-tools`, `ephemeral`, `token-usage` | `structured-output`, `ephemeral`, `token-usage` | `usine-tools`, `resume-session`, `steer`, `interrupt`, `token-usage` |
| Placement | The worker's | Follows the attempt agent: same placement and route | Follows the attempt agent, or orchestrator for an instance-level brain | `orchestrator` |
| Credential | Any route the descriptor offers | The attempt agent's route | The attempt agent's route, or the instance brain's route | `gateway-*` (owner decision 10 of 2026-11-04) |
| Brain | Agent `harness`, `model`, `effort` | Agent `harness`, `decision.model` and `decision.effort` | Same as (b), or an instance brain | Instance `orchestrator` brain |
| Primitive | `open` with continuation | `open`, read the first decision tool call, `interrupt` | `complete` | `open` with continuation |
| Pi | Local only until step 21 | In process, `customTools`, `tools: []` | One `streamSimple` request through Pi's model runtime with an output tool; see [step 20](#20-structured-completion) | In process on the orchestrator with a gateway route (`pi/descriptor.ts:16-18`) |
| Claude Code | Built | SDK `query()` with `tools: []`, an SDK MCP server, `permissionMode: "dontAsk"`, `persistSession: false` (PR #1153 section 4) | SDK `query()` with `tools: []` and `outputFormat` (PR #1153 section 4) | SDK with an SDK MCP server |
| Codex | Built | Client-served dynamic tools or MCP configuration (section 6); turning off shell and edit **unverified** | `thread/start` `ephemeral` and `turn/start` `outputSchema` (both in `packages/agents/src/protocol/codex/upstream-schema.json`, `definitions/v2/ThreadStartParams` and `TurnStartParams`) | Same as decision session, with `saved` |

The coordinator never names a harness: the #1164 handler builds a decision `SessionSpec` from the attempt's admitted child brain, calls `Harnesses.runtime(brain.harness).open`, and reads the first decision tool call. Placement and route follow the child, so the decision session needs no extra credential, as #1164 requires.

## 6. Tool delivery

One definition, `Toolkit.make(...tools)` with a handler layer, built per session by the role (the decision toolkit per wake-up, the operator toolkit per member token). Each adapter turns it into its harness's mechanism. In-band delivery, over the transport the adapter already owns, is preferred: it needs no network path from the worker to the orchestrator and scopes the tools to one process.

| Harness | In band | Out of band | Closing the harness's own tools |
| --- | --- | --- | --- |
| Claude Code | SDK MCP server (`createSdkMcpServer`); `tools/call` arrives as `mcp_message` control frames over the CLI's stdio, so it works through the SSH spawner (PR #1153 section 4, citing `sdk.d.ts:4695`) | `mcpServers` with an HTTP server | `tools: []`, `allowedTools: ["mcp__usine__*"]`, `strictMcpConfig`, `settingSources: []` (PR #1153 section 4) |
| Codex | The app-server sends `item/tool/call`, "Execute a dynamic tool call on the client", with `DynamicToolCallParams` (`arguments`, `callId`, `namespace`, `threadId`, `tool`, `turnId`), and defines `DynamicToolSpec`, in the pinned 0.164.0 schema (`upstream-schema.json`). `ThreadStartParams` has no field that references `DynamicToolSpec` in that schema, and `initialize` has an `experimentalApi` opt-in, so the tool registration is behind the experimental API (**inferred**, needs a spike) | `thread/start` `config` accepts any configuration override (`additionalProperties: true`), so an `mcp_servers` entry pointing at a session MCP endpoint (**unverified** against 0.164.0) | **Unverified**. Until a spike shows a way, the Codex descriptor lacks `closed-tools` with that reason, and the decision session runs on Codex only after step 19 |
| Pi, in process | `customTools` from the toolkit's handlers (`pi/sdk.ts:142-152`); `tools` is an allowlist (`:146`) | Not needed | `tools: []` |
| Pi, on a worker (step 21) | Pi 1.4.0 RPC mode has no command to register a host tool (`pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:16-135`). An extension could tunnel calls through `extension_ui_request` (`:407-470`), which misuses a UI channel (**inferred**) | `pi-mcp` 1.4.0, "Standalone Model Context Protocol client for pi", is installed; t3code's Pi provider injects MCP the same way (`t3code-harness-encapsulation.md`, recommendation 6) | Extension and tool flags of `pi --mode rpc` (**unverified**) |

Common rules, in the contract:

- Tool names reach `ToolStarted` and `ToolFinished` as the toolkit's names; the adapter strips its prefix (`mcp__usine__`), so the web maps no harness-specific names for usine tools.
- Names longer than a harness's limit or outside its allowed characters get a stable alias that maps back, as `pi-claude-cli` does for MCP's 64-character limit (`src/tool-mapping.ts` at `5f86053d7b`).
- The handler layer runs in the orchestrator, inside the role's scope, so a decision session can't reach operator tools and an orchestrator turn acts with the asking member's token (#799).

The session-scoped MCP endpoint (step 22, t3code recommendation 7) is the one out-of-band adapter, shared by Pi on workers and by Codex if the spike fails. It reuses `McpServer.layerHttp` (`McpServer.d.ts:313`) and #879's machinery, with a per-session token.

## 7. Ideas from pi-claude-cli

The owner keeps three harnesses, so making Pi the single harness through `dmmulroy/pi-claude-cli` is out. Read at `5f86053d7b` (MIT, last commit 2026-11-11). Three ideas transfer. Its launch, `claude -p --input-format stream-json --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence` with an in-band `type: "sdk"` MCP server, confirms the closed-tool-set shape planned for the Claude Code decision session. Its tool-name aliasing fits the contract's tool rules above. Its usage-credit guard ends a call when Claude Code's rate-limit status reports usage credits instead of plan capacity, which matches how usine pools refuse unrepresentable billing; whether usine's Claude adapter reads that status is not checked. Its per-process cumulative `result.modelUsage`, summed across every model including Claude Code's helper models, is worth comparing with usine's Claude usage path (not checked). It drops Claude Code's own resume and keeps Pi's history as the only record, which doesn't fit usine's resume-by-reference contract.

## 8. Remaining steps of the harness adapter plan

Each step is one pull request unless noted, follows the critical-path bar, and adds its scenarios to the contract suite.

### 16. Session spec and a role-neutral runtime seam

Add `SessionSpec`, `Start`, `NativeSession`, and `RoleSession`. Change `ChildAdapter.open` to take a spec, make `ChildRequest` a builder of a spec plus restart state, and move child restart state into the continuation decorator. Unify `ProbeTarget.credential` with `CredentialRoute`. No behavior change; the replay suite passes unchanged. Size: about 15 files in `packages/agents` and `packages/core`. Before #1164.

### 17. Roles as declarations

Add `RoleSpec`, `requirements`, and the capabilities `closed-tools`, `structured-output`, and `ephemeral`. Rewrite `admitBrain` without role-name branches; move `coding-agent` and `supervisor` (renamed `orchestrator-agent`) into their owning modules. Put the pool on `AdmittedBrain`. Make descriptors truthful: Claude Code and Codex lack `usine-tools` until steps 18 and 19, with reasons. Add the capability-to-scenario map. Update `CONTEXT.md` **Harness** to "the CLI or SDK that runs an agent session" and add **Role**. The role name needs care: `CONTEXT.md:163-165` defines **Orchestrator** as the headless server, and **Coordinator** lists "orchestrator" under _Avoid_ (PR #1197), so "orchestrator agent" collides with the glossary. Before #1164.

### 18. Tool sets on Claude Code and Pi

`open` accepts a toolkit. Claude Code serves it as an SDK MCP server; Pi serves it as `customTools`. Both support `nativeTools: false`. Add the `host-tool` and `closed-tools` fixtures for both. Before #1164.

### 19. Tool sets on Codex

Spike the experimental dynamic tools against Codex 0.164.0 and turning off shell and edit for one thread. If both hold, implement in band; else configure an MCP server per thread and depend on step 22. Record the Codex fixtures. #1164 can merge with Codex refused by its descriptor and this step lifts the refusal.

### 20. Structured completion

Add `complete` to the three runtimes: Pi through `pi-ai` with its routes, including OpenAI-compatible endpoints; Claude Code through `query()` with `outputFormat`; Codex through an ephemeral thread with `outputSchema`. Add the `structured-result` and `ephemeral` fixtures. #1165 then becomes a handler that calls `complete` (owner decision 1).

How each harness enforces the schema, checked on 2026-11-12 for #1208. usine sends the output's JSON Schema with closed objects and decodes every returned value with the Effect schema, so the decoder is the final check on all three.

- **Claude Code 2.1.311**: with `outputFormat` and `tools: []`, the `init` message lists only a `StructuredOutput` tool, and the model returns the value as that tool's input (recorded in `structured-result/claude.json`). Claude Code checks the input against the schema and asks the model again on a mismatch; past its retries the result has the subtype `error_max_structured_output_retries` (`sdk.d.ts`, `SDKResultError`). The value arrives in the result's `structured_output`. With `persistSession: false`, no transcript appears under `~/.claude/projects`.
- **Codex 0.164.0**: `turn/start` `outputSchema` constrains the final assistant message (`upstream-schema.json`, `TurnStartParams`). The 0.164.0 binary names the schema `codex_output_schema`, the Responses `text.format` name; that the format is strict is **inferred** from upstream source, not seen in traffic. Codex doesn't check the message itself, so usine parses it as JSON. An `ephemeral` thread writes no rollout under `CODEX_HOME/sessions`. Codex keeps its own tools, so the completion thread is read-only.
- **Pi 1.4.0**: `pi-ai` has no structured-output option, and `toolChoice` is only `auto` or `none` (`pi-ai/dist/types.d.ts`). The adapter sends one tool whose parameters are the schema, with `constrainedSampling: { type: "json_schema", strict: "prefer" }`, and instructs the model to call it. Each provider API sends the tool in strict mode when it supports strict tools and the schema converts, and otherwise without (`resolveJsonSchemaStrictSampling` in `pi-ai/dist/api/constrained-sampling.js`, called from the Anthropic, OpenAI Responses and Completions, Google, Mistral, and Bedrock APIs). The OpenAI Responses path is recorded in `structured-result/pi.json`. No session manager is created, so nothing is written under the session directory.
- **Refusals**: a declined answer reaches usine as Claude Code's result `stop_reason: "refusal"` and as Pi's `rawStopReason: "refusal"` on an error stop (`mapStopReason` in `pi-ai/dist/api/anthropic-messages.js`). The Codex app server has no refusal field, and pi-ai's OpenAI Responses path appends refusal text to the answer text (`openai-responses-shared.js`), so those refusals fail as invalid values.

### 21. Pi sessions on workers

t3code recommendation 6: run Pi as `pi --mode rpc` through `ChildHost` and the process owner, with persistent sessions, installed from the descriptor. Pi gains the `ssh`, `container`, and `sandbox` placements and the `api-key` route. Pi records replay fixtures at the stdio boundary. Two to three pull requests.

### 22. Session-scoped MCP endpoint and idempotent delegation

t3code recommendation 7, narrowed: one authenticated MCP endpoint per session for out-of-band tool sets, sharing `McpServer` with #879. Delegation as an idempotent tool is needed only if a model ever delegates again; the event-driven coordinator delegates through rules.

### 23. Orchestrator agent through the contract

Replaces plan step 10. The orchestrator agent is a `RoleSpec` at the orchestrator placement with gateway routes, an operator toolkit per member token, and saved sessions. #880 and #884 become one harness-neutral slice with acceptance on all three harnesses.

### Where the coordinator slices and #799 plug in

```text
#1157 (PR #1197) ─▶ #1163 ─▶ #1159 ─▶ #1158 ─▶ #1160 ─▶ #1166
 rules only          input    replays  config   quickstart  remove Pi parent
      │
      └── no harness change; rename `parent: pi | none` before #1158 ships it

steps 16 ─▶ 17 ─▶ 18 ─▶ #1164 (Pi, Claude Code) ─▶ 19 ─▶ #1164 complete on Codex
                   └──▶ 20 ─▶ #1165
                   └──▶ 21 ─▶ 22 ─▶ 23 ─▶ #799 turns (#880, #884), conversations (#881)
```

- **#1157, #1163, #1159**: no harness change. Operator input reaches the child through `RunningSession.intervene`, which is already neutral.
- **#1158**: the configuration value `pi` names a harness. Rename before it ships, for example `coordinator: session | events`, since #1160 writes the value into every new instance.
- **#1160**: the prerequisites name no provider, as PR #1200 requires. Until step 21, a Pi-only operator must use a local worker; the quickstart says so without naming a provider, for example by stating which worker kinds each credential reaches.
- **#1164**: rescope to "on all three harnesses" with Codex lifted by step 19; the handler interface is a `RoleSpec` plus `Harnesses`, so "No provider or harness name appears in the handler interface" holds by construction.
- **#1165**: rescope to a handler over `complete` if owner decision 1 is taken as recommended.
- **#1166**: deletes the six `Harness.make("pi")` sites in `parent.ts`, the `coordinator` role, `durable-coordination`, `parent_model`, and `parent_effort`.
- **#799**: steps 16 to 18 suffice for Pi and Claude Code on the orchestrator host; Codex needs step 19. Step 22 is needed only for laptop clients through #879.

### What can wait

Steps 21 to 23, OpenCode (step 9), and a `LanguageModel` layer over `complete` for roles that want `effect/ai`'s full interface.

## 9. Owner decisions

1. **One model path for #1165.** Option A: #1165 calls `complete` through the harness contract, and an OpenAI-compatible endpoint is a Pi `Endpoint` route, which keeps #799's "No second model-calling path" and puts the endpoint behind the same admission, pools, and usage events. Option B: as filed, an `effect/ai` `DecisionModel` client with its own configuration. A gives up `DecisionModel`'s per-label probabilities unless Pi's provider exposes them (**unverified**). Recommended: A. Default if unanswered: A.
2. **Codex tool delivery.** In band through the experimental dynamic tools, or out of band through an MCP server in thread configuration. In band needs no network path from worker to orchestrator but depends on an experimental API that can change between pinned versions. Recommended: spike in band in step 19 and adopt it if the replay fixtures are stable across one Codex upgrade. Default: spike first.
3. **Configuration for role brains.** Recommended: agent `decision: { model, effort }`, with the harness inherited from the agent so the decision session uses the child's route; instance `orchestrator: { harness, model, effort }`; `parent_model` and `parent_effort` removed with #1166; `parent: none` renamed before #1158. Default: as recommended.
4. **When Pi moves to workers (step 21).** Until it does, an operator whose only route is a Pi route can't use SSH, container, or sandbox workers, which is the provider-agnostic gap that remains after #1160. Recommended: in parallel with #1164, before step 23. Default: after #1164.

### Decisions taken

The owner answered on 2026-11-11:

- **Decision 1:** option A. #1165 calls `complete` through the harness contract (step 20, #1208).
- **Decision 3:** configuration names no harness. The switch is `coordinator: session | events` (#1158), an agent gets `decision: { model, effort }`, and `parent_model` and `parent_effort` go with #1166.
- **Role name:** the role this note calls "orchestrator agent" keeps the name **supervisor**, as in the code and #799. Read every "orchestrator agent" and `orchestrator-agent` in this note as supervisor, and the instance brain key as `supervisor`.
- Decisions 2 and 4 keep their defaults.

## Not verified

- Codex 0.164.0: how dynamic tools are registered on a thread under `experimentalApi`, whether a thread can turn off shell and edit tools, and whether a `config` override can add an MCP server.
- Pi: which flags `pi --mode rpc` takes for extensions and tools.
- Codex: whether `outputSchema` reaches the Responses API in strict mode.
- Whether `pi-ai` providers expose label probabilities, which owner decision 1 affects.
- Whether usine's Claude adapter reads the usage-credit status, and whether its usage sums helper models as `pi-claude-cli` does.
- Line numbers in PR #1197 are hunk positions and may move before merge.
- Apart from the step 20 findings, which recorded fixtures back, no build or test ran; every claim about behavior comes from reading code and pinned type declarations.
