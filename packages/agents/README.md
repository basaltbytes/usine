# @usine/agents

The agent layer for [usine](https://github.com/basaltbytes/usine): the Claude Code, Codex, and Pi child backends that an attempt's Pi parent delegates to, their prompts, and harness preflight. The parent runs in the orchestrator as a durable task (`@usine/durable`); its `subagent` tool starts the child that the agent's brain spec selects. [Attempt execution](https://docs.usine.dev/architecture/execution/) describes each harness.

0.x APIs can change between minor releases. Supply `effect` at the workspace's pinned version. Harness SDKs and protocols are exact-pinned.

## Compose the child backends

`/prompt` and `/runtime` are platform-free: prompt assembly, typed runtime errors, and the `ChildBackend` contracts. `childDispatcherLayer` (`/children`) picks a backend from the agent's `harness`. Provide its three backends from `/claude`, `/codex`, and `/pi`, which also export their SDK contracts and production SDK layers. `@usine/durable/live` composes them:

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

The Claude backend also needs `ClaudeLoginLock` (`/runtime`), which every Claude command that can refresh a Claude login takes: one lock per worker, or per machine of a provisioned worker, whose machines each have their own login. Give the same instance (`claudeLoginLockLayer` from `@usine/executor`) to the backends and the executor running preflight. Like Codex's app server, it also needs a `ChildProcessSpawner`, to stop a child on its worker before it resumes the child.

## Harnesses and credentials

- **Parent:** a Pi model with an API key, or an `openai-codex` ChatGPT model through Plus or Pro OAuth. The start log records `apiKeys` or `chatgptPlan`. A child past the run spec's child-session budget stops the parent with `ChildSessionBudgetExceededError`.
- **Claude Code:** the worker's `claude` through the Agent SDK, with `bypassPermissions`, worker-user settings only, and the CLI login.
- **Codex:** app-server JSON-RPC over stdio, with `approvalPolicy: never` and the CLI login. It checks the login with `account/read` before creating a thread, and records plan rate windows as `PoolRateLimitsUpdated`. An API-key login, no login, or an unsupported account fails with `PoolUnavailableError`, which needs the operator. A login change ends the session before more rate windows are recorded. If `ChildSession.gatewayCredential` is set, the gateway holds the OpenAI credential and Codex has no login: the child skips the login check and ignores login changes, and its pool follows the credential kind, `chatgptPlan` for a ChatGPT login and `apiKeys` for an API key.
- **Pi children:** API keys only.

Logs record the verified authentication method and pool. On completion or interrupt, usine closes the input of the child's Codex app server and waits for it to exit before publishing, releasing background commands. Scope cleanup does the same, bounded, and logs before force-stopping a stalled process.

`/pi/authentication` exports the parent's rules for other runtimes: `splitPiModel` (parses `provider/model`), `piAuthentication` (a provider's credential check), `requiredPiPool` (a provider's pool), and `resolvePiPool` (its credential's pool).

`/openai-prices` exports `openAiPrice`, which prices the token breakdown of a Codex session's `SessionTokensUpdated` at OpenAI's API rates. It returns `None` for a model that the bundled table lacks. The table covers the listed models of each supported Codex CLI version.

## Child hosts

`ChildRequest.host` (`/child-host`) sets where a child runs, and `ChildRequest.worker` names that machine's worker:

- `LocalProcess`: on this machine, with `ChildRequest.environment` as the whole environment.
- `RemoteShell`: one `ssh <args> <destination> -- <remote command>`, which enters the worktree, exports the request's environment over the machine's own, writes its pid to `<worktree>.child-<n>.pid`, and runs the harness. The SSH client gets only `RemoteShell.sshEnvironment`. With `container`, the remote command is `<runtime> exec -i <name> sh -c <command line>`, so the directory, variables, and pid file are inside that container.

