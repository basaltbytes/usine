Historical: the `ModelAccess` port was never built, and usine keeps one way to call a model through the harness contract (see `AGENTS.md`).

# Model access for parents and children

Research for [#800](https://github.com/basaltbytes/usine/issues/800), supporting [#799](https://github.com/basaltbytes/usine/issues/799). Read and tested on 2026-11-01 against usine commit `1f129744a797299a206159eebec2d9d8a4f3aefc`, Pi and pi-durable 1.4.0, and usine's Claude Agent SDK 0.3.311.

## Recommendation and completion status

Introduce `ModelAccess` as a platform-free port for credential selection, pool attribution, and request admission, with the gateway as the authority for credentials it manages. Keep Pi as the parent. Implement a Pi provider adapter over the port before considering a different parent harness; the supervisor must use the same port. A shared library supplies contracts and deterministic policy, while one runtime owns each credential's admission state. Sharing code alone cannot coordinate concurrent requests.

Do not adopt `pi-claude-bridge` as an operational stopgap yet. Its standalone Pi tests passed, but installing it does not register a provider in usine's durable parent. Its placeholder API key also produces the wrong pool classification under usine's existing rules. Integration needs an adapter and verified billing metadata, followed by an actual attempt and restart test.

**Incomplete acceptance:** this investigation did not complete the requested Claude-plan usine attempt or orchestrator restart with reattachment. The available environment exposed an attempt-scoped gateway caller token, not a disposable orchestrator endpoint, gateway credential-kind access, or the subscription account's billing view. Therefore the live bridge calls below establish transport compatibility, session continuation, caching, and steering only. They do not establish Claude-plan attribution or absence of Extra Usage. OpenAI's legal pages returned HTTP 403; the OpenAI terms assessment remains limited to its accessible product documentation.

## Existing boundaries

| Path | Selection and execution | Accounting boundary |
| --- | --- | --- |
| Pi parent | `@usine/durable` creates `ModelRuntime`, selects a model, and gives `Models` to pi-durable | `resolveParent` calls `checkAuth`; `resolvePiPool` accepts API keys or subscription OAuth for `openai-codex` |
| Claude or Codex child | `ChildBackend` starts the vendor harness through `ChildHost`; gateway workers send caller tokens | Credential-kind metadata and harness events determine the pool; provider response and harness usage are separate observations |
| Pi child | Pi SDK model runtime | API-key-only under ADR 0021 |
| Supervisor proposal | #799 requires the agents' model-access path | Must retain member authority separately from the credential that pays for inference |

Sources: [`live.ts`](../../packages/durable/src/live.ts), [`parent.ts`](../../packages/durable/src/attempt/parent.ts), [`authentication.ts`](../../packages/agents/src/pi/authentication.ts), [`AttemptRuntime`](../../packages/durable/src/attempt-runtime.ts), [`gateway preflight`](../../packages/executor/src/ssh/gateway/preflight.ts), and [`gateway provider metadata`](../../packages/gateway/src/admin/api.ts).

The parent uses pi-durable conversations, not a `pi-coding-agent` interactive session. The accepted durability contract commits tool intent and partial output; after restart, a non-replay-safe child call ends as interrupted and the parent can decide whether to delegate again. That differs from resuming a vendor conversation by session ID. Holds, intervention routing, and release are usine behavior layered on this storage contract ([ADR 0005](../adr/0005-pi-parent-agent-layer-team-roster.md), [ADR 0018](../adr/0018-takeover-and-edit-and-retry.md), [`attempt/task.ts`](../../packages/durable/src/attempt/task.ts)).

Read ADR amendments in date order. ADR 0027 now includes gateway-held subscription logins, per-attempt containers, and durable attachment snapshots; its original in-memory-only attachment description is obsolete. ADR 0013 now includes estimated ChatGPT cost. Neither estimate is a subscription invoice or a remaining balance.

## ModelAccess design

### Ownership and call paths

Put the port's schemas, typed refusals, and pure selection rules in a platform-free capability module. The gateway supplies its credential-owning implementation; the orchestrator supplies a remote client and Pi adapter. A local instance without a gateway can use an in-process implementation with the same contract, provided it is the sole authority for those credentials. Do not give both implementations independent quota state for the same account. Node process, filesystem, and transport dependencies belong in adapter subpaths, following the engine and config packages.

```text
Pi durable parent / Pi child / supervisor
  -> usine Pi provider adapter
  -> ModelAccess admission and credential binding
  -> gateway provider transport -> provider

Claude Code / Codex child
  -> existing harness protocol and caller token
  -> gateway ModelAccess admission and credential binding
  -> provider

Both paths -> attributed usage and rate-window observations -> attempt channel
```

For API-key models, the parent adapter can preserve Pi's request/response codec while targeting the gateway. The gateway replaces the caller token with the selected key. For a ChatGPT route, preserve the subscription-specific protocol; a subscription credential is not an OpenAI API key. Keep the existing `openai-codex` path behind the port until its gateway transport, refresh ownership, and terms assessment pass acceptance. Do not silently substitute a paid API route.

An Anthropic subscription route must execute through the unmodified Claude Code client under an allowed authentication arrangement. `ModelAccess` does not make a raw Pi Anthropic request eligible for Claude-plan billing. A bridge would be an additional process adapter with its own session state, not a base-URL change. Similarly, a gateway caller token proves the authorized scope, not which executable generated the request; it cannot prove compliance with a vendor-client restriction.

The orchestrator needs its own authenticated model-call scope. Reusing the gateway admin token in inference requests or pretending the parent is a worker would expand its authority incorrectly. Bind parent calls to instance, run, attempt, and session; member conversations require an explicit member scope and bounded lifetime. A supervisor's operator token authorizes operator actions; it must never become an inference credential. Every request checks its live scope. Revocation prevents new calls and defines whether active streams are canceled.

Today's container caller token identifies an attachment, not an individual child session. Per-session binding therefore requires an additional scoped handle issued at child launch and a tested way to pass it through each unmodified harness. The gateway validates that handle against the attachment. Do not assume a session ID is already present in vendor HTTP traffic. Until this transport contract passes, retain attempt-level attribution and report the missing detail explicitly rather than inventing request-to-session matches.

### Contract and invariants

`ModelAccess` should select an allowed route, admit each provider request, and record its outcome. The selection result includes an opaque credential identity and revision, provider, model, transport kind, credential kind, pool, and allowed usage. It contains no upstream credential. Use tagged variants for API-key transport and vendor-client subscription transport so an arbitrary provider name cannot imply subscription access. The implementation owns refresh, transport, admission, and accounting reconciliation; callers must not rebuild these rules.

A session records the selected credential revision and pool. A gateway reload that changes key to subscription or back cannot silently change the billing source of later calls in that session: retain the old binding while valid, or refuse and require an explicit new binding. This tightens the current gateway's provider-slot metadata contract. API credits linked to a subscription still use the API-key route; the request credential determines the pool.

Refuse missing, unsupported, expired, or unclassifiable credentials before contacting a model. Return typed errors with the provider, pool if known, safe reason, and reset time when supplied. Do not map a bridge's `apiKey: "not-used"` to billable API access. Do not switch pools, models, or Extra Usage modes automatically after exhaustion.

Account windows belong to a credential identity, not merely `claudePlan` or `chatgptPlan`: multiple accounts may contribute to one displayed pool. Store source, observation time, reset time, and scope for each observation. Apply a fresh exhausted-window observation to parent and child admission alike; interpret `Retry-After` and provider refusals, with a shared backoff. Unknown or stale capacity remains explicitly unknown. It cannot justify a fabricated remaining-token count or guarantee that the provider will accept the next request. Initial support should enforce known refusals without creating a scheduler that holds attempts until reset.

This revises ADR 0013's display-only policy. Its existing native meters remain: tokens, cache reads and writes, provider-reported charges where available, and separately marked estimates. The gateway records credential attribution and admission; harnesses report model usage. Reconcile these as two observations of one call, not two charges. Preserve cumulative-versus-delta semantics and the existing runaway-guard token definition. Disconnects can leave billing unknown; never convert an incomplete stream to zero cost or replay it merely because a usage event is missing.

Keep one authoritative usage meter per session: the harness's normalized events. Gateway admission records must not add another token total. Correlate individual provider calls only where the adapter exposes a stable request identity; otherwise retain session-level totals and incomplete correlation. This preserves accounting correctness without requiring a speculative parser for every vendor's response stream.

Trace selection, refusal, refresh, backoff, cancellation, and terminal outcomes with run, attempt, session, and request IDs. Use `Effect.fn` spans and structured logs; keep credentials and prompt bodies out of them. A provider failure becomes a typed channel failure, while a defect remains a defect. Admission and usage writes must tolerate retries and restarts without duplicate totals. Local request IDs provide deduplication inside usine; they do not make an upstream generation exactly once.

### Effect on Pi sessions

Pi 1.4.0's `Models` interface supports authentication checks, model discovery, streaming, and cancellation options; `MutableModels` adds provider registration. pi-durable accepts `Models` directly. A provider adapter can therefore retain durable conversations and the `subagent` tool while changing inference transport ([Pi source](https://github.com/earendil-works/pi), installed `@earendil-works/pi-ai/dist/models.d.ts`; usine's [`DurableHarnessOptions`](../../packages/durable/src/harness.ts)).

