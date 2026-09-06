# @usine/agents

The agent runtime for [usine](https://github.com/basaltbytes/usine). Each Attempt starts an in-process Pi parent, which can delegate focused work through the usine-owned `subagent` tool. An agent's brain spec selects Claude Code, Codex, or Pi for the child.

`@usine/agents/prompt` and `@usine/agents/runtime` are platform-free: prompt assembly, typed runtime errors, and the `AgentRuntime` and `ChildBackend` service contracts. The Node implementation lives at `@usine/agents/pi/live`:

```ts
import { layer as agentLayer } from "@usine/agents/pi/live";
```

Use `@usine/agents/pi` to compose the Pi parent with your own child backend:

```ts
import { Layer } from "effect";
import { piParentLayer, piSdkLive } from "@usine/agents/pi";

// childBackendLayer supplies ChildBackend from @usine/agents/runtime.
const agentLayer = piParentLayer.pipe(
  Layer.provide(piSdkLive),
  Layer.provide(childBackendLayer),
);
```

`@usine/agents/children` provides `childDispatcherLayer`, which selects a child backend by harness. Compose its `ClaudeChildBackend`, `CodexChildBackend`, and `PiChildBackend` requirements with the adapter layers from `/claude`, `/codex`, and `/pi`. These Node entry points also provide their SDK service contracts and production SDK layers for caller-controlled composition. `/pi/live` assembles the parent and all three child backends.

The production layer resolves the Pi parent model from the Run spec, installs the subagents extension, and dispatches each child from the rostered `harness` field. The Run spec also defines the per-Attempt child-session budget. Every accepted spawn logs its cumulative count and a 160-character task excerpt; an excess spawn stops the parent with `ChildSessionBudgetExceededError`. The parent accepts API-key-backed Pi models and ChatGPT subscription models from the `openai-codex` provider. Claude Code runs the worker’s `claude` executable through the Agent SDK with `bypassPermissions` and reads only worker-user settings. Codex uses app-server JSON-RPC over standard input and output with `approvalPolicy: never`; it verifies ChatGPT authentication with `account/read` before creating an ephemeral thread and records ChatGPT plan rate-window updates as `PoolRateLimitsUpdated` session events. Pi children remain API-key-only.

The Attempt worktree counts as repository-controlled input. Pi ignores project `.pi/` settings, extensions, prompt templates, skills, and themes. Claude omits project setting sources, while Codex marks the worktree untrusted before starting its thread. AGENTS instructions remain available to the coding harnesses. Worker isolation remains the executor's responsibility.

Parent and child output becomes typed session events: `SessionStarted`, `TextOutput`, tool calls, pool observations, and `SessionFinished`. Completed assistant text produces `TextOutput` events; streaming deltas don't enter the Attempt transcript. Parent and child controls support steer and interrupt. A child session always names one parent session, so recursive child events cannot enter the public model.

Model identifiers stay opaque until the selected harness checks its registry. Agent-reported failures use `AgentResultError`; SDK, process, and protocol failures use `SessionOperationError`. `toAttemptFailure` maps only `SessionOperationError` to retryable infrastructure failure, while `ChildSessionBudgetExceededError` becomes a non-retryable `ChildSessionBudgetFailure`.

Configure Pi with either a provider API key or ChatGPT Plus/Pro OAuth for the parent. Pi children require API keys; Claude and Codex children use their CLI login state. The parent-start log records `apiKeys` or `chatgptPlan` according to the resolved credential. The harness SDK and protocol dependencies use exact versions.

`@usine/agents/preflight` provides the Node `preflight(brain)` operation. Supply a `ChildProcessSpawner` layer to check a worker without running a prompt. It checks `codex --version` against **0.144.0**, verifies the Codex ChatGPT account, checks `claude auth status --json` for a Claude subscription, and checks Pi’s model and API-key authentication through the installed SDK. `HarnessUnavailableError` identifies a binary, version, or login gap; `SessionOperationError` reports an incomplete check, including a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

A Codex API-key login, absent login, or unsupported account response produces `PoolUnavailableError`, which requires operator action. The verified authentication method and pool appear in structured logs. An authentication change during a running Codex session ends it before further rate windows are recorded.

The opt-in live contracts run in disposable directories. They steer a child during a waiting command, assert the changed response and event framing, and interrupt another active command. The Codex contract also requires a real rate-window snapshot. Use codex-cli 0.144.0 with a ChatGPT login; the Pi contract requires API-key authentication for the specified provider.

Run them with explicit models:

```sh
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

Agents share the installation’s GitHub App identity. Runtime instructions require comment reviews at the reviewed head commit and the outcome labels defined by the Loop. An agent success label does not satisfy GitHub’s required-review rule; an independent reviewer supplies required approval and the operator merges. See the [review/fix guide](../../docs/guides/review-fix-loops.md).
