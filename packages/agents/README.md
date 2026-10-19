# @usine/agents

The agent layer for [usine](https://github.com/basaltbytes/usine): the Claude Code, Codex, and Pi child backends an Attempt's Pi parent delegates focused work to, the prompts the parent and its children receive, and the harness preflight. The Pi parent runs in the orchestrator as a durable task (`@usine/durable`); its `subagent` tool launches the child that the Agent's brain spec selects.

`@usine/agents/prompt` and `@usine/agents/runtime` are platform-free: prompt assembly, typed runtime errors, and the `ChildBackend` service contracts.

`@usine/agents/children` provides `childDispatcherLayer`, which selects a child backend from the rostered `harness` field. Compose its `ClaudeChildBackend`, `CodexChildBackend`, and `PiChildBackend` requirements with the adapter layers from `/claude`, `/codex`, and `/pi`. These Node entry points also provide their SDK service contracts and production SDK layers for caller-controlled composition; `@usine/durable/live` assembles all three.

```ts
import { Layer } from "effect";
import { childDispatcherLayer } from "@usine/agents/children";
import { claudeChildBackendLayer, claudeSdkLive } from "@usine/agents/claude";
import { codexAppServerLive, codexChildBackendLayer } from "@usine/agents/codex";
import { piChildBackendLayer, piSdkLive } from "@usine/agents/pi";

const childBackendLayer = childDispatcherLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      claudeChildBackendLayer.pipe(Layer.provide(claudeSdkLive)),
      codexChildBackendLayer.pipe(Layer.provide(codexAppServerLive)),
      piChildBackendLayer.pipe(Layer.provide(piSdkLive)),
    ),
  ),
);
```

The Run spec defines the per-Attempt child-session budget; a spawn past it stops the parent with `ChildSessionBudgetExceededError`. The parent accepts API-key-backed Pi models and ChatGPT subscription models from the `openai-codex` provider. Claude Code runs the worker’s `claude` executable through the Agent SDK with `bypassPermissions` and reads only worker-user settings. Codex uses app-server JSON-RPC over standard input and output with `approvalPolicy: never`; it verifies ChatGPT authentication with `account/read` before creating an ephemeral thread and records ChatGPT plan rate-window updates as `PoolRateLimitsUpdated` session events. Pi children remain API-key-only.

`ChildRequest.host` (`@usine/agents/child-host`) says where a child's process runs. `LocalProcess` spawns it on this machine with `ChildRequest.environment` as its complete environment. `RemoteShell` runs it as one SSH command, `ssh <args> <destination> -- <remote command>`: the remote command changes into the worktree, exports the request's environment on top of the remote machine's own, records its pid at `<worktree>.child-<n>.pid` while it runs, and executes the harness. `CHILD_KILL_SCRIPT` stops every child those pid files record, for an executor to run on the remote machine before it keeps or removes the worktree. The SSH client itself sees only `RemoteShell.sshEnvironment`. Claude Code reaches the remote machine through the Agent SDK's `spawnClaudeCodeProcess`, still running the `claude` executable; Codex runs its app server over the same SSH command. Pi children run their tools in this process, so a `RemoteShell` host fails their launch with `AgentResultError`.

The Attempt worktree counts as repository-controlled input. Pi ignores project `.pi/` settings, extensions, prompt templates, skills, and themes. Claude omits project setting sources, while Codex marks the worktree untrusted before starting its thread. AGENTS instructions remain available to the coding harnesses. Worker isolation remains the executor's responsibility.

Child output becomes typed session events: `SessionStarted`, `TextOutput`, tool calls, pool observations, and `SessionFinished`. Completed assistant text produces `TextOutput` events; streaming deltas don't enter the Attempt transcript. Child controls support steer, interrupt, and operator Holds. A child session always names one parent session, so recursive child events cannot enter the public model.

Claude children use the CLI's background-task snapshots and session-idle signal to wait for background work and its follow-up answer before returning to the parent. Background waits do not require an operator Hold. Ambient watchers do not delay completion; queued user turns do. A closed output stream without a completed answer fails through `SessionOperationError`.

Runtime prompts instruct parents and children to run gates, tests, and CI watches in the foreground, wait for any background results, and finish dependent steps before returning. A pending command or CI check is unfinished work; genuine blockers must be recorded on the issue or pull request. Push commits before returning because Attempt cleanup removes the worktree. Keep this foreground discipline on older worker CLIs that do not emit background-task or session-state messages.

An unresolved blocker must open its final answer with the reserved marker `[usine:blocked]`, followed by its details and incomplete work on the same or the next line:

```text
[usine:blocked]
Repository permission denied; publishing remains incomplete.
```

A decision that only the operator can make opens the final answer with `[usine:question]`, followed by the question. The prompt asks the Agent to post the question on the issue or pull request first.

```text
[usine:question]
Should egress use HTTP CONNECT or a SOCKS proxy? Both fit the gateway.
```

Pi, Claude, and Codex children interpret these final-answer markers as `AgentBlockedError` and `AgentQuestionError`; `reportedOutcome` reads them and `reportText` writes them back. A parent's blocker becomes a non-retryable `BlockedFailure` on the Attempt channel, and its question a non-retryable `QuestionFailure`, so the Run fails, its Loop holds the Item, and the Run waits for operator action. A child's harness failure (`AgentResultError`) reaches the parent as a blocker. A child's report returns to the parent's `subagent` tool call as text opening with its marker, and the tool guidelines tell the parent to return it verbatim. The parent keeps the first child report: a parent that later finishes with an ordinary answer fails with it, and its paraphrase stays in the transcript. Successful siblings do not clear it. Held children can receive guidance and replace a reported answer before release. A marker without details still fails; ordinary prose and marker mentions elsewhere keep their existing behavior.

Model identifiers stay opaque until the selected harness checks its registry. Harness-reported failures use `AgentResultError`, Agent blockers `AgentBlockedError`, and operator questions `AgentQuestionError`; SDK, process, and protocol failures use `SessionOperationError`. `toAttemptFailure` maps only `SessionOperationError` to retryable infrastructure failure, while `ChildSessionBudgetExceededError` becomes a non-retryable `ChildSessionBudgetFailure`.

`@usine/agents/pi/authentication` holds the Pi parent's model and pool rules for other parent runtimes: `splitPiModel` parses `provider/model`, `piAuthentication` reads a provider's credential check, `requiredPiPool` names the pool a provider spends from, and `resolvePiPool` the pool the credential actually pays from.

Configure Pi with either a provider API key or ChatGPT Plus/Pro OAuth for the parent. Pi children require API keys; Claude and Codex children use their CLI login state. The parent-start log records `apiKeys` or `chatgptPlan` according to the resolved credential. The harness SDK and protocol dependencies use exact versions.

`@usine/agents/preflight` provides the Node `preflight(brain, host, environment)` operation. Supply a `ChildProcessSpawner` layer to check a worker without running a prompt. Each check process sees `environment` as a child would: as its complete environment on this machine, or exported on top of a remote host's own. On a `RemoteShell` host each check runs over SSH, an SSH failure (exit code 255) is an incomplete check rather than a missing harness, and a Pi brain is unavailable. It accepts Codex CLI **0.144.0 or 0.153.4**, verifies the Codex ChatGPT account, checks `claude auth status --json` for a Claude subscription, and checks Pi’s model and API-key authentication through the installed SDK. `HarnessUnavailableError` identifies a binary, version, or login gap; `SessionOperationError` reports an incomplete check, including a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

A Codex API-key login, absent login, or unsupported account response produces `PoolUnavailableError`, which requires operator action. The verified authentication method and pool appear in structured logs. An authentication change during a running Codex session ends it before further rate windows are recorded.

The opt-in live contracts run in disposable directories. They steer a child during a waiting command, assert the changed response and event framing, and interrupt another active command. The Codex contract also requires a real rate-window snapshot. The Claude and Codex contracts run each case twice: on this machine, and through `test/fixtures/ssh-shim.sh`, a stand-in SSH client that runs the remote command line locally, which checks the remote command, its exported environment, and its pid file with the real CLIs. Use a supported Codex CLI with a ChatGPT login and a Claude CLI with a subscription login; the Pi contract requires API-key authentication for the specified provider.

Run them with explicit models:

```sh
USINE_CLAUDE_INTEGRATION_MODEL=claude-sonnet-5-5 pnpm --filter @usine/agents test:integration:claude
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

The protocol conformance gate retains 0.144.0 as its baseline. Codex 0.153.4 was also checked against its generated protocol types and the real steering/interruption contracts, including Astra. Other CLI builds require verification before they are accepted.

Each Codex child owns one app-server process. On completion or interruption, usine closes its input and waits for graceful shutdown before publishing the result, so background commands are released. Scope cleanup uses the same bounded shutdown and logs before forcing a stalled process to stop.

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

Agents share the installation’s GitHub App identity. Runtime instructions require comment reviews at the reviewed head commit and the outcome labels defined by the Loop. An agent success label does not satisfy GitHub’s required-review rule; an independent reviewer supplies required approval and the operator merges. See the [review/fix guide](../../apps/docs/src/content/docs/guides/review-fix-loops.md).

Claude children persist their sessions; Codex children start non-ephemeral threads. Their `SessionStarted.harnessSession` records the native session id and worker working directory, and structured launch logs include `harnessSessionId`, `sessionId`, and `cwd`. Resume with `claude --resume <id>` or `codex resume <id>` from that directory on the same worker and account, while its worktree and saved session files still exist. Attempt cleanup removes the worktree.