Preserve model IDs across recovery, tool-call IDs, stop reasons, thinking signatures, streamed event ordering, abort propagation, and usage units. Persist the selected route before starting generation and revalidate it on restart. Compaction and summarization also call models; routing only ordinary parent turns would leave a bypass. A provider that drives Claude Code adds a second session store and prompt transformation. Its cache and tool-result synchronization must survive interruption, compaction, and concurrent sessions before it can replace a direct provider.

## Parent harness comparison

These are adapter capabilities, not evidence that a vendor SDK implements usine's durable protocol. Claude entries use the installed 0.3.311 types and the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript). Codex entries distinguish the [TypeScript SDK](https://developers.openai.com/codex/sdk) from [app-server](https://developers.openai.com/codex/app-server), which usine already uses for children. Current documentation can describe features beyond usine's pinned app-server protocol 0.164.0; validate each wire method against that pin before implementation.

| Required behavior | Claude Agent SDK | Codex | usine adapter work |
| --- | --- | --- | --- |
| Multi-turn conversation | `query()` with streaming input; session ID and `resume` | TypeScript threads can continue/resume; app-server has `thread/start`, `thread/resume`, `turn/start` | Persist vendor IDs and correlate them with parent session IDs |
| Steer during work | Streaming user input; delivery depends on the running tool boundary | app-server `turn/steer` targets an active turn; the basic TypeScript thread API is not the full control protocol | Durable queued input, delivery acknowledgment, ordering, and retries |
| Interrupt | `Query.interrupt()` in streaming-input mode; abort/close for termination | app-server `turn/interrupt`; turn completion reports interruption | Abort active children too; persist paused state before continuing |
| Hold and release | No usine hold/release transaction | No usine hold/release transaction | Persist holds and pending answers; gate tool return and terminal outcome until release, including after restart |
| Restart and reattachment | Persisted Claude session and `resume`; does not replay usine tool intents transactionally | Persisted thread and `thread/resume`; does not commit usine tool outcomes | Reconcile tool calls and partial output; recover without spawning a second child or reporting completion twice |
| Child spawning | SDK custom MCP tool can implement `subagent`; built-in agents have different ownership | app-server dynamic tools or MCP can implement `subagent`; dynamic tools are experimental | Keep existing `ChildHost`, budgets, scoped environment, salvage, and session tracking; disable unrelated built-in tools |
| Usage and rate windows | Assistant/result usage, `modelUsage`, and SDK rate-limit events | Token-usage events and `account/rateLimits/read`/`updated` in app-server | Normalize snapshots/deltas, preserve estimates, and attribute through ModelAccess |
| Terminal report | SDK result/error stream | Turn result and thread events | Interpret reserved markers and harvested facts; a vendor turn ending does not mean the attempt succeeded |

