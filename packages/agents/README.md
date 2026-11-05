# @usine/agents

Harness descriptors define secret-free credential recipes for gateway access, attempt API keys, and Cloudflare outbound handlers. Each recipe specifies environment variables, the variable that supplies the credential, and configuration files. Gateway recipes select a wire-protocol slot (`anthropic-messages` or `openai-responses`); provider names select provisioner API keys. A descriptor also declares whether its wiring requires a writable attempt home. Worker cloud-init and SSH preflight derive their accepted caller-token variables from the catalog.

The agent layer for [usine](https://github.com/basaltbytes/usine): the Claude Code, Codex, and Pi child backends that an attempt's Pi parent delegates to, their prompts, and harness preflight. The parent runs in the orchestrator as a durable task (`@usine/durable`); its `subagent` tool starts the child that the agent's brain spec selects. [Attempt execution](https://github.com/basaltbytes/usine/blob/main/docs/architecture/execution.mdx) describes each harness.

0.x APIs can change between minor releases. Supply `effect` at the workspace's pinned version. Harness SDKs and protocols are exact-pinned.

The Pi child backend uses the Pi packages pinned together at 1.4.0, matching the parent in `@usine/durable`.

`/harness` exports the platform-free `catalog` and descriptor schemas. Each harness declares its supported session capabilities, including `resume-session`, and defines its display label, worker installation and accepted versions, login files and hosts, credential provider, token price table, and terminal resume command. `catalog.harness` validates registered IDs; `catalog.get` reads a descriptor. Importing this subpath loads no vendor SDK or Node adapter.

`workerImageInputs(catalog)` returns the worker npm packages and image tag from each descriptor's `worker.install`, in catalog order. Harnesses bundled in the orchestrator have no worker packages and don't contribute to the tag. Run `pnpm worker-image:generate` from the repository root after changing installation requirements. It builds the catalog and updates both Dockerfiles, Hetzner cloud-init, and `infra/worker-image/tag.txt`. `pnpm check` rejects stale generated inputs. Claude Code preflight accepts any installed version; the image install version doesn't restrict worker readiness.

## Compose the child backends

`/prompt` and `/runtime` are platform-free: prompt assembly, typed runtime errors, and the `ChildBackend` contracts. `/harness/node` provides `Harnesses`, whose runtimes each own preflight and scoped launch. Registration rejects missing runtimes, missing descriptors, and duplicate runtime IDs. `childDispatcherLayer` (`/children`) selects a registered runtime from the agent's harness. The application composes the production SDKs:

```ts
import { Layer } from "effect";
import { childDispatcherLayer } from "@usine/agents/children";
import { harnessesLive } from "@usine/agents/harness/node";

const childBackendLayer = childDispatcherLayer.pipe(Layer.provide(harnessesLive));
```

`harnessesLayer` uses supplied SDK services; `harnessesLive` supplies the production SDKs. Both layers retain `HarnessRegistrationError` in their error channel. Custom compositions use `Harnesses.layerFrom(catalog, runtimes)`. A `HarnessRuntime` has an ID, `preflight(brain, target)`, and `launch(request)`. `ProbeTarget` names the host, environment, worker, optional provisioned machine, and credential route (`host-login`, `gateway`, `api-key`, or `sandbox-api-key`). Preflight reports capability gaps as `HarnessUnavailableError` values; transport failures and timeouts fail with `SessionOperationError`.

The Node composition requires `ChildProcessSpawner` and `HostLoginLock` (`/runtime`). The lock is keyed by harness, worker, and provisioned machine. Build `harnessesLive` with `hostLoginLockLayer` from `@usine/executor` once at the application root. Provide that registry to both the executor and the attempt runtime. Claude's runtime takes the lock during host-login preflight and while a child starts. `/claude`, `/codex`, and `/pi` also export single-harness `ChildBackend` layers and their SDK contracts.

Child prompts include the rendered loop task unchanged, including edit-and-retry amendments. Parent-written text appears separately as supplemental context and cannot replace the task instructions.

## Harnesses and credentials

- **Parent:** a Pi model with an API key, or an `openai-codex` ChatGPT model through Plus or Pro OAuth. The start log records `apiKeys` or `chatgptPlan`. A child past the run spec's child-session budget stops the parent with `ChildSessionBudgetExceededError`.
- **Claude Code:** the worker's `claude` through the Agent SDK, with `bypassPermissions`, worker-user settings only, and the CLI login. Subscription sessions map `rate_limit_event` reports to `PoolRateLimitsUpdated` for `claudePlan`. The five-hour allowance is the primary window; the latest seven-day allowance, including model-specific allowances, is the secondary window. Each report contains only the observed window. The pool projection preserves the other window across children, attempts, and resumes. Utilization fractions become percentages, reset timestamps use epoch seconds, and omitted reset times remain unknown. Reports without utilization and unsupported allowance types are skipped. API-key sessions emit no Claude plan windows.
- **Codex:** app-server JSON-RPC over stdio, with `approvalPolicy: never` and the CLI login. It checks the login with `account/read` before creating a thread, and records plan rate windows as `PoolRateLimitsUpdated`. An API-key login, no login, or an unsupported account fails with `PoolUnavailableError`, which needs the operator. A change to unsupported authentication ends the session before more rate windows are recorded. If `ChildSession.gatewayCredential` is set, the gateway holds the OpenAI credential and Codex has no login: the child skips the login check and ignores login changes, and its pool follows the credential kind, `chatgptPlan` for a ChatGPT login and `apiKeys` for an API key.
- **Pi children:** an API key for the selected provider, or a ChatGPT subscription login for an `openai-codex/...` model, using the same authentication and billing pools as the parent. Other OAuth providers remain unavailable. Pi reports tokens and cost, but no plan rate windows, so usine cannot warn before Pi sessions reach the ChatGPT plan limit.

Codex rate-window events include the login email returned by `account/read`. A supported account change refreshes that identity before more snapshots are recorded. Gateway-backed children have no local login and leave it absent. Account identity is stored for display and excluded from diagnostic logs.

Codex commands, including preflight's account check, disable plugins, the remote plugin catalog, apps, startup update checks, and analytics with command-line overrides. This stops automatic plugin downloads and their bundled skill sync; local skills remain available. The overrides apply on every worker kind and take precedence over user configuration.

Each adapter records its resolved billing pool on the launched session and every session event. Pi records the provider name as `endpoint` for API-key models, including OpenAI-compatible endpoints and local models. Codex records its selected model provider for API-key sessions. Endpoint names exclude URLs and credentials.

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

## Host login lock

A Claude child holds the `HostLoginLock` of its worker, or of its machine (`ChildRequest.machine`) on a provisioned worker, from process start until its first messages prove the login (a rate-limit or thinking update, an API retry, a model answer, or the turn result), for one minute at most. `launch` returns then.

If the first turn ends with `Failed to refresh OAuth token: another Claude Code process ...` and no tokens spent, another process had the refresh lock. The backend stops the process and relaunches after 15, 30, then 60 seconds, logging each retry at info. Only the running launch is transcribed. If the last launch fails the same way, the parent gets Claude's error as the child's report.

## Background work

Claude children use the CLI's background-task snapshots and session-idle signal to wait for background work and its follow-up answer, without an operator hold. Queued user turns delay completion; ambient watchers don't. An output stream that closes without a completed answer fails with `SessionOperationError`.

The prompts tell parents and children, before returning, to run gates, tests, and CI watches in the foreground, wait for background results and pending checks, finish dependent steps, record real blockers on the issue or pull request, and push commits, since cleanup removes the worktree. This also covers older CLIs without background-task or session-state messages.

## Lost connections

The durable attempt runtime supplies `ChildSessionLifecycle` when it launches a child. Detaching the attempt channel marks that lifecycle as stopping before the executor closes transports and credentials. Child backends leave recovery to the next process: Codex skips reconnect, saved-thread resume, EOF, remote stop commands, and journal removal; Claude Code skips session recovery. Shutdown errors stay out of child failure reports for Codex, Claude Code, and Pi. Direct backend callers can provide the lifecycle service; without it, normal recovery and cleanup apply.

If the SSH connection to a remote Claude child breaks, for example while the orchestrator's machine sleeps, the SSH client exits with `SSH_FAILURE` (255) and the output stream fails. The backend then resumes the child instead of failing it: it stops the Claude process left on the worker with `CHILD_STOP_SCRIPT` and the child's pid file, and starts Claude with the saved session in the same child session, so the parent spends no child budget. A working child gets a message that asks it to check the worktree and continue, followed by the operator messages that it hadn't read. A paused or idle child waits for the operator. Open tool calls end as errors, and token usage and cost carry over.

The backend tries after 5 s, 15 s, 30 s, 1 min, 2 min, and 5 min; a message from Claude resets the count. After the last try, on a local host, or if Claude itself exited, the child fails with `SessionOperationError` as before.

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

Pi children save conversations in `<checkout>/.usine/pi/sessions`. Their `SessionStarted.harnessSession` records the Pi ID, checkout as `cwd`, and session directory as `home`. Keep the checkout and this directory to continue the conversation after the process exits. From `/pi`, build `piRuntime` with `PiSdk` and call `runtime.resume(request, saved.id)` in a scope. Set `request.cwd` to the saved checkout and `request.prompt` to the continuation message; await `RunningSession.result` before closing the scope. Resume uses the same tools, authentication checks, events, and operator controls as launch. An unknown ID fails with `SessionOperationError` instead of starting a new conversation. Preflight uses in-memory sessions.

The durable parent's `subagent` call still ends as interrupted after an orchestrator restart. Saved-session resume is an explicit Pi runtime operation.

## Preflight

`preflight(brain, target)` (`/preflight`, Node) checks a worker without a prompt through the injected `Harnesses` service. Each runtime uses the process spawner and login lock captured when the registry was built. Each check sees the target environment as a child does. On a `RemoteShell` host, checks run over SSH, an SSH failure (exit 255) is an incomplete check rather than a missing harness, and a Pi brain is unavailable.

It accepts Codex CLI **0.164.0 (or 0.159.0 through 0.159.3 for one release)** (`supportedCodexVersions`; `unsupportedCodexVersion` returns the error for other `codex --version` output) with a verified ChatGPT account, a Claude subscription in `claude auth status --json`, and Pi's model and API key or `openai-codex` ChatGPT login through the SDK. `HarnessUnavailableError` reports a missing binary, version, or login; `SessionOperationError` an incomplete check, such as a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

## Live contract tests

The opt-in live contracts, in disposable directories, steer a child during a waiting command, checking the response and event framing, and interrupt another; Codex also needs a real rate-window snapshot. Claude and Codex cases also run through `test/fixtures/ssh-shim.sh`, an SSH stand-in that runs the remote command locally, to check it, its environment, and its pid file with the real CLIs.

They need a supported Codex CLI with a ChatGPT login, a Claude CLI with a subscription login, an API key or ChatGPT login for the Pi provider, and explicit models:

```sh
USINE_CLAUDE_INTEGRATION_MODEL=claude-sonnet-5-5 pnpm --filter @usine/agents test:integration:claude
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

The protocol conformance baseline is 0.164.0. Preflight retains 0.159.0 through 0.159.3 for one release so existing worker images can upgrade, and refuses 0.153.4. Install 0.164.0 for its updated TLS certificate roots. Other CLI builds need verification first.

Provider capacity refusals use `AgentCapacityError`, which maps to `ProviderCapacityFailure`. Codex's `serverOverloaded` code and Claude's `overloaded` code take precedence over error text. HTTP 529 and HTTP 503 with a retry hint also qualify. When a harness exposes only text, `harnessFailure` recognizes “Selected model is at capacity”, `overloaded_error`, HTTP 529, and 503 with a retry hint. Other task failures remain `AgentResultError`.

`reportText` relays capacity refusals with `[usine:provider-capacity]`; `reportedOutcome` restores their classification. Pi children classify the final assistant error when a turn settles, including when SDK retries are disabled or the SDK does not retry that error. A successful SDK retry completes normally.

## CI handoff

For a loop with a CI policy, the task instructs the agent to push, record completion labels in a `[usine:awaiting-ci]` JSON answer, and end its session. The parent relays that answer unchanged. usine checks the harvested PR head and waits for CI before applying those labels. The agent must leave completion labels for the monitor. Other loops retain ordinary final answers.

Remote Codex children run under a detached Node supervisor. Preflight checks that Node.js is available on the remote command path. An SSH drop reconnects to the same app-server and replays buffered output; sequence numbers prevent repeated input from starting another turn. The relay journals only newline-terminated input frames and discards an incomplete tail on disconnect, so reconnection resends it without stopping the app-server. If the app-server exits, the child resumes its saved thread once before reporting a failure. Recovery replays unread operator guidance in order and reports delivery after the recovered turn accepts it. A paused or idle child waits for operator guidance and includes unread messages when it resumes. Codex recording that resumed input acknowledges the queued guidance, so later pauses do not replay it. A working child resends its original task if no user message was saved, or starts a continuation turn otherwise. Preflight continues to use a short-lived process.

## Schema contracts

Session records and errors use nominal Schema brands. Construct records with their schema’s `make` method. Codex request serialization is pure over validated parameters. Child backends decode responses inside Effects and report invalid responses through session operation errors.

The harness implementations are grouped under `src/harness/claude/`, `src/harness/codex/`, and `src/harness/pi/`. Shared dispatch, conversation, session-channel, and usage helpers are in `src/harness/`. Consumers use the published subpaths shown above.

Run `pnpm --filter @usine/agents check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## Step outputs

Parent and child completion instructions describe `.usine/outputs/<name>.json`: a non-empty opaque `type` of at most 128 UTF-16 code units, optional pinned-base `commit`, and JSON `content`. Both prompts include the pinned base commit, even when the checkout resumes from salvage. Agents leave child outputs in place and keep `.usine/` out of commits. The limit is ten outputs per attempt and 8 MiB per file and per compact JSON content body.
