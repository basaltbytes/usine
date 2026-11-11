# Harness adapters

This report maps how usine handles coding-agent harnesses and proposes one abstraction, so that adding or switching a harness (Claude Code, Codex, Pi, and later OpenCode) is a new module and one registration line. Read on 2026-11-04 against usine commit `9132a5b09a30e4d41f04f8042cbb39c7b1e3be6b`, with `@anthropic-ai/claude-agent-sdk` 0.3.311, `@pwrdrvr/codex-app-server-protocol` 0.164.0, and Pi and pi-durable 1.4.0 as pinned in `packages/*/package.json`.

It builds on [Model access for parents and children](./model-access.md), which compares parent harnesses and proposes the `ModelAccess` port. That report covers credential admission. This one covers everything else a harness brings: launch, recovery, interventions, events, preflight, installation, credential wiring, usage, and placement.

Two terms are used throughout:

- A **harness** is the CLI or SDK that runs a session: Claude Code, Codex, Pi, OpenCode.
- A **model route** is the model the harness calls and the credential that pays for it: a Claude model on a Claude plan, a GPT model on an API key, GLM or Qwen on an OpenAI-compatible endpoint.

A **brain** (`BrainSpec`) names both today, as `harness`, `model`, and `effort` ([`brain.ts:22-32`](../../packages/core/src/agent/brain.ts)), but each harness interprets `model` differently: Pi reads `provider/model`, Claude Code and Codex read a bare model ID.

## Summary