A native parent can reduce the bridge's double conversation conversion, but cannot remove usine's durability and intervention state. Session persistence alone does not replace pi-durable's task/document commits. The migration would first isolate a parent-session contract behind `AttemptRuntime`, then prove a Claude implementation with a custom `subagent` MCP tool, and separately evaluate Codex app-server. Keep vendor control protocols out of the engine. Do not replace Pi and introduce ModelAccess in the same change.

Migration acceptance must cover a restart before tool intent, during child execution, after child completion but before result acknowledgment, while held, and while releasing. Resume the same parent and reconcile the existing child. Vendor session loss must fail explicitly with recoverable evidence rather than create an unrelated conversation. Migrate stored attempts only at a defined boundary; retain the Pi adapter for attempts already using it until they settle.

## Bridge experiment

### Versions and setup

The npm artifact was `pi-claude-bridge@0.9.3`, published from commit `874fa7c2678456336f23b64e784e2057e608d83e`. Its published manifest allows Pi `>=0.86.1` and Agent SDK `^0.3.293`; its README requires Pi 1.2 or newer for all models. Upstream `main`, read on 2026-11-01, still says 0.9.3 but pins SDK `0.3.308`. The issue's SDK range is therefore not an exact description of the published artifact. The experiment pinned Pi coding-agent, pi-ai, and pi-tui to 1.4.0 and overrode the SDK to 0.3.308, invoking the installed Claude Code 2.1.311 binary. usine itself pins SDK 0.3.311; compatibility with that SDK combination needs a separate test.