Executors run `CHILD_KILL_SCRIPT` remotely to stop every child in those pid files before keeping or removing a worktree. Claude Code runs remotely through `spawnClaudeCodeProcess`, Codex over the same SSH command. Pi children run tools in this process and fail on `RemoteShell` with `AgentResultError`. They get only Pi's default tools, `read`, `bash`, `edit`, and `write`, whatever the global Pi `defaultTools` setting adds, and `bash` runs with exactly `ChildRequest.environment`.

The worktree is repo-controlled input: Pi ignores the project's `.pi/` settings, extensions, prompt templates, skills, and themes; Claude omits project setting sources; Codex marks the worktree untrusted. AGENTS instructions still apply. The executor isolates the worker.

## Session events and operator actions

Child output becomes typed events: `SessionStarted`, `TextOutput` for completed assistant text (streaming deltas stay out of the transcript), tool calls, pool observations, and `SessionFinished`. Each child session has one parent session; recursive child events can't enter the public model.

`RunningSession.intervene(action, onDelivery)` applies steer, interrupt, and holds. A message to an idle or paused child starts a turn and emits `SessionResumed`. A message to a working child joins the turn and returns `InterventionState.queued`; `onDelivery` runs once, with the child's state when the harness reads it, or with none if the child stops first. Pi reads it when the queued steering message starts, Codex when it records a `userMessage` item, and Claude Code with a result whose `queued_turn_count` no longer counts it. A finished turn has read all its queued messages.

## Claude login lock

A Claude child holds the `ClaudeLoginLock` of its worker, or of its machine (`ChildRequest.machine`) on a provisioned worker, from process start until its first messages prove the login (a rate-limit or thinking update, an API retry, a model answer, or the turn result), for one minute at most. `launch` returns then.

If the first turn ends with `Failed to refresh OAuth token: another Claude Code process ...` and no tokens spent, another process had the refresh lock. The backend stops the process and relaunches after 15, 30, then 60 seconds, logging each retry at info. Only the running launch is transcribed. If the last launch fails the same way, the parent gets Claude's error as the child's report.

## Background work

Claude children use the CLI's background-task snapshots and session-idle signal to wait for background work and its follow-up answer, without an operator hold. Queued user turns delay completion; ambient watchers don't. An output stream that closes without a completed answer fails with `SessionOperationError`.

The prompts tell parents and children, before returning, to run gates, tests, and CI watches in the foreground, wait for background results and pending checks, finish dependent steps, record real blockers on the issue or pull request, and push commits, since cleanup removes the worktree. This also covers older CLIs without background-task or session-state messages.

## Lost connections

If the SSH connection to a remote Claude child breaks, for example while the orchestrator's machine sleeps, the SSH client exits with `SSH_FAILURE` (255) and the output stream fails. The backend then resumes the child instead of failing it: it stops the Claude process left on the worker with `CHILD_STOP_SCRIPT` and the child's pid file, and starts Claude with the saved session in the same child session, so the parent spends no child budget. A working child gets a message that asks it to check the worktree and continue, followed by the operator messages that it hadn't read. A paused or idle child waits for the operator. Open tool calls end as errors, and token usage and cost carry over.

The backend tries after 5 s, 15 s, 30 s, 1 min, 2 min, and 5 min; a message from Claude resets the count. After the last try, on a local host, or if Claude itself exited, the child fails with `SessionOperationError` as before. A Codex child whose SSH connection breaks fails.

## Outcome markers

An unresolved blocker starts the final answer with `[usine:blocked]`, then details and incomplete work on that line or the next:

```text
[usine:blocked]
Repository permission denied; publishing remains incomplete.
```

An operator-only decision starts it with `[usine:question]` and the question, which the prompt tells the agent to post on the item first:

```text
[usine:question]
Should egress use HTTP CONNECT or a SOCKS proxy? Both fit the gateway.
```

`reportedOutcome` reads markers as `AgentBlockedError` and `AgentQuestionError`, and `reportText` writes them. A parent's blocker becomes a non-retryable `BlockedFailure` and its question a non-retryable `QuestionFailure`: the run fails, its loop suppresses the item, and the run waits for the operator. A child's harness failure (`AgentResultError`) goes to the parent as a `[usine:failed]` report that `reportedOutcome` reads back, so the attempt ends with `AgentFailure` and suppresses nothing: the harness posted nothing.