- Harness-specific logic lives in the three backend folders under `packages/agents/src/pi/` and in about 40 other files across 8 packages and `infra/`. Outside the backends there are 12 branches on the harness name in 10 files, 6 tables keyed by `Harness`, and 6 tables keyed by gateway provider that are harness tables in practice, because the gateway assumes `anthropic` means Claude Code and `openai` means Codex.
- The worst offenders are `packages/executor/src/ssh/gateway/preflight.ts` (four harness switches and a per-harness login table), the billing-pool rule (split across six files, with two different rules for the Pi parent's pool), and the rule that Pi children run only on local workers (enforced separately in five files, each with its own message).
- The shared seams that exist are good: `ChildBackendService` and `RunningSession` ([`runtime.ts:330-370`](../../packages/agents/src/runtime.ts)) for children, `AgentSessionEvent` for transcripts, `HarnessReadiness` for preflight results, and a live contract suite shared by the three backends (`packages/agents/test/integration/contract.ts`). The design keeps them and moves the rest behind them.
- The proposal: a **harness descriptor** (platform-free data and pure functions) and a **harness runtime** (`preflight` and `launch`) per harness, registered in one list; a capability set per harness and credential route; and **roles** that declare required capabilities, validated by one function at configuration load, at preflight, and at launch.

## Current state

### Concern by harness

"Shared" means the concern sits behind an interface that the caller uses without naming a harness. "Scattered" means a caller outside the harness's module branches on the harness or keeps a per-harness table.

| Concern | Claude Code child | Codex child | Pi child | Pi parent | Shared or scattered |
| --- | --- | --- | --- | --- | --- |
| Launch | `claudeChildBackendLayer`, [`claude/claude.ts:905-907`](../../packages/agents/src/pi/claude/claude.ts); options at `:142-165` | `codexChildBackendLayer`, [`codex/codex.ts:83-230`](../../packages/agents/src/pi/codex/codex.ts) | `piChildBackendLayer`, [`pi/pi.ts:56-197`](../../packages/agents/src/pi/pi.ts) | `resolveParent`, [`durable/src/attempt/parent.ts:99-155`](../../packages/durable/src/attempt/parent.ts); model runtime in [`live.ts:20-57`](../../packages/durable/src/live.ts) | Children share `ChildBackendService`, but three tags ([`runtime.ts:394-407`](../../packages/agents/src/runtime.ts)) and a `switch` ([`pi/children.ts:15-22`](../../packages/agents/src/pi/children.ts)) select them, and [`durable/src/live.ts:68-75`](../../packages/durable/src/live.ts) wires all three. The parent is outside the seam. |
| Resume or reattach after an orchestrator restart | Not resumed: the `subagent` call ends as interrupted ([`subagent.ts:95-96`](../../packages/durable/src/attempt/subagent.ts), `replay: "unsafe"` at `:368`) | Same | Same | pi-durable resumes the task ([`attempt/runtime.ts:62`](../../packages/durable/src/attempt/runtime.ts)) | Shared, through the `subagent` tool. |
| Recovery from transport loss while the orchestrator runs | Stops the remote process and relaunches with `resume`, up to six tries ([`claude.ts:189-201`](../../packages/agents/src/pi/claude/claude.ts), `:752-863`) | A detached remote supervisor keeps the app-server alive and replays input ([`codex/remote.ts:31`](../../packages/agents/src/pi/codex/remote.ts), [`supervisor.ts`](../../packages/agents/src/pi/codex/supervisor.ts)); one `thread/resume` if the process is lost ([`codex.ts:370-420`](../../packages/agents/src/pi/codex/codex.ts)) | None: sessions are in memory ([`pi/sdk.ts:187`](../../packages/agents/src/pi/sdk.ts)), and children are local | Not applicable | Private to each backend, which is the right place. The capability isn't declared anywhere, so nothing outside can ask for it. |
| Operator handoff (resume from a terminal) | `HarnessSession` recorded ([`claude.ts:653`](../../packages/agents/src/pi/claude/claude.ts)); `claude --resume` | `HarnessSession` with `CODEX_HOME` ([`codex.ts:206-215`](../../packages/agents/src/pi/codex/codex.ts)); `codex resume --` | None | None | Scattered: `RESUME_COMMANDS` ([`apps/web/.../handoff.tsx:18-23`](../../apps/web/src/components/runs/transcript/handoff.tsx)); a Codex-behind-gateway special case ([`resume-details.tsx:17-22`](../../apps/web/src/features/runs/components/outline/resume-details.tsx)). |
| Interventions (steer, interrupt, operator message) | [`claude.ts:867-896`](../../packages/agents/src/pi/claude/claude.ts) | `turn/interrupt` and `turn/steer` ([`codex.ts:315`](../../packages/agents/src/pi/codex/codex.ts), `:347`) | Pause gate and Pi steering ([`pi/turns.ts`](../../packages/agents/src/pi/turns.ts)) | pi-durable conversation abort and steer ([`attempt/runtime.ts:432`](../../packages/durable/src/attempt/runtime.ts), `:487`) | Shared: `RunningSession.steer`, `interrupt`, `intervene` ([`runtime.ts:330-357`](../../packages/agents/src/runtime.ts)). |
| Transcript and event mapping | [`claude/codec.ts`](../../packages/agents/src/pi/claude/codec.ts) | [`codex/codec.ts`](../../packages/agents/src/pi/codex/codec.ts) | [`pi/session.ts`](../../packages/agents/src/pi/session.ts) | [`durable/src/attempt/events.ts`](../../packages/durable/src/attempt/events.ts) | Shared: `AgentSessionEvent` ([`core/agent/session.ts:335-348`](../../packages/core/src/agent/session.ts)). Leaks: raw tool names reach the web, which maps them per harness ([`tool/presentation.ts:36-62`](../../apps/web/src/lib/runs/transcript/tool/presentation.ts), payload shapes at [`sections.ts:50`](../../apps/web/src/lib/runs/transcript/tool/sections.ts)). |
| Preflight and version check | `claude --version` exits 0 and `claude auth status --json` reports a `claude.ai` first-party login ([`preflight.ts:94-124`](../../packages/agents/src/preflight/preflight.ts)); no version pin | Exact versions ([`preflight.ts:16-41`](../../packages/agents/src/preflight/preflight.ts)), Node on remote hosts, `account/read` ([`:74-93`](../../packages/agents/src/preflight/preflight.ts)) | Starts a Pi SDK session to check the model and API key ([`:125-162`](../../packages/agents/src/preflight/preflight.ts)) | Not preflighted: checked when an attempt starts ([`parent.ts:99`](../../packages/durable/src/attempt/parent.ts); [agents reference](../../apps/docs/src/content/docs/reference/configuration/agents.md), "Parent selection") | Scattered: one `switch` in `verifyHarness`, a second binary-only probe for gateway and API-key workers ([`ssh/gateway/preflight.ts:275-311`](../../packages/executor/src/ssh/gateway/preflight.ts)), a third version probe that reimplements the Codex version rule ([`cloudflare/cloudflare.ts:182-224`](../../packages/executor/src/cloudflare/cloudflare.ts)), the Pi exclusion in [`ssh/ssh.ts:98-113`](../../packages/executor/src/ssh/ssh.ts), and the Claude lock branch in [`harness-preflight.ts:39-44`](../../packages/executor/src/harness-preflight.ts). |
| Worker installation | `@anthropic-ai/claude-code@2.1.311` | `@openai/codex@0.164.0`, plus Node | Nothing on the worker: the Pi SDK runs in the orchestrator | Same as Pi child | Scattered: [`infra/worker-image/Dockerfile:13-14`](../../infra/worker-image/Dockerfile), `:37-38`; [`infra/hetzner/cloud-init.yaml:110`](../../infra/hetzner/cloud-init.yaml); [`packages/cloudflare/image/Dockerfile:21`](../../packages/cloudflare/image/Dockerfile); the image tag in [`ssh/container.ts:38-40`](../../packages/executor/src/ssh/container.ts); `CODEX_CLI_VERSION` in [`preflight.ts:17`](../../packages/agents/src/preflight/preflight.ts). `packages/agents/test/preflight.test.ts:171-172` keeps the Dockerfile and preflight in step. [`packages/cloudflare/README.md:59`](../../packages/cloudflare/README.md) already says 2.1.308 while the image installs 2.1.311. |
| Credentials and login brokering | Worker login, gateway API key or subscription token, provisioner key, or Cloudflare key; `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` behind a gateway | Worker ChatGPT login, gateway API key or ChatGPT login, provisioner key, or Cloudflare key; a written `CODEX_HOME/config.toml` with a custom `model_provider` | `~/.pi/agent` of the orchestrator user | Same as Pi child | Scattered. Harness-to-provider tables: [`ssh/api-keys.ts:13-17`](../../packages/executor/src/ssh/api-keys.ts), [`cloudflare/cloudflare.ts:101-110`](../../packages/executor/src/cloudflare/cloudflare.ts), `LOGINS` and `gatewayCredentialFor` in [`ssh/gateway/preflight.ts:138-150`](../../packages/executor/src/ssh/gateway/preflight.ts) and `:321-343`. Environment: [`ssh/gateway/environment.ts:18-27`](../../packages/executor/src/ssh/gateway/environment.ts), `:53-60`, `:188-200`; [`ssh/api-keys.ts:26-36`](../../packages/executor/src/ssh/api-keys.ts); [`packages/cloudflare/src/api/harness.ts:44-52`](../../packages/cloudflare/src/api/harness.ts); Claude variables for every harness in [`child-environment.ts:32-33`](../../packages/executor/src/child-environment.ts). Login files: [`remote/container.ts:117-124`](../../packages/executor/src/remote/container.ts). Codex homes: [`ssh/codex-homes.ts`](../../packages/executor/src/ssh/codex-homes.ts), [`ssh/worker-records.ts`](../../packages/executor/src/ssh/worker-records.ts), [`ssh/gateway/attachments.ts:154-155`](../../packages/executor/src/ssh/gateway/attachments.ts), [`ssh/provisioner/reset.ts:63`](../../packages/executor/src/ssh/provisioner/reset.ts). Claude login lock: [`runtime.ts:372-392`](../../packages/agents/src/runtime.ts), [`executor/src/claude-login-lock.ts`](../../packages/executor/src/claude-login-lock.ts). Gateway routes "Claude Code and Codex call": [`gateway/src/llm/llm.ts:145-158`](../../packages/gateway/src/llm/llm.ts), [`cloudflare/src/sandbox/outbound.ts:161-173`](../../packages/cloudflare/src/sandbox/outbound.ts). Egress hosts: [`infra/hetzner/gateway/egress-allowlist:14-22`](../../infra/hetzner/gateway/egress-allowlist). |
| Billing pool | `apiKeys` with an injected API key, else `claudePlan` | `apiKeys` with an injected API key, else `chatgptPlan`; verifies a ChatGPT login without a gateway ([`codex/account.ts:35-87`](../../packages/agents/src/pi/codex/account.ts)) | `apiKeys` only; refuses others ([`pi/pi.ts:108-145`](../../packages/agents/src/pi/pi.ts)) | `apiKeys`, or `chatgptPlan` for `openai-codex` ([`parent.ts:125-152`](../../packages/durable/src/attempt/parent.ts), [`pi/authentication.ts:39-57`](../../packages/agents/src/pi/authentication.ts)) | Scattered: `brainPool` switches on the harness ([`session.ts:233-245`](../../packages/core/src/agent/session.ts)); the SSH executor adds a provisioner-key rule ([`ssh/ssh.ts:329-339`](../../packages/executor/src/ssh/ssh.ts)). The parent's pool is resolved from its authentication at start, then derived again from the model prefix for accounting (`session.ts:242-252`): two rules for one fact. |
| Usage and rate-limit reporting | Tokens and USD from the SDK ([`pi/usage.ts:73-130`](../../packages/agents/src/pi/usage.ts)); `rate_limit_event` is read only as evidence of a working login ([`claude/codec.ts:111-113`](../../packages/agents/src/pi/claude/codec.ts)) | Token breakdown ([`pi/usage.ts:132-142`](../../packages/agents/src/pi/usage.ts)); the only producer of `PoolRateLimitsUpdated` ([`codex.ts:591-613`](../../packages/agents/src/pi/codex/codex.ts)) | Tokens and USD per message ([`pi/usage.ts:27-41`](../../packages/agents/src/pi/usage.ts)) | Same as Pi child | Events are shared; which harness reports what is undeclared. |
| Cost pricing | SDK figure | OpenAI price table ([`agents/src/openai-prices.ts`](../../packages/agents/src/openai-prices.ts)) applied at read time | Pi catalog figure | Same as Pi child | Scattered: the orchestrator branches on `harness === "codex"` ([`operator/usage.ts:134-142`](../../packages/orchestrator/src/operator/usage.ts), `:178-186`). |
| Remote versus local worker | SSH spawner ([`claude.ts:108-138`](../../packages/agents/src/pi/claude/claude.ts)) | SSH app-server command ([`codex/app-server.ts:94-150`](../../packages/agents/src/pi/codex/app-server.ts)) | Local only | Orchestrator only | Scattered: "Pi children run only on local workers" is enforced in [`pi/pi.ts:69-78`](../../packages/agents/src/pi/pi.ts), [`preflight.ts:125-131`](../../packages/agents/src/preflight/preflight.ts), [`ssh/provisioner/checks.ts:43-44`](../../packages/executor/src/ssh/provisioner/checks.ts), [`cloudflare/cloudflare.ts:133-141`](../../packages/executor/src/cloudflare/cloudflare.ts), and implied by `pi: Option.none()` in [`ssh/api-keys.ts:12-16`](../../packages/executor/src/ssh/api-keys.ts). |
| Container or sandbox needs | `bypassPermissions`, user settings only ([`claude.ts:146-158`](../../packages/agents/src/pi/claude/claude.ts)); login files mounted read-write | `approvalPolicy: never`, `danger-full-access`, trust override ([`codex/app-server.ts:69-92`](../../packages/agents/src/pi/codex/app-server.ts)); per-attempt `CODEX_HOME` | Project settings untrusted ([`pi/sdk.ts:163-178`](../../packages/agents/src/pi/sdk.ts)) | Same | Launch options are private to each backend, which is right. The files and directories the executor must prepare are scattered (see credentials). |
| Display | "Claude Code" | "Codex" | "Pi" | "Pi" | Scattered: [`configuration/strings.ts:16-20`](../../apps/web/src/features/configuration/strings.ts); the server lists `HARNESSES` ([`apps/server/src/http.ts:429`](../../apps/server/src/http.ts)). |

### Roles that run a model

| Role | Requires | Harnesses accepted today | Recorded reason |
| --- | --- | --- | --- |
| Attempt coordinator (Pi parent) | Runs in the orchestrator; survives a restart step by step; one `subagent` tool; steer, interrupt, holds, and release; a child-session budget | Pi only, hard-coded (`harness: "pi"` in [`parent.ts:38`](../../packages/durable/src/attempt/parent.ts)); `apiKeys` or `chatgptPlan` | [ADR 0005](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0005-pi-parent-agent-layer-team-roster.md): a Pi parent orchestrates real harness sessions through one adapter. Its #176 amendment: pi-durable commits each turn and tool call, so a restart continues the attempt. [ADR 0013](../adr/0013-cost-accounting-native-meters-guardrails.md): the pool follows the credential. A Claude plan is out of reach because Anthropic's terms allow subscription use only through the unmodified Claude Code client ([ADR 0027](../adr/0027-gateway-credential-proxy.md), amendment of 2026-10-26; [model-access.md](./model-access.md)). |
| Attempt child (coding agent) | Runs where the worker is (local process, SSH, container, Cloudflare sandbox); steer and interrupt; reports through the marker protocol | `claude` and `codex` on every worker kind; `pi` on local workers only, API keys only | Pi local-only: tools run in the orchestrator process ([`pi/pi.ts:76`](../../packages/agents/src/pi/pi.ts); [ADR 0006](../adr/0006-executor-prepares-checkouts-runs-children-on-workers.md)). Pi API-key-only: stated in [ADR 0021](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0021-pi-parent-pool-follows-authentication.md) without a reason; [#941](https://github.com/basaltbytes/usine/issues/941) calls it a leftover. Claude without a gateway or key needs a subscription login ([`preflight.ts:114-122`](../../packages/agents/src/preflight/preflight.ts)), and Codex needs a ChatGPT login and refuses an API-key login file ([`codex/account.ts:49-56`](../../packages/agents/src/pi/codex/account.ts)): both from [ADR 0013](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0013-cost-accounting-native-meters-guardrails.md), which tied the plan pools to those logins. |
| Supervisor ([#799](https://github.com/basaltbytes/usine/issues/799), planned) | usine's tool surface as tools; a conversation that survives a restart; member-scoped operator actions | Not built. The owner decided on 2026-11-02 that it runs as a Claude Code or Codex session through gateway logins. | Recorded in the owner's decision log and #799 ("No second model-calling path"), not in an ADR. The reason: a raw Pi request can't bill the Claude plan ([model-access.md](./model-access.md)). |
| Walkthrough Q&A ([#859](https://github.com/basaltbytes/usine/issues/859), planned) | A turn in the supervisor conversation; may start an attempt at a commit | Same as supervisor | #859: questions need the factory's context, which the supervisor holds. It isn't a separate role. |

No other code path calls a model: reviews, triage, and fixes are loops, so they run as attempts. Every place that runs a model has its own rules, and each rule is checked only where it refuses. [#939](https://github.com/basaltbytes/usine/issues/939) is one example: a quickstart attempt failed on a Pi child that [ADR 0021](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0021-pi-parent-pool-follows-authentication.md) forbade, which no configuration check would have caught.

## Harness capabilities from primary sources

Each vendor claim below comes from the vendor's documentation, repository, or the installed package. Paths under `node_modules/` refer to the main checkout's `node_modules/.pnpm/`. Claude entries use the installed `@anthropic-ai/claude-agent-sdk` 0.3.308 types (usine pins 0.3.311), and Codex entries use the installed app-server protocol types 0.159.2 (usine pins 0.164.0, which isn't installed in the main checkout). OpenCode entries cite `anomalyco/opencode`, which `sst/opencode` now redirects to.

| Capability | Claude Code | Codex app-server | Pi (pi-coding-agent) | Pi with pi-durable | OpenCode 1.x (`opencode-ai` 1.19.5) | OpenCode 2.x (`@opencode/cli` 2.2.5) |
| --- | --- | --- | --- | --- | --- | --- |
| Headless control | `query()` driving the CLI subprocess | JSON-RPC over stdio | In-process SDK; `--mode json` and `--mode rpc` | In-process `Harness` | `opencode serve` (HTTP and OpenAPI), `@opencode-ai/sdk`, `run --format json`, `opencode acp` over stdio | `serve`, in-process `@opencode/sdk`, `run`, ACP |
| Event stream | `SDKMessage` iterator | Notifications | `session.subscribe` | Durable watch | SSE `GET /event` | Live `GET /api/event`, plus a durable per-session log with replay after a sequence number |
| Resume a saved conversation after the process ends | `resume` by session ID; transcripts under `~/.claude/projects/` ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)) | `thread/resume` from rollouts under `$CODEX_HOME/sessions/` | `SessionManager` files under `~/.pi/agent/sessions/`; usine uses `SessionManager.inMemory` | Yes | `--session` or `--continue`; run status is in memory, so nothing continues by itself | Yes |
| Continue an interrupted turn after a crash | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` starts a continuation turn on `resume`; frames carry `resume_reason` (`sdk.d.ts:3695`, [env vars](https://code.claude.com/docs/en/env-vars)) | Only after a managed-daemon shutdown, which writes a recovery snapshot ([`daemon_continuation.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/daemon_continuation.rs)); after a crash, `thread/resume` alone (**unverified** for SIGKILL) | No | Yes, step by step: each step is committed before it's shown (`pi-durable/README.md:1-5`) | No | Yes: a write-ahead claim, a continuation instruction, at most 10 tries per turn, at-least-once ([`specs/v2/session.md`](https://github.com/anomalyco/opencode/blob/v2.2.5/specs/v2/session.md)) |
| Tool call in flight when the process died | Not rerun; dropped by default ([sessions](https://code.claude.com/docs/en/sessions)) | Synthetic `"aborted"` output ([`normalize.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/normalize.rs)) | Lost | Rerun only if the tool declares `replay: "safe"`, else an `interrupted` result (`pi-durable/dist/harness/types.d.ts:244`) | "[Tool execution was interrupted]" on the next request | Failed by orphan reconciliation, never replayed |
| Steer during a turn | Streaming input; queued messages fold in mid-turn (`sdk.d.ts:3685`) | `turn/steer` with `expectedTurnId` | `steer()` after the current assistant turn and its tools | `whenBusy: "steer"` | A prompt posted mid-run is read at the next step | `delivery: "steer"` (default) or `"queue"`, with an editable inbox |
| Interrupt | `interrupt()` | `turn/interrupt` | `abort()` | Conversation abort | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt`, keeps pending input |
| Tools supplied by usine | SDK MCP tools | MCP; dynamic tools are experimental | Extensions | Extensions (usine's `subagent`) | MCP and plugins (**unverified** here) | **Unverified** |
| Tokens | `modelUsage` per model | `thread/tokenUsage/updated` with a cache breakdown | Cumulative `usage` | Same | `tokens` per message | Per message and `SessionStats` |
| USD figure | `total_cost_usd`, `costUSD` | None per turn | `usage.cost` | Same | `cost` per message | `Money.USD` |
| Subscription rate windows | `rate_limit_event` for claude.ai subscribers: five-hour, seven-day, and others (`sdk.d.ts:5870-5910`) | `account/rateLimits/updated` | None found | None found | None | None (Console and Go limits only) |
| API key | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `OPENAI_API_KEY`, `CODEX_API_KEY`, `model_providers.<id>.env_key` | Per-provider variables, `auth.json`, `models.json` | Same | Provider variables from the models.dev catalog, `auth.json`, `{env:VAR}` | Yes |
| Subscription login | claude.ai login, `CLAUDE_CODE_OAUTH_TOKEN` | ChatGPT browser or device login | OAuth for Anthropic, ChatGPT, Copilot, and others | Same | ChatGPT Plus or Pro through the Codex OAuth client; Claude Pro or Max removed in 1.3.0 ([providers](https://opencode.ai/docs/providers/)) | Adds a `claude-agent` provider that drives the user's own `claude` binary |
| Custom endpoint | Anthropic wire format only; Anthropic doesn't support non-Claude models through a gateway ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)) | `model_providers.<id>.base_url`, `--oss` for Ollama or LM Studio | `models.json` `baseUrl`, `registerProvider` | Same | `@ai-sdk/openai-compatible` with `options.baseURL`; Ollama, LM Studio, and OpenRouter presets | Yes |

Provider terms limit which routes a harness may take, independent of what it can do. Anthropic allows a subscriber to use their own plan only in the unmodified Claude Code binary and forbids third-party products from routing requests through plan credentials ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance); ADR 0027, amendment of 2026-10-26). So the Claude plan is a route for the Claude Code adapter only. OpenCode's ChatGPT login reuses the Codex CLI's OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`, [`plugin/openai/codex.ts:10-12`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/plugin/openai/codex.ts)); no OpenAI statement about third-party use of that client was found, so its status is **unverified**.

## Design

### Separate the harness from the model route

A brain keeps its authored shape (`harness`, `model`, `effort`), but resolving it produces a **model route**: the wire protocol, the provider model ID, and a **credential route**. The billing pool follows from the credential route alone. [ADR 0013](../adr/0013-cost-accounting-native-meters-guardrails.md) already says so ("a pool is the billed credential, not the harness"); today's code computes it from the harness instead.

| Credential route | Example | Pool |
| --- | --- | --- |
| `HostLogin` | `claude auth login` or `codex login` on the worker; `~/.pi/agent/auth.json` on the orchestrator | The provider's plan pool for a subscription, `apiKeys` for a stored key |
| `GatewayCredential` | A gateway slot holding an API key or a subscription login | `apiKeys` or the provider's plan pool, by the slot's reported kind |
| `AttemptApiKey` | `provisioner.api_keys`, a Cloudflare worker's `api_key_env` | `apiKeys` |
| `Endpoint` | An OpenAI-compatible endpoint named in configuration: OpenRouter, DeepSeek, a vLLM or Ollama host | `apiKeys` (see open question 4) |

Gateway slots become keyed by **wire protocol** (`anthropic-messages`, `openai-responses`, later `openai-chat`) instead of by a provider name that stands for one harness. Two harnesses can then share a slot: Codex and OpenCode both speak `openai-responses`, but each needs its own wiring on the worker (Codex reads `CODEX_HOME/config.toml`; OpenCode reads `OPENCODE_CONFIG_CONTENT`).

The proposed `ModelAccess` port fits on top: the adapter lists the routes a model can take, and `ModelAccess` chooses and admits one. Until `ModelAccess` exists, the choice is today's rule: the worker's gateway slot, then its provisioned key, then the host login.

### Modules

Each harness is one folder that owns everything specific to it:

```text
packages/agents/src/harness/
  harness.ts              descriptor, runtime, capability, role, and route types
  catalog.ts              platform-free list of descriptors     <- registration line 1
  admit.ts                admitBrain: the one validation function
  node.ts                 Harnesses service and its runtime list <- registration line 2
  claude/    descriptor.ts runtime.ts codec.ts sdk.ts ...
  codex/     descriptor.ts runtime.ts codec.ts app-server.ts remote.ts ...
  pi/        descriptor.ts runtime.ts session.ts turns.ts ...
  opencode/  descriptor.ts runtime.ts codec.ts ...
```

The descriptor is platform-free data and pure functions, so `@usine/config`, the executor, the operator API, and the Cloudflare package can read it without loading a vendor SDK. The runtime needs Node and vendor SDKs, so it sits behind a Node subpath, as AGENTS.md asks for platform services. Moving Claude Code and Codex out of `packages/agents/src/pi/` also fixes a misleading path.

```text
config load ───┐                              ┌── executor preflight (probe on the worker)
operator API ──┼── HarnessCatalog ── admitBrain ┼── coordinator start, subagent launch
web (via API) ─┘     (descriptors)            └── supervisor start
                          │
                          └── Harnesses (Node) ── runtime(id).preflight / .launch
```

### Interface sketch

This is a sketch for review, not an implementation. Names follow the existing schemas in `@usine/core/agent/*`.

```ts
// harness.ts: platform-free.

/** A registered harness, such as `claude`. The catalog decides which IDs exist. */
export const HarnessId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u, { message: "Expected a kebab-case harness ID" }),
).pipe(Schema.brand("HarnessId"));
export type HarnessId = typeof HarnessId.Type;

export const Capability = Schema.Literals([
  "durable-coordination", // continues from its last committed step after an orchestrator restart;
  //                         a tool call in flight ends as interrupted with its committed output
  "resume-session", //       continues a saved conversation by ID after its process ends
  "steer", //                accepts a message during a turn
  "interrupt", //            stops the current turn and keeps the session
  "usine-tools", //          runs tools that usine supplies (an extension, MCP, or dynamic tools)
  "token-usage", //          reports a cumulative token breakdown
  "cost-usd", //             reports its own USD figure
  "plan-windows", //         reports a subscription plan's rate windows
  "model-check", //          rejects an unknown model or effort before the first request
]);
export type Capability = typeof Capability.Type;

/** Where a session's process and tools run. Worker kinds map onto these. */
export const Placement = Schema.Literals(["orchestrator", "local", "ssh", "container", "sandbox"]);
export type Placement = typeof Placement.Type;

export const WireProtocol = Schema.Literals(["anthropic-messages", "openai-responses", "openai-chat"]);

/** How the harness gets the credential that pays for its model requests. */
export const CredentialRoute = Schema.Union([
  HostLogin, //         { provider }
  GatewayCredential, // { protocol, kind: "api-key" | "subscription" }
  AttemptApiKey, //     { protocol }
  Endpoint, //          { endpoint: EndpointName }
]);

/** A capability or placement the harness lacks, with the reason shown in refusals. */
export interface Lacking {
  readonly capability: Capability | Placement;
  readonly reason: string; // "Pi runs its tools in the orchestrator process"
}

export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly label: string;
  /** What a session on `route` at `placement` can do, and why it can't do the rest. */
  readonly capabilities: (
    route: CredentialRoute,
    placement: Placement,
  ) => { readonly supported: ReadonlySet<Capability>; readonly lacking: ReadonlyArray<Lacking> };
  /** The routes `model` can take with `available`, most preferred first, or why none fits. */
  readonly routes: (
    model: ModelId,
    available: AvailableCredentials,
  ) => Result.Result<NonEmptyReadonlyArray<ModelRoute>, RouteRefused>;
  /** What a worker must provide, and how the executor wires a credential route. */
  readonly worker: WorkerRequirements;
  /** A price from a rate table when the harness reports none (Codex), else `None`. */
  readonly price: (route: ModelRoute, tokens: TokenBreakdown) => Option.Option<UsdAmount>;
  /** The operator's terminal command that resumes a saved session, if any. */
  readonly handoff: Option.Option<ResumeCommand>;
}

export interface WorkerRequirements {
  /** npm packages for worker images; empty when the orchestrator bundles the harness. */
  readonly install: ReadonlyArray<{ readonly name: string; readonly version: string }>;
  /** Accepted `--version` outputs, checked by preflight and by the image tests. */
  readonly versions: ReadonlyArray<string>;
  /** Login files under the worker user's home, for container mounts, and their egress hosts. */
  readonly login: {
    readonly mounted: ReadonlyArray<string>;
    readonly seeded: ReadonlyArray<string>;
    readonly hosts: ReadonlyArray<string>;
  };
  /** Variables, files, and per-attempt directories for `route`; never secret values. */
  readonly wiring: (route: CredentialRoute, context: WiringContext) => CredentialWiring;
}

// node.ts: Node only.

export interface HarnessRuntime {
  /** Checks `brain` on `target` without a prompt; a missing prerequisite is a readiness report. */
  readonly preflight: (
    brain: BrainSpec,
    target: ProbeTarget, // host, environment, credential route
  ) => Effect.Effect<HarnessReadiness, SessionOperationError>;
  /** Starts a session in the calling scope; the existing `RunningSession` contract. */
  readonly launch: (
    request: SessionRequest, // ChildRequest with the role and the admitted route
  ) => Effect.Effect<RunningSession, AgentSessionError, Scope.Scope>;
}

export class Harnesses extends Context.Service<
  Harnesses,
  {
    readonly catalog: HarnessCatalog;
    readonly runtime: (id: HarnessId) => Effect.Effect<HarnessRuntime, UnknownHarnessError>;
  }
>()("@usine/agents/harness/Harnesses") {}
```

Registration is one line in each list:

```ts
// catalog.ts
export const catalog = HarnessCatalog.make([claude, codex, pi, opencode]);

// node.ts: building the layer fails if a descriptor has no runtime.
export const harnessesLayer = Harnesses.layerFrom(catalog, [
  claudeRuntime,
  codexRuntime,
  piRuntime,
  opencodeRuntime,
]);
```

The interface is small on purpose. Launch options, codecs, resume delays, the Claude login lock, Codex homes, and the remote Codex supervisor stay inside each adapter. Two current seams stay unchanged: `RunningSession` and `AgentSessionEvent`. `ClaudeLoginLock` becomes a `HostLoginLock` keyed by harness, worker, and machine, used inside the adapters that need it, which removes the executor's Claude branch.

### Roles and one validation function

A role names what a session is for and declares what it needs. Roles are code, not configuration.

| Role | Required capabilities | Allowed placements |
| --- | --- | --- |
| `coordinator` | `durable-coordination`, `usine-tools`, `steer`, `interrupt`, `token-usage` | `orchestrator` |
| `coding-agent` | `steer`, `interrupt`, `token-usage` | The worker's placement |
| `supervisor` | `usine-tools`, `resume-session`, `steer`, `interrupt`, `token-usage` | Open question 10 |

Walkthrough Q&A isn't a role: its turns run in the supervisor's conversation (#859).

```ts
// admit.ts: platform-free and pure.
export const admitBrain = (
  catalog: HarnessCatalog,
  role: Role,
  brain: BrainSpec,
  context: AdmissionContext, // the placement and the credentials the worker or orchestrator has
): Result.Result<AdmittedBrain, BrainRefused> => {
  /* ... */
};

export class BrainRefused extends Schema.TaggedError<BrainRefused>()("BrainRefused", {
  role: Role,
  harness: HarnessId,
  model: ModelId,
  missing: Schema.NonEmptyArray(LackingSchema),
  message: Schema.NonEmptyString,
}) {}
```

`AdmittedBrain` carries the chosen model route and pool. The launch records them on the session, so accounting reads the pool instead of computing it again. Callers:

1. Configuration load and reload: every agent's child brain against `coding-agent` on every worker that can run it, and the parent brain against `coordinator`. The parent is checked at startup, not when the first attempt starts.
2. Executor preflight: `admitBrain`, then `runtime(id).preflight` on the worker for the admitted route. A route through a gateway or an attempt key checks the binary and version only; a host login also checks the login. The adapter decides, replacing `harnessBinaryProbe` and the gateway dispatch.
3. Launch: the coordinator start and the `subagent` tool call `admitBrain` again as a guard, since a gateway reload can change a slot's kind (ADR 0013, amendment of 2026-10-22).

A refusal names the role, the missing capability, and the adapter's reason, for example: `Agent "fixer" can't run as a coding-agent on SSH worker "eu-1": Pi lacks the ssh placement (Pi runs its tools in the orchestrator process).` That replaces the five separate Pi-local messages and the refusals that today appear only when an attempt starts.

### Credentials and pools in the adapters

- **Claude Code**: routes `HostLogin(anthropic)` (pool `claudePlan`), `GatewayCredential(anthropic-messages, subscription or api-key)`, and `AttemptApiKey(anthropic-messages)`. Wiring: `ANTHROPIC_BASE_URL` and the caller token in `ANTHROPIC_AUTH_TOKEN` behind a gateway, `ANTHROPIC_API_KEY` with an attempt key. It declares `plan-windows` on plan routes once its codec maps `rate_limit_event`.
- **Codex**: routes `HostLogin(openai)` (pool `chatgptPlan`), `GatewayCredential(openai-responses, …)`, `AttemptApiKey(openai-responses)`, and `Endpoint` through a written `model_providers` entry. Wiring: a per-attempt `CODEX_HOME` with `config.toml`. Its descriptor supplies the OpenAI rate table as `price`.
- **Pi**: routes `HostLogin(<pi-ai provider>)` on the orchestrator, including `openai-codex` (pool `chatgptPlan`) and API keys, and `Endpoint` through `models.json` `baseUrl` or `registerProvider`. The descriptor refuses Pi's `anthropic` OAuth provider because of Anthropic's terms, which is a stated reason instead of a pool rule. With #941, children get the parent's routes.
- **OpenCode**: see the worked example below.

A local model is an `Endpoint` whose base URL the worker reaches directly, such as an Ollama host on the tailnet, or through a gateway `openai-chat` slot when the endpoint needs a key that must stay off the worker. Pi and OpenCode take any OpenAI-compatible endpoint, and Codex takes one through `model_providers`. Claude Code doesn't: Anthropic doesn't support non-Claude models through a gateway, so its descriptor offers no `Endpoint` route, although DeepSeek and Z.ai publish Anthropic-compatible URLs.

### A durable coordinator on another harness

pi-durable gives the coordinator three guarantees: each turn and tool intent is committed before anything is shown; after a restart, the task continues from the last commit, and a non-replay-safe tool call in flight ends as interrupted with its committed output; and submissions are idempotent by request ID. The `subagent` tool is non-replay-safe ([`subagent.ts:368`](../../packages/durable/src/attempt/subagent.ts)). usine adds holds, queued operator input, release, and the child budget on top, in [`attempt/runtime.ts`](../../packages/durable/src/attempt/runtime.ts), `relay.ts`, `task.ts`, and `hubs.ts` (about 2,200 lines).

No vendor harness gives the first guarantee at step granularity. Claude Code, Codex, and OpenCode 2.x can each start a continuation turn from a saved transcript after the process ends (OpenCode 2.x from a write-ahead claim, at least once), but the in-flight model request and its partial output are lost, and the in-flight tool call is dropped, marked aborted, or failed. Because the coordinator's only tool is non-replay-safe, the practical gap is narrower than it looks: pi-durable also reports that call as interrupted. The real work is the state usine keeps outside the vendor transcript.

A non-Pi coordinator needs:

1. `usine-tools`, to expose `subagent`: an SDK MCP tool for Claude Code, MCP or experimental dynamic tools for Codex.
2. A usine-owned journal of `subagent` intents and results, holds, and queued operator input, committed before the tool returns, because the vendor transcript isn't transactional with usine's state.
3. Reconciliation on restart: resume the vendor session by ID, deliver the interrupted call's result as a message, and start one continuation turn, without spawning a second child for the same intent.
4. The restart test matrix in [model-access.md](./model-access.md#parent-harness-comparison): before the tool intent, during the child, after the child but before the result is acknowledged, while held, and while releasing.

Cost: four to six pull requests on the critical path, a second implementation of what pi-durable does for usine, and live restart tests per vendor. The benefit is a coordinator on the Claude plan through Claude Code, which Pi can't use.

So the coordinator becomes a role with a capability requirement instead of being Pi-only. Pi is the only adapter that declares `durable-coordination` today. A journaled wrapper, if it's ever built, is an adapter decorator that declares it for a vendor harness with `resume-session` and `usine-tools`; nothing else changes.

## Worked example: adding OpenCode

### What the adapter implements

| Part | OpenCode specifics | Source |
| --- | --- | --- |
| Descriptor: install | `opencode-ai@1.19.5` (binary `opencode`), or `@opencode/cli@2.2.5` for 2.x | [docs](https://opencode.ai/docs/), [2.x docs](https://opencode.ai/v2/docs), npm |
| Descriptor: versions | Exact `opencode --version` outputs, as for Codex | Pin choice |
| Descriptor: login | `~/.local/share/opencode/auth.json`, mode 0600, mounted read-write for `HostLogin` | [`auth/index.ts:10`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/auth/index.ts) |
| Descriptor: routes | `-m provider/model`, as for Pi; `Endpoint` and gateway routes through a `provider` block with `@ai-sdk/openai-compatible` or `@ai-sdk/openai` and `options.baseURL` | [providers](https://opencode.ai/docs/providers/) |
| Descriptor: wiring | `OPENCODE_CONFIG_CONTENT` with the provider block and `"permission": "allow"`, the caller token as the provider key, `OPENCODE_DISABLE_AUTOUPDATE` | [config](https://opencode.ai/docs/config/), [permissions](https://opencode.ai/docs/permissions/), [CLI](https://opencode.ai/docs/cli/) |
| Descriptor: capabilities | `resume-session`, `steer`, `interrupt`, `token-usage`, `cost-usd`; `model-check` **unverified**; no `plan-windows`; no `durable-coordination` | Table above |
| Descriptor: price | `None`: messages carry `cost` | `AssistantMessage.cost` |
| Descriptor: handoff | `opencode run -s <id>` in the worktree is verified; a TUI flag for an interactive resume is **unverified** | [`run.ts`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/run.ts) |
| Runtime: preflight | Binary and version; for `HostLogin`, `opencode auth list` (output format **unverified**) | [CLI](https://opencode.ai/docs/cli/) |
| Runtime: launch | Create a session, send the prompt, and map events: tool parts to `ToolStarted` and `ToolFinished`, text parts to `TextOutput`, `session.status` retry to `ProviderRetrying`, `session.idle` to `SessionIdle`, per-message `tokens` and `cost` to `SessionTokensUpdated` | [server](https://opencode.ai/docs/server/), [`types.gen.ts:2875`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/sdk/js/src/v2/gen/types.gen.ts) |
| Runtime: interventions | 1.x: abort, and a prompt posted mid-run is read at the next step. 2.x: `delivery: "steer"` or `"queue"`, and interrupt keeps pending input | [`specs/v2/session.md`](https://github.com/anomalyco/opencode/blob/v2.2.5/specs/v2/session.md) |
| Tests | The shared live contract suite, `packages/agents/test/integration/contract.ts` | usine |

The transport is the main design choice. `ChildHost` runs one command and talks over its standard streams, which suits `opencode acp` (nd-JSON over stdio, with `loadSession`, `resumeSession`, and `cancel`). The HTTP server has the fuller API, but on a remote worker it needs a port forward, which `ChildHost` doesn't model. A spike should check whether ACP can steer a running turn; if it can't, the adapter runs `opencode serve` on the worker and reaches it through an SSH forward.

Two behaviors need checking before an attempt runs on OpenCode: whether project-level `opencode.json` and `.opencode/` in an untrusted worktree can be ignored, as Claude Code's `settingSources: ["user"]` does, and what an `ask` permission does in a headless run. Both are **unverified**.

### What else it touches

- **Worker images**: one entry in the descriptor's `install`, which the image build reads after migration step 6. Before that step: `infra/worker-image/Dockerfile`, `infra/hetzner/cloud-init.yaml`, `packages/cloudflare/image/Dockerfile`, and the image tag in `ssh/container.ts`.
- **Gateway**: with an OpenAI API key, OpenCode can call the existing `openai` slot through `@ai-sdk/openai` and a base URL; nothing changes. An OpenAI-compatible endpoint needs an `openai-chat` slot and its route in [`llm.ts:145-158`](../../packages/gateway/src/llm/llm.ts) and [`outbound.ts:161-173`](../../packages/cloudflare/src/sandbox/outbound.ts). A ChatGPT login at the gateway waits on the terms question and on whether OpenCode's request shape fits the gateway's ChatGPT path (**unverified**).
- **Egress**: with a host login, the descriptor's `login.hosts`. OpenCode may also fetch the models.dev catalog at startup (**unverified**).
- **Pricing**: none; OpenCode reports USD.
- **Pools**: `apiKeys` for keys and endpoints. No plan windows, so usine can't warn before a plan limit for OpenCode sessions.
- **Web**: nothing, once labels, handoff commands, and tool categories come from the operator API. OpenCode's tool names (`bash`, `read`, `edit`, `write`, `glob`, `grep`, `task`) already match [`presentation.ts:36-62`](../../apps/web/src/lib/runs/transcript/tool/presentation.ts).

## ADRs this design contradicts

ADRs record why. Where this design departs from one, the amendment states the new reason.

- **[ADR 0005](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0005-pi-parent-agent-layer-team-roster.md)** said Pi runs every agent and the agent layer is one adapter. The design keeps Pi as the coordinator but makes the coordinator a role that any adapter with `durable-coordination` can fill. Reason for the amendment: three roles now run models, and each role's harness limits must be declared and checked in one place instead of discovered when a session refuses.
- **[ADR 0006](../adr/0006-executor-prepares-checkouts-runs-children-on-workers.md)** said no executor embeds vendor authentication rules. The executor does today (`LOGINS`, `PROVIDER_OF_HARNESS`, `HARNESS_PROVIDERS`, the Codex API-key configuration). The design restores the rule; the note would say the executor reads credential wiring from descriptors.
- **[ADR 0013](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0013-cost-accounting-native-meters-guardrails.md)** listed pools per harness ("Claude plan (Claude Code children)"). The design derives the pool from the credential route and records it on the session. Reason: the pool is a property of the credential, which the adapter's route declares; [ADR 0021](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0021-pi-parent-pool-follows-authentication.md) already revised this for Pi.
- **[ADR 0021](https://github.com/basaltbytes/usine/blob/2557b04fff7602e8c4bce3f5f59bed724f43b3b7/docs/adr/0021-pi-parent-pool-follows-authentication.md)** kept Pi children API-key-only. The design has no harness-specific pool restriction; it refuses only routes whose billing usine can't represent. Reason: the restriction has no recorded reason (#941).
- **[ADR 0027](../adr/0027-gateway-credential-proxy.md)** serves "only the routes Claude Code and Codex call" and keys slots by provider. The design keys slots by wire protocol and takes routes from registered adapters. Reason: two harnesses can use one provider with different wiring, and the route allowlist must follow what the registered harnesses call. The amendment of 2026-10-26 on provider terms stays binding; it becomes a route that only the Claude Code descriptor offers.

[ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md) and [ADR 0029](../adr/0029-worker-kinds-and-adapter-set.md) need no change: the attempt environment stays the only environment, and login mounts come from descriptors instead of a table. The `ModelAccess` proposal in [Model access](./model-access.md) is complementary: descriptors supply the candidate routes that `ModelAccess` chooses from.

## Migration plan

Each step leaves the system working and ships as one pull request. "Agent" means a factory agent can do it from a well-specified issue; "decision" means the owner answers a question first.

| Step | Change | Size | Risk | Who |
| --- | --- | --- | --- | --- |
| 1 | Move `packages/agents/src/pi/{claude,codex}` and the Pi child to `packages/agents/src/harness/{claude,codex,pi}`; keep the subpath exports. No behavior change. | ~40 files, imports only | Low | Agent |
| 2 | Add `harness.ts` and `catalog.ts` with three descriptors as data: labels, install and versions, login files and hosts, provider mapping, price table, and handoff commands. Replace the tables in `ssh/api-keys.ts`, `cloudflare/cloudflare.ts`, `remote/container.ts`, `ssh/gateway/preflight.ts` (`LOGINS`), `operator/usage.ts`, and the web's labels and `RESUME_COMMANDS`, which the operator API then serves. | ~15 files | Low | Agent |
| 3 | Add `HarnessRuntime` and the `Harnesses` service. Split `verifyHarness` into the adapters, remove the three backend tags and the `switch` in `pi/children.ts`, generalize `ClaudeLoginLock` to `HostLoginLock`, and make the gateway and Cloudflare probes call `runtime.preflight` with the route. | ~12 files | High: critical path (preflight, launch) | Agent, strict review, dogfood after merge |
| 4 | Add capabilities, roles, and `admitBrain`. Call it at configuration load, preflight, coordinator start, and `subagent`. Replace the five Pi-local refusals. Admit the parent brain at startup. | ~10 files | Medium | Agent, after questions 1 to 3 |
| 5 | Record the pool on sessions at launch, as an optional key; older records use a legacy `brainPool` kept in one module. Remove `brainPool`'s harness switch, the SSH executor's pool rule, and the `harness === "codex"` branches in `operator/usage.ts`. Land #941 first or in this step. | ~8 files | Medium: stored data and accounting | Agent |
| 6 | Generate image inputs from descriptors: Dockerfile arguments, the cloud-init install line, and the image tag, with a test that they agree. Pin accepted Claude Code versions as for Codex. | ~6 files, `infra/` | Medium: image rebuild and worker rollout | Decision (question 8), then agent |
| 7 | Map Claude Code's `rate_limit_event` to `PoolRateLimitsUpdated` for the Claude plan; declare `plan-windows`. | ~3 files | Low | Agent |
| 8 | Move credential wiring into descriptors: gateway environment, attempt keys, Cloudflare provider environment, and per-attempt homes generalized from Codex homes. Key gateway slots by wire protocol. | ~14 files across executor, gateway, and cloudflare | High: credentials and gateway | Decision (question 6), then agent, owner review, dogfood |
| 9 | OpenCode: spike the transport and the two unverified behaviors, then add the adapter and run the contract suite. | A new folder, 2 registration lines, 1 install entry | Medium | Decision (question 7), then agent |
| 10 | The supervisor's runtime launches through `Harnesses` with the `supervisor` role. | Part of #799 | Medium | Decision (question 10) |
| 11 | Optional: a journaled coordinator decorator for a vendor harness. | 4 to 6 pull requests | High | Decision (question 2) |
| 12 | Record real Claude SDK and Codex app-server traffic and replay shared lifecycle scenarios in CI, including SQLite restart recovery and a changed credential kind. See [recording commands](../../packages/agents/README.md#transport-replay-tests). | Agents and durable test suites | Medium: transport and recovery regressions | Agent, after #1000 |
| 13 | Share one worker process owner across Claude Code and Codex, with sequenced relay replay, a two-minute orchestrator lease, bounded exit diagnostics, and a local crash lifeline. See [#1006](https://github.com/basaltbytes/usine/issues/1006) and the [owner contract](../../packages/agents/README.md#process-ownership-and-lost-connections). | Agents child-host and harness adapters | High: process ownership and restart recovery | Agent, after step 12; dogfood after merge |
| 14 | Share one continuation policy above native adapters: required prompt-free resume, one continuation message, supervision and unread-input restoration, interrupted tool errors, and three continuations per ten minutes. Assign Claude session UUIDs before the first prompt and acknowledge operator messages by ID. See [#1007](https://github.com/basaltbytes/usine/issues/1007). | Agents, core, and durable runtime | High: delivery and restart recovery | Agent, after steps 12 and 13; dogfood after merge |
| 15 | Scope process environments to the launched harness; save continuation identity separately from credentials; resolve and admit the current route at every launch. Refuse changed homes and Codex provider IDs. See [#1008](https://github.com/basaltbytes/usine/issues/1008) and the [Codex probe](./t3code-harness-encapsulation.md#codex-provider-continuation-probe-2026-11-05). | ~20 implementation files plus tests and docs | High: credentials and restart recovery | Agent, after #1000; dogfood after merge |

Steps 1 to 5 deliver the main goal: after them, adding a child harness is a folder, two registration lines, and an image entry. Steps 6 to 8 remove the remaining per-harness edits in infrastructure and credentials.

## Open questions

Grouped for asking two or three at a time. Each has a recommendation.

**Identity and roles**

1. Should harness IDs be an open set that the catalog validates, or stay a closed literal that each new harness edits? Recommendation: a branded string validated against the catalog. It gives up exhaustive `switch` statements on purpose, because those are what scatter harness logic today.
2. Must the coordinator have `durable-coordination` (Pi only today), or should a harness with only `resume-session` be accepted, with a restart retrying the attempt from salvage? Recommendation: require `durable-coordination`. Build the journaled decorator (step 11) only when a coordinator on the Claude plan is worth four to six critical-path pull requests.
3. Keep `parent_model` and `parent_effort` in configuration with the harness implied, or add `parent_harness` now? Recommendation: keep them, and add `parent_harness` with the second adapter that declares `durable-coordination`.

**Credentials and pools**

4. Which pool should OpenAI-compatible endpoints and local models use? Recommendation: `apiKeys`, with the endpoint name recorded on the session. Add a separate unpriced pool only when a self-hosted model runs in the factory.
5. May OpenCode use a ChatGPT login? It reuses the Codex CLI's OAuth client, and no OpenAI statement about that was found. Recommendation: no, until OpenAI's terms are read. Start OpenCode on API keys and endpoints.
6. Key gateway slots by wire protocol instead of by provider? Recommendation: yes, in step 8, before a second harness needs the same provider.

**Harnesses and operations**

7. Target OpenCode 1.x (`opencode-ai`, the npm `latest`) or 2.x (`@opencode/cli`, released 2026-10-30)? Recommendation: 2.x, pinned exactly. Its explicit steer and queue, durable event log, and crash recovery match usine's contract; 1.x keeps run status in memory.
8. Pin Claude Code versions at preflight, as for Codex? Recommendation: yes. Version skew should show at preflight, as ADR 0006 intends, and the README drift found here shows the versions already move apart.
9. Give Pi children persistent sessions so they gain `resume-session`? Recommendation: yes, as a small change after #941; it costs a session directory per attempt.

**Supervisor**

10. Where does the supervisor run: on a worker behind the gateway, like children, or on the orchestrator host with its own login? Recommendation: on a worker behind the gateway, so subscription credentials stay on the gateway and the role's placement check is the same as a coding agent's.

## Decisions (owner, 2026-11-04)

1. Harness IDs are an open set validated by the registry.
2. The coordinator requires `durable-coordination`, which only Pi declares today. The journaled decorator (step 11) waits until a vendor-harness coordinator is worth its cost.
3. Keep `parent_model` and `parent_effort`; add `parent_harness` only with a second adapter that declares `durable-coordination`.
4. OpenAI-compatible endpoints and local models use the `apiKeys` pool, with the endpoint name recorded on the session.
5. OpenCode may use a ChatGPT login from the start, against the recommendation above.
6. Gateway slots are keyed by wire protocol, in step 8.
7. OpenCode targets 2.x, pinned exactly.
8. Claude Code versions stay unpinned: preflight accepts any installed version, against the recommendation above. Step 6 generates image inputs from descriptors without adding a Claude Code version check.
9. Pi children get persistent sessions after #941.
10. The supervisor runs on the orchestrator host, next to the server, not on a worker, and gets its Claude or ChatGPT login through the gateway, as workers do: subscription credentials stay on the gateway. The `supervisor` role admits the `orchestrator` placement with a `GatewayCredential` route. The coordinator follows the same credential rule (#961) through `gatewayModelRouteFor` from `@usine/executor/gateway`. Step 10 must reuse that route for caller-token transport and gateway credential reporting.

## Rough edges found

- [`packages/cloudflare/README.md:59`](../../packages/cloudflare/README.md) says the sandbox image installs Claude Code 2.1.308; its Dockerfile installs 2.1.311.
- [`cloudflare/cloudflare.ts:208-217`](../../packages/executor/src/cloudflare/cloudflare.ts) reimplements the Codex version check instead of calling `unsupportedCodexVersion`.
- Preflight checks no Claude Code version.
- Claude Code's `rate_limit_event` isn't mapped to `PoolRateLimitsUpdated`, so the Claude plan has no window meter.
- The parent brain isn't checked at startup preflight, so an unusable parent model fails the first attempt.
- The Pi parent's pool is resolved from its authentication at start and derived again from its model prefix for accounting.
- The Claude Code and Codex backends live under `packages/agents/src/pi/`.