Sources: [npm artifact](https://registry.npmjs.org/pi-claude-bridge/-/pi-claude-bridge-0.9.3.tgz), [upstream manifest](https://github.com/elidickinson/pi-claude-bridge/blob/main/package.json), [README](https://github.com/elidickinson/pi-claude-bridge/blob/main/README.md), and [provider implementation](https://github.com/elidickinson/pi-claude-bridge/blob/main/src/index.ts). Upstream links are mutable; the measurements below used the published tarball and the explicit SDK override.

Install in an isolated directory, leaving the repo lockfile and running orchestrator unchanged:

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "pi-claude-bridge": "0.9.3",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
    "@anthropic-ai/claude-agent-sdk": "0.3.308"
  },
  "overrides": { "@anthropic-ai/claude-agent-sdk": "0.3.308" }
}
```

Set `PI_CODING_AGENT_DIR` to an isolated configuration directory. The bridge configuration disabled `AskClaude`, set `provider.plan` to `pro`, disabled `longContextExtraUsage`, enabled `strictMcpConfig`, and used `/usr/bin/claude`. The `plan` field controls model eligibility; it does not verify the billed account. The subprocess inherited the attempt's existing `ANTHROPIC_BASE_URL` and caller token. No credentials were copied into the report.

A representative first call, from the isolated directory after `npm install --ignore-scripts`, was:

```sh
node_modules/.bin/pi --offline --no-extensions \
  -e node_modules/pi-claude-bridge/src/index.ts \
  --no-skills --no-context-files --no-mcp --no-tools \
  --provider claude-bridge --model claude-haiku-4-5 --thinking off \
  --mode json --session session.jsonl \
  -p 'Reply with exactly BRIDGE_OK. Do not use tools.'