A child's report returns to the parent's `subagent` call as text opening with its marker, to return verbatim. The parent keeps the first: a later ordinary answer fails with it, and the paraphrase stays in the transcript. Successful siblings don't clear it. Held children can take guidance and replace their answer before release. A marker without details still fails.

Model ids stay opaque until the harness checks its registry. Task failures use `AgentResultError`. `toAttemptFailure` maps `SessionOperationError` (SDK, process, and protocol failures) to a retryable infrastructure failure; `ChildSessionBudgetExceededError` becomes a non-retryable `ChildSessionBudgetFailure`.

## GitHub identity and reviews

Agents share the installation's GitHub App identity. The instructions require comment reviews at the reviewed head and the loop's outcome labels. A success label doesn't satisfy GitHub's required review: an independent reviewer approves and the operator merges. See [Write review and fix loops](https://docs.usine.dev/guides/review-fix-loops/).

## Resume a harness session

Claude children save sessions, and Codex threads aren't ephemeral. `SessionStarted.harnessSession` and launch logs (`harnessSessionId`, `sessionId`, `cwd`) give the id and directory. While the worktree and session files exist, run `claude --resume <id>` or `codex resume <id>` there, on the same worker and account. A Codex child whose environment sets `CODEX_HOME` saves its sessions there, and `HarnessSession.home` and the launch log's `home` record that directory: run `CODEX_HOME=<home> codex resume <id>`. An attempt behind a gateway gets its own `CODEX_HOME`, and its model credential isn't in your shell.

## Preflight

`preflight(brain, host, environment)` (`/preflight`, Node) checks a worker without a prompt, using a `ChildProcessSpawner` layer. Each check sees `environment` as a child does. On a `RemoteShell` host, checks run over SSH, an SSH failure (exit 255) is an incomplete check rather than a missing harness, and a Pi brain is unavailable.

It accepts Codex CLI **0.153.4 or 0.159.0 through 0.159.3** (`supportedCodexVersions`; `unsupportedCodexVersion` returns the error for other `codex --version` output) with a verified ChatGPT account, a Claude subscription in `claude auth status --json`, and Pi's model and API key through the SDK. `HarnessUnavailableError` reports a missing binary, version, or login; `SessionOperationError` an incomplete check, such as a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

## Live contract tests

The opt-in live contracts, in disposable directories, steer a child during a waiting command, checking the response and event framing, and interrupt another; Codex also needs a real rate-window snapshot. Claude and Codex cases also run through `test/fixtures/ssh-shim.sh`, an SSH stand-in that runs the remote command locally, to check it, its environment, and its pid file with the real CLIs.

They need a supported Codex CLI with a ChatGPT login, a Claude CLI with a subscription login, an API key for the Pi provider, and explicit models:

```sh
USINE_CLAUDE_INTEGRATION_MODEL=claude-sonnet-5-5 pnpm --filter @usine/agents test:integration:claude
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

The protocol conformance baseline is 0.159.2. Codex 0.159.0, 0.159.1, and 0.159.3 have the same protocol crates. Codex 0.153.4 passed the real steering and interruption contracts, including Astra, and its generated types have the same shape as 0.159.2's for every field the adapter uses. Other CLI builds need verification first.

Provider capacity refusals use `AgentCapacityError`, which maps to `ProviderCapacityFailure`. Codex's `serverOverloaded` code and Claude's `overloaded` code take precedence over error text. HTTP 529 and HTTP 503 with a retry hint also qualify. When a harness exposes only text, `harnessFailure` recognizes “Selected model is at capacity”, `overloaded_error`, HTTP 529, and 503 with a retry hint. Other task failures remain `AgentResultError`.

`reportText` relays capacity refusals with `[usine:provider-capacity]`; `reportedOutcome` restores their classification. Pi children report capacity when their provider retries end unsuccessfully.
