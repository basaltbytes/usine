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

Claude children use the CLI's background-task snapshots and session-idle signal to wait for background work and its follow-up answer before returning to the parent. Background waits do not require an operator Hold. Ambient watchers do not delay completion; queued user turns do. A closed output stream without a completed answer fails through `SessionOperationError`.

Runtime prompts instruct parents and children to run gates, tests, and CI watches in the foreground, wait for any background results, and finish dependent steps before returning. A pending command or CI check is unfinished work; genuine blockers must be recorded on the issue or pull request. Push commits before returning because Attempt cleanup removes the worktree. Keep this foreground discipline on older worker CLIs that do not emit background-task or session-state messages.

An unresolved blocker must open its final answer with the reserved marker `[usine:blocked]`, followed by its details and incomplete work on the same or the next line:

```text
[usine:blocked]
Repository permission denied; publishing remains incomplete.
```

Pi, Claude, and Codex interpret this final-answer marker as `AgentResultError`. A parent's blocker becomes a non-retryable `AgentFailure` on the Attempt channel, so the Run fails and waits for operator action. A child's failed report returns to the parent's `subagent` tool call as text opening with the marker, and the tool guidelines tell the parent to return it verbatim. A child's blocker is sticky on the parent channel: a parent that later finishes with an ordinary answer fails with the first child blocker, and its paraphrase stays in the transcript. Successful siblings do not clear it. Held children can receive guidance and replace a blocked answer before release. A marker without details still fails; ordinary prose and marker mentions elsewhere keep their existing behavior.

Model identifiers stay opaque until the selected harness checks its registry. Agent-reported failures use `AgentResultError`; SDK, process, and protocol failures use `SessionOperationError`. `toAttemptFailure` maps only `SessionOperationError` to retryable infrastructure failure, while `ChildSessionBudgetExceededError` becomes a non-retryable `ChildSessionBudgetFailure`.

Configure Pi with either a provider API key or ChatGPT Plus/Pro OAuth for the parent. Pi children require API keys; Claude and Codex children use their CLI login state. The parent-start log records `apiKeys` or `chatgptPlan` according to the resolved credential. The harness SDK and protocol dependencies use exact versions.

`@usine/agents/preflight` provides the Node `preflight(brain)` operation. Supply a `ChildProcessSpawner` layer to check a worker without running a prompt. It accepts Codex CLI **0.144.0 or 0.153.4**, verifies the Codex ChatGPT account, checks `claude auth status --json` for a Claude subscription, and checks Pi’s model and API-key authentication through the installed SDK. `HarnessUnavailableError` identifies a binary, version, or login gap; `SessionOperationError` reports an incomplete check, including a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

A Codex API-key login, absent login, or unsupported account response produces `PoolUnavailableError`, which requires operator action. The verified authentication method and pool appear in structured logs. An authentication change during a running Codex session ends it before further rate windows are recorded.

The opt-in live contracts run in disposable directories. They steer a child during a waiting command, assert the changed response and event framing, and interrupt another active command. The Codex contract also requires a real rate-window snapshot. Use a supported Codex CLI with a ChatGPT login; the Pi contract requires API-key authentication for the specified provider.

Run them with explicit models:

```sh
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

The protocol conformance gate retains 0.144.0 as its baseline. Codex 0.153.4 was also checked against its generated protocol types and the real steering/interruption contracts, including Astra. Other CLI builds require verification before they are accepted.

Each Codex child owns one app-server process. On completion or interruption, usine closes its input and waits for graceful shutdown before publishing the result, so background commands are released. Scope cleanup uses the same bounded shutdown and logs before forcing a stalled process to stop.

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

Agents share the installation’s GitHub App identity. Runtime instructions require comment reviews at the reviewed head commit and the outcome labels defined by the Loop. An agent success label does not satisfy GitHub’s required-review rule; an independent reviewer supplies required approval and the operator merges. See the [review/fix guide](../../docs/guides/review-fix-loops.md).

Claude children persist their sessions; Codex children start non-ephemeral threads. Their `SessionStarted.harnessSession` records the native session id and worker working directory, and structured launch logs include `harnessSessionId`, `sessionId`, and `cwd`. Resume with `claude --resume <id>` or `codex resume <id>` from that directory on the same worker and account, while its worktree and saved session files still exist. Attempt cleanup removes the worktree.