```

### Observations

| Experiment | Observed result | Limit |
| --- | --- | --- |
| First Pi turn | `BRIDGE_OK`; 3,352 input, 100 output, 0 cache-read, 0 cache-write tokens; assistant duration 3,095 ms | One small prompt, one model |
| Fresh Pi process, same session file | Prompt: “Repeat the exact marker from your previous answer. Do not use tools.” Result: `BRIDGE_OK`; 3,477 input, 53 output, no cache tokens; 1,335 ms | Graceful process exit and session continuation, not an orchestrator crash or reattachment |
| RPC steering | Enabled only `bash`; prompted one `sleep 3`, then `ORIGINAL`. Sent `steer` at `tool_execution_start`, asking for `STEERED`. Pi emitted the steered user message 3,012 ms later and returned `STEERED`; total 8,498 ms | One tool-boundary sample, not a latency percentile or preemptive interruption guarantee |
| Cache during steering | First response: input 10, output 125, cache-write 4,148. Continuation: input 8, output 238, cache-read 4,148, cache-write 262 | Demonstrates cache reuse within this conversation; does not establish restart/compaction cache retention |
| Durable parent provider discovery | `ModelRuntime.create()` reported no `claude-bridge` provider or model | Matches usine's live composition; installing a coding-agent extension does not integrate it |
| Billing observation | Pi events reported zero cost fields; no Extra Usage indicator appeared in the captured events | Zero fields are not proof of free usage. No account-side balance or Extra Usage measurement was available |

The bridge's provider configuration uses `apiKey: "not-used"`. Pi reports that as API-key authentication when the provider is manually registered; usine's `resolvePiPool` consequently selects `apiKeys`. Registering it and changing only the provider name is not a valid Claude-plan integration. A verified subscription binding must select `claudePlan`, while a gateway API key must still select `apiKeys`.

The bridge source keeps per-session synchronization state, forwards tool results through an MCP server, and rebuilds or resumes Claude transcripts after history changes. It also relies on coding-agent session hooks for system prompts, compaction, and lifecycle cleanup. Those hooks do not automatically run in pi-durable. A compatibility adapter must supply the required state and hook behavior, not just copy `streamSimple`. Disable `AskClaude` so it cannot bypass usine's child-session budget.

### Required instance experiment

Complete this matrix on a disposable instance before recommending the bridge. Record exact package versions, CLI version, route identity and credential revision, run/attempt/session IDs, UTC times, and redacted event evidence. Record the Claude account's usage and Extra Usage state before and after; a gateway caller token alone cannot establish either.

1. Verify the gateway's credential kind and account ownership, register the bridge in the durable parent's model runtime, and resolve its pool from that binding. Confirm API-key and subscription routes produce different pools without renaming the model.
2. Run one attempt through parent delegation, child completion, harvested result, and terminal outcome. Confirm every model call, including summaries, has one usage attribution and the parent exposes only usine's `subagent` tool.
3. Restart the orchestrator during a child call, reattach the same attempt, and check the committed output, interrupted-call handling, holds, and absence of duplicate child execution. Repeat restart while held and release after recovery.
4. Repeat the fixed prompt before and after restart and compaction. Record cache-read/write tokens, steer delivery at a tool boundary, cancellation behavior, and account-side billing changes. Refuse any route whose actual pool cannot be determined.

The first two standalone Pi tests above are not substitutes for this matrix. Until the adapter and test instance are available, keep bridge adoption disabled and this issue's live acceptance open.

## Terms and billing assessment

Billing documentation describes which account pays; it does not grant permission to offer a subscription-backed product. These findings concern an operator using their own account. They do not establish a right to pool several members behind one person's subscription.

| Credential and execution | Primary evidence read on 2026-11-01 | Conclusion for ModelAccess |
| --- | --- | --- |
| Anthropic API key at gateway, used by SDK or direct API | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), sections A, D, H; [gateway guide](https://code.claude.com/docs/en/llm-gateway) | Commercial terms govern API-key use and fees. Gateway injection is documented. Attribute `apiKeys`; API credits do not change the credential kind |
| Claude Code forwards its own subscription login | Gateway guide distinguishes setting only `ANTHROPIC_BASE_URL` from replacing authentication; [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) requires an unmodified binary and each end user's own credentials | Documented client path. Preserve required OAuth headers and the subscriber's limits; do not turn it into a general raw-model subscription API |
| Gateway stores the operator's Claude subscription token | [ADR 0027, 2026-10-26 amendment](../adr/0027-gateway-credential-proxy.md) records the existing interpretation; current gateway guide documents forwarding a saved client login, not every token-replacement arrangement | Existing deployment behavior, not a fresh blanket provider authorization. Confirm the account/use arrangement before adding another caller class or offering it to other members |
| Claude Agent SDK under a subscription | [Plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): June 15 pause and October 7 update; [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) restricts third-party products offering claude.ai login or limits without approval | Own-plan SDK calls still consume subscription limits according to the support article. The SDK product restriction remains relevant to a bridge. Do not infer permission to resell or intermediate subscriptions |
| Codex client with ChatGPT login, including headless operation | [Authentication](https://developers.openai.com/codex/auth) documents ChatGPT/API-key login, copying one's login cache to a headless machine, and proxies with `requires_openai_auth` | A documented Codex authentication path; protect the cache as a password. It does not establish authorization for arbitrary Pi clients, shared-account pooling, or a hosted subscription broker |
| OpenAI API key held by gateway, SDK use | Authentication documentation distinguishes API-key billing and recommends keys for programmatic use; [app-server authentication](https://developers.openai.com/codex/app-server) describes supported account modes | Technically supported API-key path. Terms of Use and Services Agreement fetches returned 403, so contractual restrictions were not verified here; review them before expanding the existing deployment |

The fetched Anthropic Consumer Terms were the EEA/Switzerland version, effective 2025-10-08. Section 2 prohibits sharing account credentials; section 3 excludes automated access except API-key use or access Anthropic explicitly permits. Its [commercial terms](https://www.anthropic.com/legal/commercial-terms) separately govern API keys. The current Claude Code legal page allows unmodified Claude Code in products under its stated conditions, whereas the Agent SDK overview retains an approval requirement for offering claude.ai login. Do not erase that distinction by quoting only the billing support article.

The paused announcement is no longer the whole billing story: the support article's October 7 update says Max, Ultra, and Team plans include API credits used with a key from a linked Console organization. Signed-in SDK and `claude -p` calls still draw from subscription limits. A bridge's `longContextExtraUsage: false` controls its long-context eligibility; it cannot attest to account-level Extra Usage settings or the gateway's chosen credential. Record billing as unknown until the owner-side evidence is available.

## Port acceptance tests

Use deterministic tests for policy and durable state, real gateway transport tests for credential binding, and opt-in vendor contract tests for actual session behavior.

| Regression to prevent | Required observation |
| --- | --- |
| Unknown billing source starts generation | Missing/unsupported auth and a bridge placeholder fail before any upstream call |
| Parent and child disagree about one credential | Same credential revision produces the same pool for both; an API key under a subscription-linked Console account remains `apiKeys` |
| Gateway reload changes a running session's pool | Existing binding stays fixed or fails explicitly; a new session records the new revision |
| Parallel callers ignore exhaustion | A fresh exhausted-window observation blocks both callers; retry/reset metadata agrees, with no silent pool switch |
| Stale data produces false certainty | Expired/unknown observations remain unknown; provider refusal updates shared state without inventing a balance |
| Restart duplicates usage or refresh | Replayed usage IDs change no totals; one authority refreshes a rotating token; restored state preserves attribution |
| Stream failure becomes a zero charge or duplicate call | Partial usage remains partial; no automatic replay after ambiguous provider acceptance |
| Caller escapes its authorization | Expired, detached, wrong-session, and wrong-instance scopes fail; inference cannot use gateway administration authority |
| Pi background calls bypass policy | Normal turns, compaction, summaries, and retries all pass the port; tool IDs and abort behavior survive the adapter |
| Harness replacement loses intervention semantics | The hold/steer/interrupt/release and restart matrix above passes with one terminal outcome |
| Vendor transport changes silently | Pinned SDK/CLI contract tests cover tools, streaming, auth, usage, and observed rate windows; unsupported capabilities fail explicitly |
| Diagnostics expose credentials | Selection/refusal/backoff events identify the request and reason without tokens, auth headers, or prompts |

## Implementation order and ADR amendments

1. Implement ModelAccess and its gateway/orchestrator adapters with current supported routes. Add authoritative credential binding and shared observations, migrate Pi normal and background calls, and prove the acceptance tests. Avoid introducing subscription routes that cannot be classified.
2. Add known-exhaustion admission checks after recording the change to ADR 0013. Preserve warning-only treatment of unknown capacity and the existing explicit failure behavior; a queue-until-reset scheduler is a separate decision.
3. Complete the bridge instance experiment only if Claude-plan parent access is still needed before a native parent adapter. Adopt it only with measured recovery and verified billing; otherwise retain Pi's supported API-key and ChatGPT routes.
4. Isolate and test the parent-session contract, then migrate a new parent harness independently. The supervisor uses the accepted ModelAccess routes throughout.

| ADR | Proposed amendment on implementation |
| --- | --- |
| [0005](../adr/0005-pi-parent-agent-layer-team-roster.md) | Keep Pi and pi-durable initially; model access becomes an injected capability. A native parent requires a separate amendment after protocol parity |
| [0013](../adr/0013-cost-accounting-native-meters-guardrails.md) | Bind pool and credential revision before a call; reconcile usage observations; replace display-only handling for fresh known exhaustion with request admission refusal |
| [0021](../adr/0021-pi-parent-pool-follows-authentication.md) | Replace provider-name/auth heuristics with a verified route binding. Claude-plan parents require a tested vendor-client adapter; this proposal does not enable them |
| [0027](../adr/0027-gateway-credential-proxy.md) | Add parent/member model-call scopes, one credential authority, per-request admission, revision binding, and restart persistence; preserve credential secrecy, attachment checks, and vendor protocol semantics |

The proposal is conditional. The unresolved live-test and legal-source limits above prevent treating this report as approval to deploy the bridge or expand subscription use.
