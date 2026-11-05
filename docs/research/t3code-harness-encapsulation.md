# t3code harness encapsulation

Research for the owner's question of 2026-11-05: what usine can learn from the way [pingdotgg/t3code](https://github.com/pingdotgg/t3code) wraps Claude Code, Codex, and other coding-agent harnesses, and what to re-apply. Read on 2026-11-05 against t3code [`337c585`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17) and usine [`f7c670a`](https://github.com/basaltbytes/usine/tree/f7c670a1ccde8bd617bfc58da206f61567cd19d1). This is a source and documentation review. No t3code code was installed or run.

t3code links pin `337c585`. usine links point at files in this repository.

## Summary

- Steps 1 to 8 of the [harness adapter plan](./harness-adapters.md#migration-plan) are merged (#963, #968, #972, #979, #973, #974, #966, #988). They moved data, admission, and credential wiring behind descriptors. The plan left the runtime half inside each adapter on purpose: "Launch options, codecs, resume delays, the Claude login lock, Codex homes, and the remote Codex supervisor stay inside each adapter." This week's review findings sit in that runtime half.
- t3code draws its seam lower. An adapter implements turn primitives (open a session, resume a thread, start a turn, steer, interrupt, answer a runtime request) and emits one stream of normalized events. Everything that decides what happens next is harness-neutral and sits above the adapter: queue, steer, or interrupt and restart; what to do after a server restart; the text of a continuation turn; how to settle open work.
- usine's seam, `RunningSession`, returns a session that owns its whole lifecycle. `conversation.ts` and `session.ts` share holds, pauses, and the terminal latch, but each adapter still owns transport recovery, resume, its continuation prompt, delivery acknowledgement, process cleanup, and its environment. Claude Code, Codex, and the durable `subagent` tool now carry three different continuation prompts and three process-recovery mechanisms.
- t3code's adapters are not small. `ClaudeAdapterV2.ts` has 12,327 lines, `CodexAdapterV2.ts` has 8,060, and the Claude adapter took 144 commits in the 30 days before this note. What keeps that churn under control is its tests: recorded provider transcripts replayed through the real adapter, orchestrator, and projections, with shared scenarios per harness, in CI.
- Several t3code choices follow from its scope (one user, one machine, an interactive client, trusted repositories): child processes inherit the server's environment, Claude Code loads project settings, approvals are a first-class flow, and usage is estimated from native transcript files. None of these fit an unattended factory, and this note doesn't recommend them.
- Recommendations, in priority order: replay tests at the transport boundary in CI; one harness-neutral process owner on the worker with a lease; one continuation policy above the adapters; usine-assigned IDs for native sessions and operator messages; harness-scoped environments with the credential route resolved at every launch; Pi children as `pi --mode rpc` processes on the worker; usine tools over one MCP endpoint with idempotent delegation.

## Sources read

t3code at `337c585` (base URL `https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/`):

- **T1:** [`README.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/README.md), [`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/internals/overview.md): product scope, ownership boundaries, durable intent and side effects.
- **T2:** [`docs/internals/providers.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/internals/providers.md) and [`docs/internals/adding-a-provider.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/internals/adding-a-provider.md): provider constraints, protocol traps, the checklist for a new driver.
- **T3:** [`docs/orchestration-v2/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/orchestration-v2): `README.md`, `provider-capability-system.md`, `testing-strategy.md`, `orchestrator-mcp-server.md`.
- **T4:** [`packages/provider-core/src/server/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server): `ProviderAdapter.ts`, `driver.ts`, `ProviderHost.ts`, `auth.ts`, `instanceEnvironment.ts`, `processGroup.ts`, `usage.ts`, `usageLimits.ts`.
- **T5:** [`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) and [`CodexAdapterV2.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).
- **T6:** [`apps/server/src/orchestration-v2/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2): `CommandPolicy.ts`, `RestartContinuation.ts`, `ProviderRuntimeRecoveryService.ts`, `ProviderTurnControlService.ts`.
- **T7:** [`apps/server/src/provider/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/provider): `Drivers/ClaudeHome.ts`, `Drivers/CodexHomeLayout.ts`, `CodexManagedRuntime.ts`, `CodexManagedTokenBroker.ts`, `codexLaunchArgs.ts`, `providerCompatibility.ts`, `model-manifest.json`, `Drivers/claudeUsage.ts`.
- **T8:** [`packages/effect-codex-app-server/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/effect-codex-app-server): `scripts/generate.ts`, `src/_internal/stdio.ts`.
- **T9:** [`packages/provider-pi/src/server/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-pi/src/server) (`mcpInjection.ts`, `rpc.ts`) and [`packages/provider-opencode/src/server/v2/OpenCode2Server.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-opencode/src/server/v2/OpenCode2Server.ts).
- **T10:** [`packages/shared/src/AgentScope.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/shared/src/AgentScope.ts): systemd scopes for agent processes.
- **T11:** [`packages/contracts/src/orchestrationV2.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/contracts/src/orchestrationV2.ts): turn items and domain events.
- **T12:** [`apps/server/src/orchestration-v2/testkit/`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/testkit) (fixtures, `ProviderReplayHarness.ts`), [`apps/server/scripts/record-*-replay-fixture.ts`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/scripts), and [`.github/workflows/ci.yml`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/.github/workflows/ci.yml).
- **T13:** user guides [`providers-claude.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/user/providers-claude.md), [`providers-codex.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/user/providers-codex.md), and [`usage.md`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/user/usage.md).
- **T14:** `git log --since=2026-10-06` on `apps/server/src/orchestration-v2/Adapters/` and `testkit/fixtures/` in the clone.

usine at `f7c670a`:

- **U1:** [Harness adapters](./harness-adapters.md), [ADR 0021](../adr/0021-pi-parent-pool-follows-authentication.md), [ADR 0027](../adr/0027-gateway-credential-proxy.md).
- **U2:** [`packages/agents/src/harness/`](../../packages/agents/src/harness/) (`claude/`, `codex/`, `pi/`, `launch.ts`, `conversation.ts`, `session.ts`, `runtime.ts`, `capability.ts`, `harness.ts`), [`packages/agents/src/runtime.ts`](../../packages/agents/src/runtime.ts), [`packages/agents/src/child-host/child-host.ts`](../../packages/agents/src/child-host/child-host.ts), [`packages/durable/src/attempt/subagent.ts`](../../packages/durable/src/attempt/subagent.ts).
- **U3:** [`packages/executor/src/ssh/gateway/environment.ts`](../../packages/executor/src/ssh/gateway/environment.ts), [`packages/executor/src/ssh/api-keys.ts`](../../packages/executor/src/ssh/api-keys.ts), [`packages/agents/package.json`](../../packages/agents/package.json), [`packages/agents/test/`](../../packages/agents/test/).
- **U4:** review threads on [#999](https://github.com/basaltbytes/usine/pull/999) (head `57b109d`), [#1000](https://github.com/basaltbytes/usine/pull/1000) (head `77a441f`), and [#1001](https://github.com/basaltbytes/usine/pull/1001) (head `942cd2a`, closed and parked by the owner).
- **U5:** the installed `@anthropic-ai/claude-agent-sdk` 0.3.308 type declarations (`sdk.d.ts`) in the main checkout's `node_modules/.pnpm/`, for the `sessionId` option (line 2127), `user_message_uuids` (line 3691), and `SDKUserMessage.uuid` (line 6580). usine pins 0.3.311.

## Review findings this week

| Finding | PR | Concern |
| --- | --- | --- |
| A replayed child is counted as spawned before its resume succeeds, so a replacement child can't clear the pre-restart infrastructure failure (P1) | #1000 | Resume after restart |
| A resume reuses the saved gateway credential kind instead of the current one (P2) | #1000 | Credential routing |
| Codex can leave two app-servers on one thread: the `-resume` launch's PID file isn't stopped (P2) | #1000 | Process lifecycle |
| A saved row that fails to decode crashes the tool call (P2) | #1000 | Resume after restart |
| The resume sends the whole child prompt, and a child idle under a hold gets a new turn (P3) | #1000 | Continuation policy |
| `restart.test.ts` is excluded from `test` and not run in CI (P3) | #1000 | Testing |
| OpenCode's `XDG_DATA_HOME` reaches every child in the attempt, because the executor merges every descriptor's wiring (P1) | #1001 | Environment and credentials |
| Server failures carry no stderr or exit code, and `close` isn't cached (P2) | #1001 | Process lifecycle |
| The SSH forward lacks `ControlPath=none` and drops its own errors (P2) | #1001 | Process lifecycle |
| CI tests neither the server transport nor `interrupt` (P2) | #1001 | Testing |
| Delivery is keyed by message text, so two identical queued messages count as one (P3) | #1001 | Delivery acknowledgement |
| A gateway outage stops `usine up` (P1) | #999 | Credential routing |
| A renewal racing with detach can restore the attachment (P2) | #999 | Lifecycle |
| Local versus gateway credentials are an optional Promise callback threaded through five layers (P2) | #999 | Credential route modeling |

Most findings are the same few concerns written again for each harness or caller: who owns the process, how a session resumes, which credential route applies, how a message is acknowledged, and whether a test exercises the real protocol.

## t3code provider model

### Driver, instance, and adapter

A **driver** identifies an integration, such as `claudeAgent` or `codex`. An **instance** is one configuration and account lifecycle of a driver, and work is routed by instance, "so two accounts using the same driver do not share mutable session or catalog state" (T2, `providers.md` lines 8-10). `ProviderDriver.create` builds a `ProviderInstance` that carries a snapshot, an optional auth controller, a text-generation service, and its `orchestrationAdapter`; the driver can also supply a usage reader ([`driver.ts:35-117`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/driver.ts#L35-L117)). Drivers reach the server only through `ProviderHost`: paths, settings, background demand, attachments, and stored credentials ([`ProviderHost.ts`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/ProviderHost.ts)). New drivers live in their own `packages/provider-<name>` package (T2, `adding-a-provider.md` lines 104-118).

The adapter is one Effect service, `ProviderAdapterV2`, with `getCapabilities`, `planSelectionTransition`, and a scoped `openSession` ([`ProviderAdapter.ts:697-713`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/ProviderAdapter.ts#L697-L713)). The session runtime it returns exposes primitives and an event stream: `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`, and optional extras such as `stopSubagent` and `hasPendingBackgroundWork` ([`:607-695`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/ProviderAdapter.ts#L607-L695)). Errors are one tagged union per operation, including `ProviderAdapterThreadInUseError` ("Starting a replacement would split the conversation, so callers must not fall back", `:238-254`) and `ProviderAdapterInterruptTimeoutError` ("its processes may still be running", `:364-377`).

Resume is not optional: "Provider-thread resumption is not a capability. It is a required adapter primitive. Adapters must be able to start from a stored provider cursor/session/thread handle or return a runtime resume failure" (T3, [`provider-capability-system.md:42`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/orchestration-v2/provider-capability-system.md#L42)).

### Shared and per-harness concerns

| Concern | Where it lives | Source |
| --- | --- | --- |
| Session start | Adapter `openSession`, with `resumeFromSession` and `initialNativeThreadId` inputs | `ProviderAdapter.ts:458-466` |
| Resume after restart | Adapter `resumeThread`; recovery and continuation policy in the orchestrator | `RestartContinuation.ts`, `ProviderRuntimeRecoveryService.ts` |
| Streaming events | One `ProviderAdapterV2Event` union for every adapter | `ProviderAdapter.ts:83-182` |
| Tool calls | Normalized into typed turn items by each adapter | `orchestrationV2.ts:1595-1810` |
| Permissions | Runtime requests answered through `respondToRuntimeRequest`; a mode is offered only where the provider enforces it | `adding-a-provider.md:22-37` |
| Interruption and steering | Adapter primitives; the choice between steer, queue, and interrupt-and-restart is made in `CommandPolicy` from capabilities | `CommandPolicy.ts:95-180`, `:257-278` |
| Token usage and cost | Per-driver readers of native history files | `usage.ts`, `Drivers/claudeUsage.ts`, `docs/user/usage.md` |
| Model listing | Driver snapshot and the model manifest; background checks open no session | `providers.md`, "Setup must not happen as a health-check side effect" |
| Auth | Per-instance `ProviderAuthController` | `auth.ts`, `driver.ts:54` |

## Transports and process lifecycle

- **Claude Code.** The Agent SDK `query()` with a streaming prompt queue, `includePartialMessages`, the `claude_code` preset system prompt with appended instructions, `permissionMode` from the runtime policy, and `pathToClaudeCodeExecutable` from the instance settings ([`ClaudeAdapterV2.ts:1750-1900`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1750-L1900)). t3code chooses the session ID: `allocateSessionId` draws a UUID (`:1170`), the first launch passes it as `sessionId`, and later launches pass it as `resume` (`:1803-1805`). The CLI runs under `/bin/sh` in a new process group with a fourth pipe as a lifeline: when that pipe, which only the server holds, reaches end of file, including after a server crash, the watcher sends TERM then KILL to the group, and on CLI exit the server kills the group to stop MCP grandchildren (`:359-396`). On Linux, `AgentScope` wraps the command in a systemd scope per thread for orphan cleanup and OOM attribution (T10; `ClaudeAdapterV2.ts:1195-1220`). The adapter keeps a stderr tail only until the first answer, because later stderr can hold private text (`:1222-1232`).
- **Codex.** `codex app-server` over stdio JSON-RPC ([`codexLaunchArgs.ts:12-15`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/provider/codexLaunchArgs.ts#L12-L15)), through an Effect client in its own package. Its schemas are generated from `openai/codex`'s app-server JSON schemas at a pinned upstream commit ([`generate.ts:16`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/effect-codex-app-server/scripts/generate.ts#L16)), and the package ships a mock peer, a replay module, and a bounded stderr tail with an error-line excerpt ([`_internal/stdio.ts:57-80`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/effect-codex-app-server/src/_internal/stdio.ts#L57-L80)). One app-server per instance serves several threads, inside a shared `AgentScope` ([`CodexAdapterV2.ts:1465-1493`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1465-L1493)).
- **Pi.** The user's own `pi` binary in `--mode rpc`, with `--session <path>` for native resume ([`mcpInjection.ts:266-272`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-pi/src/server/mcpInjection.ts#L266-L272)), framed by line feeds ([`rpc.ts:1`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-pi/src/server/rpc.ts#L1)) and stopped through its process group.
- **OpenCode.** The driver probes the installed version and runs a 1.x or 2.x runtime: a server per thread for 1.x, one server per instance for 2.x (T2, `providers.md` lines 14-26).
- **ACP agents** (Grok, Kiro, Antigravity, the ACP registry) share one ACP adapter with small per-agent flavors (T2, `adding-a-provider.md` lines 10-16).
- **Placement.** Provider processes always run on the machine whose t3 server owns the workspace. A remote machine runs its own server, and clients connect to it over authenticated RPC (T1, `overview.md` lines 3-14). No adapter talks to a harness over SSH.
- **Restart.** Processes don't outlive the server (the lifeline above). On startup, `ProviderRuntimeRecoveryService.reconcile` ends nonterminal runs, live requests, and sessions with "Cancelled because the server restarted before the provider work completed", except for runs with a replayable checkpoint, persisted questions, and delegated child threads ([`ProviderRuntimeRecoveryService.ts:206-278`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L206-L278)). `RestartContinuation` then starts a continuation run on the saved native thread with one harness-neutral prompt, at most three chained continuations in five minutes, and none for a settled thread or one with a pending runtime request ([`RestartContinuation.ts:33-84`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/RestartContinuation.ts#L33-L84)).
- **Session IDs.** App IDs are primary and provider IDs are references stored on provider session, thread, and turn records; adapters translate at the edge (T3, `README.md` invariants 1 and 6).

## Event normalization

- Adapters emit typed updates: `provider_session.updated`, `provider_thread.updated`, `node.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`, and `turn.terminal` with `completed`, `interrupted`, `cancelled`, or `failed` and a `threadDisposition` of `reusable` or `broken` ([`ProviderAdapter.ts:83-182`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/ProviderAdapter.ts#L83-L182)).
- Turn items are semantic, not raw tool names: `assistant_message` and `reasoning` with a `streaming` flag, `command_execution` with output and exit code, `file_change` with a diff, `file_search`, `web_search`, `approval_request`, `user_input_request`, `error`, `compaction`, `subagent`, and `dynamic_tool` ([`orchestrationV2.ts:1595-1810`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/contracts/src/orchestrationV2.ts#L1595-L1810)).
- Partial text updates the same item in place with `streaming: true`. Command output deltas go only to clients that show the row and aren't persisted (`ProviderAdapter.ts:137-144`).
- `EventSink` commits events, projections, the command receipt, and outbox effects in one database transaction; an effect worker performs provider side effects afterwards, and "Effects tied to a lost provider process cannot simply replay; recovery retires them before admitting new work" (T1, `overview.md` lines 45-60). Clients read projections as a snapshot plus a cursor.
- Raw provider frames are bounded diagnostics with a 64 KiB budget per payload, not durable state (T2, `providers.md` lines 149-158).

## Credentials and auth

- Subscriptions are the default. The README asks the user to run `claude auth login`, `codex login`, and the other CLIs' login commands before use (T1, `README.md` lines 13-23). A second account is a second instance with its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (T13, `providers-claude.md`; [`ClaudeHome.ts:33-46`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/provider/Drivers/ClaudeHome.ts#L33-L46)). API keys and routers go in the instance's environment variables (T13, `providers-claude.md`, "OpenRouter").
- A child's environment is the server's environment plus the instance's variables ([`instanceEnvironment.ts:8-30`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/instanceEnvironment.ts#L8-L30)). Each driver then removes what would leak: Claude drops the variables that would join the child to a parent Claude Code session (`ClaudeHome.ts:48-88`); managed Codex deletes inherited `OPENAI_API_KEY` and `OPENAI_BASE_URL` ([`CodexManagedRuntime.ts:116-124`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/provider/CodexManagedRuntime.ts#L116-L124)); Pi deletes inherited MCP credentials (`mcpInjection.ts:287-290`); OpenCode 2.x drops the inherited 1.x password variable (`OpenCode2Server.ts:42-47`). The checklist rule: "Remove ambient credentials the instance did not configure, so two instances cannot silently share an account or billing" (T2, `adding-a-provider.md` lines 41-43).
- Managed ChatGPT mode keeps the token off disk: a custom `model_provider` with an `auth` command that calls back into the t3 server over a private socket for a fresh token (`CodexManagedRuntime.ts:22-32`; `CodexManagedTokenBroker.ts`). The code notes that "Codex persists this provider ID in rollouts and needs it unchanged to resume" (`:25`).
- Each instance declares a **continuation identity**, such as `claude:home:<dir>` or `codex:home:<dir>`, which must match for a thread to resume on it ([`driver.ts:80-94`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/packages/provider-core/src/server/driver.ts#L80-L94); `ClaudeHome.ts:103-111`; `CodexHomeLayout.ts:61`, `:70`). What must stay the same across a resume is separate from the credential, which is resolved again.

## Interventions

- The choice between steering, queuing, and interrupt-and-restart is made once, in `CommandPolicy`, from the session's turn capabilities ([`CommandPolicy.ts:95-180`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/orchestration-v2/CommandPolicy.ts#L95-L180), `:257-278`). Each adapter declares flags such as `supportsActiveSteering`, `activeSteeringInterruptsTools`, and `supportsQueuedMessages` (`ClaudeAdapterV2.ts:415-425`).
- An interrupt completes only on the provider's terminal event. A provider that doesn't confirm in time yields `ProviderAdapterInterruptTimeoutError`, and the operator gets a force stop (`ProviderAdapter.ts:364-377`; T3, `testing-strategy.md`, test 4).
- Delivery is acknowledged by ID. Each prompt carries a UUID, and the Claude adapter binds results to prompts through `user_message_uuids` and `command_lifecycle` frames (`ClaudeAdapterV2.ts:4014-4045`, `:4422`).
- Permission and question prompts are durable runtime requests with a response capability of `live`, `message`, or `not_resumable`; answering is idempotent (T2, `providers.md`, "Protocol traps").
- The adapter contract and `CommandPolicy` have no hold: a run ends, and the thread waits for the person at the keyboard.

## Testing

- The rule: replace only the provider transport, and run the real orchestrator, adapter, normalizer, event store, and projections (T3, [`testing-strategy.md:7-60`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/orchestration-v2/testing-strategy.md#L7-L60)).
- A transcript is provider-neutral: `expect_outbound`, `emit_inbound`, and `runtime_exit` entries with protocol, version, model, and scenario metadata (`:62-105`). For Claude, the boundary is the SDK `query()` iterable: the transcript records the options sent and the `SDKMessage` chunks received (`:137-146`). A recorder per protocol lives in `apps/server/scripts/` (`record-claude-agent-sdk-replay-fixture.ts`, `record-codex-app-server-replay-fixture.ts`, `record-pi-rpc-replay-fixture.ts`, and the ACP recorders).
- Scenario directories hold one transcript per provider: `simple`, `multi_turn`, `queued_turn`, `message_steering`, `turn_interrupt`, `provider_thread_resume`, `multi_turn_restart`, plus provider-specific ones such as `claude_subagent_resume_after_restart` and `opencode2_resume_after_restart` (T12, `testkit/fixtures/`). Assertions read the final projection, for example "steering must attach to the active run" (`fixtures/message_steering/claude_output.ts`).
- Hand-written frames are discouraged: "A test that drives the adapter with hand-written frames is a guess about the protocol; live testing regularly finds what those guesses missed" (T2, `adding-a-provider.md` lines 64-66). Live tests against real binaries are welcome but "do not replace replays, because CI skips it" (lines 67-68).
- CI runs the server suite, replay integration tests included, in eight shards (T12, `ci.yml` lines 357-440). In the 30 days before this note, 38 commits touched the fixtures (T14).

## Other observations

- **Version policy.** `model-manifest.json` gives each driver semver ranges with a status (`supported`, `graceful`, `unsupported`, `broken`) and a recommended range, per t3 release range: Claude Code 2.1.280 and later is supported, 2.1.111 to 2.1.280 is graceful ([`model-manifest.json:26-34`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/server/src/provider/model-manifest.json#L26-L34)). `providerCompatibility.ts` turns this into an advisory; it doesn't refuse. The Agent SDK dependency is a caret range, `^0.3.316` (`apps/server/package.json:37`).
- **Updates** run only through the installer that provably owns the binary (T2, `providers.md`, "Provider updates run only through the owning installer").
- **Usage** is estimated from native history files and labeled "These estimates are not your subscription bill" (T13, `usage.md:13`). The Claude reader drops repeated `usage` objects that would overcount by about 2.4 times (`Drivers/claudeUsage.ts:18-22`).
- **Tools for agents.** One MCP endpoint per server exposes t3's orchestration to any harness. `delegate_task` creates a durable, app-owned child thread; `mode: "wait"` blocks with a timeout that doesn't cancel the child, and `clientRequestId` makes a retried call return the same work (T3, [`orchestrator-mcp-server.md:228-330`](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/orchestration-v2/orchestrator-mcp-server.md#L228-L330), `:535-551`). "Terminal provider events trigger finalization. The event stream first replays persisted events and then follows live events, so finalization also runs after a server restart" (`:510-513`).
- **Churn.** The Claude adapter took 144 commits and the Codex adapter 80 between 2026-10-06 and 2026-11-05, many of them lifecycle fixes such as "stopping a Claude turn no longer hangs without an acknowledgement" and "Claude subagents left by a stopped process no longer stay Running" (T14). Adapter bugs keep arriving; they stay inside the adapter and become fixtures.

## Comparison with usine

Each area ends with one verdict: usine already does this; t3code does it better, re-apply as described; or t3code differs for a reason that doesn't apply to a factory.

### Adapter boundary

**t3code does it better: re-apply the split, not the whole contract.** usine's `ChildBackendService.launch` returns a `RunningSession` with `events`, `result`, `steer`, `interrupt`, and `intervene` ([`runtime.ts:342-377`](../../packages/agents/src/runtime.ts)). Everything between launch and result is the adapter's business. The Claude adapter alone holds login retries ([`claude.ts:181`](../../packages/agents/src/harness/claude/claude.ts)), SSH transport-loss recovery with six relaunch delays (`:198`), its own continuation prompt (`:214`), and the resume loop (`:775-870`). The Codex adapter has a second resume path ([`codex.ts:381-476`](../../packages/agents/src/harness/codex/codex.ts)) with a second prompt (`:471`). PR #1000 adds a third in [`subagent.ts`](../../packages/durable/src/attempt/subagent.ts). What is shared today, [`session.ts`](../../packages/agents/src/harness/session.ts) and [`conversation.ts`](../../packages/agents/src/harness/conversation.ts), is the part that has not produced findings this week.

usine doesn't need t3code's forks, rollback, snapshots, or provider switching, which serve an interactive client. It needs the split: the adapter translates and the shared layer decides. Recommendations 2, 3, and 4.

### Process lifecycle and transport

**t3code differs because its harnesses never cross a network, but the principle applies: the owner of a harness process runs on the same machine.** t3code's lifeline, process group, and systemd scope all assume a local parent. usine starts harnesses from the orchestrator through `RemoteShell` ([`child-host.ts:28-52`](../../packages/agents/src/child-host/child-host.ts)) and has three answers to a lost connection: Claude stops the remote process through its PID file and relaunches with `resume` ([`claude.ts:118-139`](../../packages/agents/src/harness/claude/claude.ts), `:775-870`); Codex runs a detached supervisor on the worker that keeps the app-server and replays input over a replaceable relay ([`supervisor.ts`](../../packages/agents/src/harness/codex/supervisor.ts), [`remote.ts`](../../packages/agents/src/harness/codex/remote.ts), from #849) and leaves it running when the orchestrator stops ([`codex.ts:384`](../../packages/agents/src/harness/codex/codex.ts)); OpenCode in #1001 ran an HTTP server behind an SSH forward. Each has its own PID files, stderr policy, exit monitoring, and close. #1000's two app-servers and #1001's missing diagnostics and `ControlPath` come from that duplication. The Codex supervisor is the closest thing usine has to t3code's model and is the one to generalize. Recommendation 2.

### Resume after restart

**t3code does it better.** t3code makes resume a required primitive, ends all in-flight work at startup with one reason, and starts one continuation turn from a policy that knows about pending requests and caps chained continuations. usine, after #1000, resumes saved children inside the `subagent` tool and passes resume through `ChildRequest`, while each adapter keeps its own in-process resume. The #1000 findings (a failed resume counted as spawned, the whole prompt sent again, a held child given a turn, a decode failure as a defect) are policy bugs that one shared module would have once. The t3code invariant that a non-replayable effect is retired, not replayed, matches pi-durable's `replay: "unsafe"` ([`subagent.ts:391`](../../packages/durable/src/attempt/subagent.ts)). Recommendations 3 and 4.

### Event normalization

**usine already does this for the event vocabulary.** `AgentSessionEvent` is one union for every harness ([`core/agent/session.ts`](../../packages/core/src/agent/session.ts)), and each adapter has a codec. t3code goes further on tool calls: adapters emit semantic items (`command_execution`, `file_change`) instead of raw tool names, which the [harness adapter study](./harness-adapters.md#concern-by-harness) lists as a leak into the web. That is worth doing, but it isn't this week's struggle, so it isn't in the recommendations.

### Credentials and environment

**Mixed.** usine's gateway caller token ([ADR 0027](../adr/0027-gateway-credential-proxy.md)) is stronger than anything in t3code, whose closest mechanism is the managed Codex token broker. t3code inherits the server's environment and removes known leaks; usine builds a complete environment with nothing inherited ([`runtime.ts:49-56`](../../packages/agents/src/runtime.ts), ADR 0011). **For inheritance, t3code differs for a reason that doesn't apply:** a desktop app runs the user's tools as the user, and a factory runs untrusted work with scoped credentials.

**For scoping and resume, t3code does it better.** t3code applies an instance's variables to that harness's process only. usine merges every registered descriptor's wiring into the attempt environment ([`environment.ts:150-175`](../../packages/executor/src/ssh/gateway/environment.ts), [`api-keys.ts:59-110`](../../packages/executor/src/ssh/api-keys.ts)), which is how #1001's `XDG_DATA_HOME` reached Claude, Codex, and Pi children. t3code also separates a continuation identity from the credential. A usine saved session stores `gatewayCredential` from the original launch, which is #1000's stale credential kind. t3code's note that Codex needs the `model_provider` ID unchanged to resume suggests the same constraint for usine's gateway route, which writes a custom `model_provider` into `CODEX_HOME/config.toml`; the [0.164.0 probe](#codex-provider-continuation-probe-2026-11-05) below verifies its native behavior. #999's optional Promise callback is the same problem for the coordinator: the route should be a tagged value, as `CredentialRoute` already is for children ([`capability.ts:19-26`](../../packages/agents/src/harness/capability.ts)). Recommendation 5.

### Interventions

**usine already does this, with a hold that t3code doesn't need.** `sessionConversation` shares steer, interrupt, operator messages, holds, and release across adapters ([`conversation.ts`](../../packages/agents/src/harness/conversation.ts)). The hold exists because a parent waits for the child's report; t3code's runs end and wait for a person, so it has no hold. Approvals and permission modes are an interactive feature; usine runs `bypassPermissions` and `approvalPolicy: never` inside an isolated worker on purpose. The weak part is acknowledgement: Claude reports reads by subtracting `queued_turn_count` from the queue length ([`claude.ts:710-713`](../../packages/agents/src/harness/claude/claude.ts)), and #1001 keyed deliveries by text. Recommendation 4.

### Token usage and cost

**t3code differs for a reason that doesn't apply.** t3code shows estimates after the fact from native files. usine needs live tokens per session, billing pools, and plan windows for budgets ([ADR 0013](../adr/0013-cost-accounting-native-meters-guardrails.md), [`harness/usage.ts`](../../packages/agents/src/harness/usage.ts), [`claude/rate-limits.ts`](../../packages/agents/src/harness/claude/rate-limits.ts)). Keep usine's live meters. t3code's rule that quota errors are a usage limit with a reset time, not a generic failure, matches usine's `AgentCapacityError`.

### Model listing and preflight

**usine already does this.** Claude checks `supportedModels()` and Codex pages `model/list` at launch ([`claude.ts:394-406`](../../packages/agents/src/harness/claude/claude.ts), [`codex.ts:116-145`](../../packages/agents/src/harness/codex/codex.ts)). t3code's rule that a background check must not open a session applies to usine's Pi preflight, which starts a Pi SDK session (see the [harness adapter study](./harness-adapters.md#concern-by-harness)); it's a small point.

### Versions and protocol types

**Codex protocol: usine already does this.** t3code generates schemas from upstream at a pinned commit; usine copies the request types and fails `pnpm check` on drift ([`protocol/codex.ts:5-11`](../../packages/agents/src/protocol/codex.ts)). **Harness versions: t3code differs.** Ranges with statuses sit between usine's exact Codex pin and the owner's decision to accept any Claude Code version (decision 8 in the [harness adapter study](./harness-adapters.md#decisions-owner-2026-11-04)). It is an option if version skew becomes a problem; it isn't one now.

### Testing

**t3code does it better.** usine's adapter tests drive hand-scripted fakes (`scripted` in [`test/pi/claude.test.ts:154`](../../packages/agents/test/pi/claude.test.ts), and the Codex tests in `test/pi/codex/`). The live contract suite ([`test/integration/contract.ts`](../../packages/agents/test/integration/contract.ts)) is excluded from `test` ([`package.json:73`](../../packages/agents/package.json)) and runs in no workflow, which reviewers flagged on both #1000 and #1001. The seams for replay already exist: `ClaudeSdk` is a layer ([`claude/sdk.ts`](../../packages/agents/src/harness/claude/sdk.ts)) and `CodexAppServer` is a service ([`codex/connection.ts`](../../packages/agents/src/harness/codex/connection.ts)). Recommendation 1.

### Pi children

**t3code does it better for children.** t3code runs Pi as `pi --mode rpc --session <path>`, a subprocess like any other harness. usine runs Pi children in the orchestrator through the SDK, which is why its descriptor refuses every placement but local ("Pi runs its tools in the orchestrator process", [`pi/descriptor.ts:61`](../../packages/agents/src/harness/pi/descriptor.ts)) and why the local-only rule was enforced in five files. The coordinator stays in-process because pi-durable needs it there. Recommendation 6.

### Tools for the coordinator and supervisor

**t3code does it better for a harness that is not Pi.** usine exposes `subagent` only as a pi-durable tool. The [harness adapter study](./harness-adapters.md#a-durable-coordinator-on-another-harness) estimates four to six pull requests for a journaled coordinator on a vendor harness. t3code shows the shape: the delegation is a durable record owned by the app, the tool call is idempotent by client request ID, a wait can time out without cancelling, and finalization replays after restart. The harness then needs only native resume and a continuation turn, which recommendations 3 and 4 provide. Recommendation 7.

## Scope differences

| t3code | usine | Does it explain a divergence? |
| --- | --- | --- |
| One person at the keyboard answers prompts and presses Stop | Unattended attempts; an operator steps in rarely | Yes for approvals, permission modes, forks, rollback, and provider switching: don't copy. Yes for holds: usine-only. |
| Harnesses run on the machine whose server owns the workspace | The orchestrator drives harnesses on SSH workers, containers, and sandboxes | Yes for the transport. It's the reason to put a process owner on the worker (recommendation 2). |
| The user's repositories are trusted; Claude settings resolve from user, project, and local sources (`ClaudeAdapterV2.ts:4897`), and project skills load (`providers-claude.md`, "Skills") | Worktrees are untrusted; `settingSources: ["user"]` ([`claude.ts:162`](../../packages/agents/src/harness/claude/claude.ts)) and a Codex trust override | Yes. Keep usine's choice. |
| Children inherit the server's environment | A complete environment per attempt, nothing inherited (ADR 0011) | Yes for inheritance. No for scoping wiring per harness (recommendation 5). |
| Usage is an estimate for the user | Pools, budgets, and plan windows drive admission | Yes. Keep usine's live meters. |
| Processes die with the server, and a continuation turn resumes the thread | After #1000, children resume after a restart too | No. The same problem, so the same answer (recommendation 3). |
| Many providers, added by a team with replay fixtures | Few harnesses, added by factory agents with review rounds | No. Replay tests matter more for agent-written adapters (recommendation 1). |

## Recommendations

### 1. Replay tests at the transport boundary, in CI

Record real harness traffic at the boundary usine already injects: the `ClaudeSdk` query iterable and options, the Codex app-server JSON-RPC lines, and later the OpenCode HTTP and SSE exchange. Replay it through the real adapter, `sessionConversation`, `sessionChannel`, and, for restart cases, the durable `subagent` tool against SQLite. Keep shared scenarios with one transcript per harness: a simple turn, a steer during a turn, an operator message queued during a tool call, interrupt then guidance, hold and release, a lost transport, a resume after restart, a resume after the credential kind changed, and a process that exits before its first message. Turn the live contract suite into the recorder. Each lifecycle bug found in review adds a transcript.

- t3code: `testing-strategy.md:7-146`, `adding-a-provider.md:51-68`, `testkit/fixtures/`, `apps/server/scripts/record-*-replay-fixture.ts`.
- usine files: `packages/agents/test/integration/contract.ts`, `packages/agents/test/pi/claude.test.ts`, `packages/agents/test/pi/codex/codex.test.ts`, a new `packages/agents/test/replay/`, `packages/agents/package.json`, and the durable restart tests in `packages/durable/test/`.
- Effect: the failure classes in #1000 and #1001 (resume paths, interrupt, transport) run on every pull request instead of being found by a reviewer, and a factory agent writing an adapter gets protocol evidence instead of writing fakes that encode its own guesses.

### 2. One process owner on the worker, with a lease

Generalize the Codex supervisor and relay into a harness-neutral process in `child-host/`: it starts the harness command in its own process group on the worker, keeps a bounded stderr tail and the exit code, replays unacknowledged input over a replaceable SSH relay, and stops the group when no relay has attached for a lease period. Give each child one stable PID file, not one per launch. Back Claude's `spawnClaudeCodeProcess` with it, so Claude stops relaunching on transport loss, and use it for any later stdio or HTTP harness. Locally, apply t3code's lifeline: the child dies when the orchestrator's end of a pipe closes.

- t3code: `ClaudeAdapterV2.ts:359-396` (lifeline and process group), `_internal/stdio.ts:57-80` (stderr tail), `AgentScope.ts` (scope per thread).
- usine files: `packages/agents/src/harness/codex/supervisor.ts` and `remote.ts` (moved into `packages/agents/src/child-host/`), `packages/agents/src/harness/claude/claude.ts` (`sshSpawner`, `stopRemote`, `RESUME_DELAYS`, the resume loop), `packages/agents/src/harness/codex/codex.ts` and `app-server.ts` (the `-resume` session ID and "left for reattachment"), and `packages/agents/src/child-host/child-host.ts` (`childPidFile`, `CHILD_STOP_SCRIPT`).
- Effect: one implementation of spawn, stderr, exit, close, and kill instead of one per adapter. #1000's two app-servers, #1001's lost diagnostics, and the SSH forward findings have no place to recur, and a process left by a crashed orchestrator ends when its lease runs out instead of at attempt cleanup.

### 3. One continuation policy above the adapters

Make `resume(ref)` a required adapter primitive that only reopens the native session and reports whether it found it. Move the decisions into one shared module used by both in-process recovery and restart recovery: which sessions to continue (not paused, idle, or held ones), the single continuation message, unread operator messages to deliver, tool calls in flight to close as errors, a cap on chained continuations in a time window, and the outcome when resume fails (an interrupted result that does not count as a spawn). Use the same message for Claude, Codex, Pi, and the durable resume.

- t3code: `provider-capability-system.md:42`, `RestartContinuation.ts:33-84`, `ProviderRuntimeRecoveryService.ts:206-278`.
- usine files: `packages/agents/src/harness/claude/claude.ts` (`RESUME_PROMPT`, `resume`), `packages/agents/src/harness/codex/codex.ts` (`resume`), `packages/agents/src/harness/conversation.ts`, `packages/agents/src/runtime.ts` (`RunningSession`, `ChildRequest`), `packages/durable/src/attempt/subagent.ts`.
- Effect: three continuation prompts become one, and the #1000 policy findings (spawn accounting on a failed resume, the full prompt sent again, a held child given a turn, a decode failure as a defect) are fixed once for every harness. A new harness gets correct resume behavior by implementing one primitive.

### 4. usine assigns native session IDs and operator message IDs

Pass a usine-generated UUID as Claude's `sessionId` on the first launch and record the native reference before the first prompt is sent, instead of waiting for the `init` message ([`claude.ts:675-690`](../../packages/agents/src/harness/claude/claude.ts)). Give each operator message an ID, set it as `uuid` on the Claude `SDKUserMessage`, and acknowledge delivery by matching `user_message_uuids`; for Codex, match the user-message items the app-server echoes; for OpenCode, use its message ID. `conversation.ts` then reports reads by ID instead of by count. All three fields are in the SDK types usine has installed (U5).

- t3code: `ClaudeAdapterV2.ts:1170`, `:1803-1805` (session ID), `:4014-4045`, `:4422` (prompt UUIDs).
- usine files: `packages/agents/src/harness/claude/sdk.ts` (`userMessage`), `packages/agents/src/harness/claude/claude.ts`, `packages/agents/src/harness/codex/codex.ts`, `packages/agents/src/harness/conversation.ts` (`QueuedMessage`, `read`), `packages/core/src/attempt/channel.ts` (operator action IDs), `packages/core/src/agent/session.ts` (`HarnessSession`).
- Effect: a child that dies before `init` can still be resumed, Claude's arithmetic on `queued_turn_count` goes away, and delivery keyed by text (#1001) can't happen in a new adapter.

### 5. Harness-scoped environments and a credential route resolved at every launch

Build a harness process's environment from the attempt's base environment plus the launched harness's own wiring only, never the wiring of every registered descriptor. Split what a saved session keeps into a continuation identity (harness, home location, Codex `model_provider` ID, native session reference) and leave the credential route out of it: resolve the route and admit it at every launch, including a resume after restart, and refuse a resume whose continuation identity no longer matches. Model the coordinator's route as the same tagged `CredentialRoute`, not an optional callback.

- t3code: `instanceEnvironment.ts:8-30`, `CodexManagedRuntime.ts:22-32` and `:116-124`, `driver.ts:80-94`, `CodexHomeLayout.ts:61`, `adding-a-provider.md:41-43`.
- usine files: `packages/executor/src/ssh/gateway/environment.ts` (`gatewayWirings`), `packages/executor/src/ssh/api-keys.ts`, `packages/agents/src/harness/harness.ts` (`CredentialWiring`), `packages/agents/src/harness/launch.ts` (`childAdmissionContext`), `packages/agents/src/runtime.ts` (`ChildRequest.environment`), `packages/durable/src/attempt/subagent.ts` (saved child), `packages/durable/src/attempt/parent.ts`.
- Effect: removes the class of #1001's P1 (one harness's variables in every child and tool command) and #1000's stale credential kind, and gives #999's coordinator route the shape children already use.

### 6. Pi children as `pi --mode rpc` processes on the worker

Run Pi children as the `pi` CLI in RPC mode with `--session <path>` through `ChildHost`, like Claude Code and Codex, instead of in the orchestrator's process. Keep the Pi coordinator in-process for pi-durable. Install `pi` in the worker image from the descriptor.

- t3code: `mcpInjection.ts:266-272`, `rpc.ts`.
- usine files: `packages/agents/src/harness/pi/pi.ts`, `pi/sdk.ts`, `pi/descriptor.ts` (placements and `placementReason`), `pi/preflight.ts`, and the image inputs generated from descriptors.
- Effect: Pi children run on SSH and container workers, the last in-process child disappears, and Pi child sessions use the same transport, process owner, and replay tests as the other harnesses.

### 7. usine tools over one MCP endpoint with idempotent delegation

Expose usine's tools, starting with delegation, through one authenticated MCP endpoint per session. Make delegation a durable record that usine owns, idempotent by a client request ID, with a wait that can time out without cancelling the child and a status call to poll. Finalize from the persisted record after a restart. Build the supervisor ([#799](https://github.com/basaltbytes/usine/issues/799)) on it, and use it if a coordinator on Claude Code or Codex is ever wanted.

- t3code: `orchestrator-mcp-server.md:228-330`, `:488-551`.
- usine files: `packages/durable/src/attempt/subagent.ts` (delegation logic to share), a new MCP surface beside the operator API in `apps/server/`, and the `usine-tools` capability in `packages/agents/src/harness/capability.ts`.
- Effect: the supervisor gets usine's tools without a per-harness tool bridge, and the journaled coordinator decorator (step 11 of the [harness adapter plan](./harness-adapters.md#migration-plan)) shrinks to recommendations 3 and 4 plus this endpoint. It doesn't address this week's findings directly, so it comes last.


## Codex provider continuation probe (2026-11-05)

Codex CLI 0.164.0 does **not** require the same `model_provider` ID for a native `thread/resume`. A local app-server probe created a persistent thread with `model_provider = "usine-gateway"` in an isolated `CODEX_HOME/config.toml`. Both provider entries used a loopback endpoint at port 9, with `requires_openai_auth = false`, so the probe used no provider credential or model response. `thread/start` followed by `turn/start` committed the native rollout and its user message.

After stopping that app-server process, a new process resumed the saved thread with the original configuration. The response reported the same thread ID and `modelProvider: "usine-gateway"`. After another process restart with `-c 'model_provider="changed"'`, `thread/resume` with the same thread ID succeeded and reported `modelProvider: "changed"`. Changing the provider on an already loaded thread did not change its reported provider; separate process restarts are necessary to exercise the saved-session case.

Usine treats the provider ID as part of its continuation identity and refuses a changed ID before sending another turn. This prevents an orchestrator restart from silently changing the configured provider for an existing child. A gateway credential change between `subscription` and `api-key` keeps `model_provider = "usine-gateway"` and the same `CODEX_HOME`; the child resolves its new credential kind at launch. The continuation record stores the provider ID, native session reference, and home separately from credential and billing metadata.
