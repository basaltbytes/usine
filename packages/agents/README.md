# @usine/agents

Harness descriptors define secret-free credential recipes for gateway access, attempt API keys, and Cloudflare outbound handlers. Each recipe specifies environment variables, the variable that supplies the credential, and configuration files. A child receives the attempt base environment plus its selected harness's wiring. `worker.login.environment` declares harness-owned host variables; `catalog.environmentFor` removes other harnesses' variables before admission and launch. Gateway recipes select a wire-protocol slot (`anthropic-messages` or `openai-responses`); provider names select provisioner API keys. A descriptor also declares whether its wiring requires a writable attempt home. `worker.sessionDirectory` declares a directory under the container home that SSH workers persist for the attempt independently of credential wiring. Claude Code declares `.claude/projects`, so its saved conversations survive container recreation while the checkout remains. Worker cloud-init and SSH preflight derive their accepted caller-token variables from the catalog.

The agent layer for [usine](https://github.com/basaltbytes/usine): the Claude Code, Codex, and Pi child backends that an attempt's Pi parent delegates to, their prompts, and harness preflight. The parent runs in the orchestrator as a durable task (`@usine/durable`); its `subagent` tool starts the child that the agent's brain spec selects. [Attempt execution](https://github.com/basaltbytes/usine/blob/main/docs/architecture/execution.mdx) describes each harness.

0.x APIs can change between minor releases. Supply `effect` at the workspace's pinned version. Harness SDKs and protocols are exact-pinned.

The Pi child backend uses the Pi packages pinned together at 1.4.0, matching the parent in `@usine/durable`.

`/harness` exports the platform-free `catalog` and descriptor schemas. Each harness declares its supported session capabilities, including `resume-session`, and defines its display label, worker installation and accepted versions, login files and hosts, credential provider, token price table, and terminal resume command. `catalog.harness` validates registered IDs; `catalog.get` reads a descriptor. Importing this subpath loads no vendor SDK or Node adapter.

A role is a `RoleSpec` value in the module that owns it: its name, the placements and credential routes it accepts with the reason it refuses the rest, whether it keeps the harness's own tools, whether it runs a usine tool set, whether its conversation is saved, journaled, or ephemeral, whether it takes interventions, and whether it returns text or a structured value. `requirements(role)` derives the harness capabilities from those fields: a usine tool set needs `usine-tools`, closed native tools need `closed-tools`, structured output needs `structured-output`, an ephemeral session needs `ephemeral`, a journaled one needs `durable-coordination`, interventions need `steer` and `interrupt`, and every session needs `token-usage`. A journaled session takes its tools from the journal, so it needs no `usine-tools` or `closed-tools`. `codingAgent` runs on workers with any credential route; the coordinator is declared with the parent in `@usine/durable`.

`admitBrain(catalog, role, brain, context, { reopens })` checks a role at a placement and credential route without IO. `reopens` adds `resume-session` for a session that reopens a saved conversation. A refusal lists each missing capability, placement, or credential route with the reason that the role or the descriptor gives. `AdmittedBrain` carries the role, brain, route, and the billing pool that the route determines: `gateway-api-key` sets `apiKeys`, `gateway-subscription` sets the plan of the provider that the descriptor's worker credential names, and every other route, or a subscription on a descriptor that names no provider such as Pi, leaves the pool to the harness at launch. Each descriptor declares supported capabilities and reasons for absent capabilities per route, including `plan-windows` for Claude Code and Codex subscription routes. A descriptor declares only the capabilities whose contract scenarios its adapter passes. Claude Code and Pi declare `usine-tools` and `closed-tools`; Codex lacks both until step 19 of the harness adapter plan, and no harness declares `structured-output` or `ephemeral`.

`workerImageInputs(catalog)` returns the worker npm packages and image tag from each descriptor's `worker.install`, in catalog order. Harnesses bundled in the orchestrator have no worker packages and don't contribute to the tag. Run `pnpm worker-image:generate` from the repository root after changing installation requirements. It builds the catalog and updates both Dockerfiles, Hetzner cloud-init, and `infra/worker-image/tag.txt`, with pnpm at the root `packageManager` version. `pnpm check` rejects stale generated inputs. Claude Code preflight accepts any installed version; the image install version doesn't restrict worker readiness.

## Compose the child backends

`/prompt` and `/runtime` are platform-free: prompt assembly, typed runtime errors, the `ChildBackend` contracts, and `RestartState`, the conversation state that a saved session restores after a restart. `/harness/node` provides `Harnesses`, whose runtimes each own preflight and scoped native sessions. Registration rejects missing runtimes, missing descriptors, and duplicate runtime IDs. `childDispatcherLayer` (`/children`) selects a registered runtime from the agent's harness. The application composes the production SDKs:

```ts
import { Layer } from "effect";
import { childDispatcherLayer } from "@usine/agents/children";
import { harnessesLive } from "@usine/agents/harness/node";

const childBackendLayer = childDispatcherLayer.pipe(Layer.provide(harnessesLive));
```

`harnessesLayer` uses supplied SDK services; `harnessesLive` supplies the production SDKs. Both layers retain `HarnessRegistrationError` in their error channel. Custom compositions use `Harnesses.layerFrom(catalog, runtimes)`. Registered runtimes open and stop sessions with only their own harness's host variables. They admit each opened session's brain for the role in its spec at its placement and credential route, adding `resume-session` for a `StartResume`, and admit preflight brains as coding agents with that catalog. A `HarnessRuntime` has an ID, `preflight(brain, target)`, `open(spec, start, continuation, tools?)`, and `stop(spec)`; it names no role. The registry refuses a session that opens with a toolkit when its role runs no usine tool set, or without one when its role runs one.

`/harness/contract` exports the role-neutral session input. A `SessionSpec` holds the session identity (`ParentSession`, `ChildSession`, or `RoleSession`), the placement and credential route, the host, worker, provisioned machine, checkout, and environment. `StartPrompt` starts a conversation with its first message; `StartResume` reopens a saved `HarnessSession` without sending one. `open` returns a `NativeSession`: the running session, whether a reopened process was already in a turn, and the recovery of interrupted tool calls. Adapters read only the spec, the start, and the continuation policy, so a role other than the child opens a session the same way. Open it through `Harnesses`, which admits the spec before the adapter starts:

```ts
import { Effect } from "effect";
import { continuationPolicy } from "@usine/agents/continuation";
import { type SessionSpec, StartPrompt } from "@usine/agents/harness/contract";
import { Harnesses } from "@usine/agents/harness/node";
import { RestartState } from "@usine/agents/runtime";

const openSession = (spec: SessionSpec, prompt: string) =>
  Effect.gen(function* () {
    const runtime = yield* (yield* Harnesses).runtime(spec.session.brain.harness);
    const policy = yield* continuationPolicy(spec, prompt, RestartState.make({}));
    return yield* runtime.open(spec, StartPrompt.make({ text: prompt }), policy);
  });
```

### Usine tool sets

A role that runs a usine tool set passes an `effect/ai` `Toolkit` as the last argument of `open`. The handlers come from the calling context, so the role decides what each call reaches, such as the member token that an operator tool acts with:

```ts
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

const ReadNote = Tool.make("read_note", {
  description: "Reads a note.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
});
const notes = Toolkit.make(ReadNote);
const noteHandlers = notes.toLayer({ read_note: ({ name }) => Effect.succeed(`Note ${name}`) });

const openWithNotes = (spec: SessionSpec, prompt: string) =>
  Effect.gen(function* () {
    const runtime = yield* (yield* Harnesses).runtime(spec.session.brain.harness);
    const policy = yield* continuationPolicy(spec, prompt, RestartState.make({}));
    return yield* runtime.open(spec, StartPrompt.make({ text: prompt }), policy, notes);
  }).pipe(Effect.provide(noteHandlers));
```

Claude Code serves the toolkit as the in-process MCP server `usine`, whose calls travel over the CLI's own stdio, so they work on every worker kind. Its tools load in the first prompt instead of behind Claude Code's tool search. Pi serves the toolkit as custom tools. When the role sets `nativeTools: false`, the session lists only the toolkit's tools: Claude Code starts with no built-in tool and ignores every other MCP configuration, and Pi activates no tool of its own.

`ToolStarted` and `ToolFinished` carry the toolkit's names, without the `mcp__usine__` prefix. A name that a harness can't carry, because it is longer than the model API accepts, has other characters than letters, digits, `_`, and `-`, or takes the name of one of Pi's own tools, gets a stable alias that maps back. A handler failure, invalid parameters, or a handler defect returns an error result to the model, and the session continues; a defect is also logged with its cause.

`childContinuation(catalog, runtime)` (`/continuation`) is the child role over a runtime. Each `launch`, `resume`, or `stop` builds a `SessionSpec` from the `ChildRequest`. `launch` and `resume` first admit the child with the catalog, including the credential-provider lookup, and also build a `RestartState`. The continuation policy carries the restart state, so adapters read operator holds, pauses, unread messages, and committed usage from it. `ProbeTarget` names the host, environment, placement, worker, optional provisioned machine, and credential route. The placement and route use the admission vocabulary (`Placement` and `CredentialRoute`), so a sandbox probe is the `api-key` route at the `sandbox` placement. Preflight reports capability gaps as `HarnessUnavailableError` values; transport failures and timeouts fail with `SessionOperationError`.

Use `harnessesLiveFrom(catalog, configure)` to extend or reuse the raw built-in adapters before registry admission wraps them. The callback receives adapters with the production SDKs; return the runtimes for the supplied catalog.

The Node composition requires `ChildProcessSpawner` and `HostLoginLock` (`/runtime`). The lock is keyed by harness, worker, and provisioned machine. Build `harnessesLive` with `hostLoginLockLayer` from `@usine/executor` once at the application root. Provide that registry to both the executor and the attempt runtime. Claude's runtime takes the lock during host-login preflight and while a child starts. `/claude`, `/codex`, and `/pi` also export single-harness `ChildBackend` layers and their SDK contracts.

`ChildRequest.resume` selects a saved `HarnessSession` to continue in the request's checkout. Launch admission adds the `resume-session` requirement for that placement and credential route. Claude Code, Codex, and Pi compare the saved home with the current configuration before resuming; a moved home fails with `ContinuationMismatchError`. Codex also compares the saved `HarnessSession.modelProvider` with the app-server's selected provider before starting a turn. Gateway credential-kind changes keep the same `usine-gateway` provider ID. Older records without a provider ID acquire it on their next successful resume. Claude Code and Codex reattach a retained remote process when its exported child environment matches. An environment change stops that process before a saved-session launch. `ChildBackend.stop` stops a retained remote child without starting a conversation turn; recovery dispatches it through the saved harness when the configured harness changes. `ChildRequest.held` restores an operator hold before the first turn, keeping an idle child addressable until release. `ChildRequest.paused` restores an interrupted child as idle and waits for a steer or operator message before starting another turn. Releasing a hold preserves the pause. `ChildRequest.usage` restores committed token and cost totals for Claude Code and Pi. Claude also saves the current process total and the assistant message IDs that can recur or remain uncheckpointed, so reattaching it preserves usage accumulated by earlier processes without counting retained or replayed usage again. A failed resume returns a typed session error.

Child prompts include the rendered loop task unchanged, including edit-and-retry amendments. Parent-written text appears separately as supplemental context and cannot replace the task instructions.

## Harnesses and credentials

- **Parent:** a Pi model with an API key, or an `openai-codex` ChatGPT model through Plus or Pro OAuth. The start log records `apiKeys` or `chatgptPlan`. A child past the run spec's child-session budget stops the parent with `ChildSessionBudgetExceededError`.
- **Claude Code:** the worker's `claude` through the Agent SDK, with `bypassPermissions`, worker-user settings only, and the CLI login. Subscription sessions map `rate_limit_event` reports to `PoolRateLimitsUpdated` for `claudePlan`. The five-hour allowance is the primary window; the latest seven-day allowance, including model-specific allowances, is the secondary window. Each report contains only the observed window. The pool projection preserves the other window across children, attempts, and resumes. Utilization fractions become percentages, reset timestamps use epoch seconds, and omitted reset times remain unknown. Reports without utilization and unsupported allowance types are skipped. API-key sessions emit no Claude plan windows.
- **Codex:** app-server JSON-RPC over stdio, with `approvalPolicy: never` and the CLI login. It checks the login with `account/read` before creating a thread, and records plan rate windows as `PoolRateLimitsUpdated`. An API-key login, no login, or an unsupported account fails with `PoolUnavailableError`, which needs the operator. A change to unsupported authentication ends the session before more rate windows are recorded. If the session's credential route is `gateway-subscription` or `gateway-api-key`, the gateway holds the OpenAI credential and Codex has no login: the child skips the login check and ignores login changes, and its pool follows the credential kind, `chatgptPlan` for a ChatGPT login and `apiKeys` for an API key.
- **Pi children:** an API key for the selected provider, or a ChatGPT subscription login for an `openai-codex/...` model, using the same authentication and billing pools as the parent. Other OAuth providers remain unavailable. Pi reports tokens and cost, but no plan rate windows, so usine cannot warn before Pi sessions reach the ChatGPT plan limit.

Codex rate-window events include the login email returned by `account/read`. A supported account change refreshes that identity before more snapshots are recorded. Gateway-backed children have no local login and leave it absent. Account identity is stored for display and excluded from diagnostic logs.

Codex commands, including preflight's account check, disable plugins, the remote plugin catalog, apps, startup update checks, and analytics with command-line overrides. This stops automatic plugin downloads and their bundled skill sync; local skills remain available. The overrides apply on every worker kind and take precedence over user configuration.

Each adapter records its resolved billing pool on the launched session and every session event. Pi records the provider name as `endpoint` for API-key models, including OpenAI-compatible endpoints and local models. Codex records its selected model provider for API-key sessions. Endpoint names exclude URLs and credentials.

Logs record the verified authentication method and pool. On completion or interrupt, usine closes the input of the child's Codex app server and waits for it to exit before publishing, releasing background commands. Scope cleanup does the same, bounded, and logs before force-stopping a stalled process.

`/pi/authentication` exports the parent's rules for other runtimes: `splitPiModel` (parses `provider/model`), `piAuthentication` (a provider's credential check), `requiredPiPool` (a provider's pool), and `resolvePiPool` (its credential's pool).

`/pi/refusal` exports `piFailure`, which classifies the error that ended a Pi turn, so that the parent's failed turn reports a usage limit as a child's does.

`/openai-prices` exports `openAiPrice`, which prices the token breakdown of a Codex session's `SessionTokensUpdated` at OpenAI's API rates. It returns `None` for a model that the bundled table lacks. The table covers the listed models of each supported Codex CLI version.

## Child hosts

The supervisor and lifeline are TypeScript programs in `src/child-host/worker/`. `build-worker.mjs` bundles and minifies them with esbuild into `src/child-host/programs.ts`, using `ownerProgram` from `worker/program.ts` for the supervisor bootstrap. `build` and `check` run it first. The Vitest global setup, `test/child-host/generate-programs.ts`, runs it before the first run and, in watch mode, whenever a file in `src/child-host/worker/` changes. Each such change reruns the affected tests once, so `vitest` never loads a stale bundle. The generated `programs.ts` stays out of git; `programs.d.ts` lets source tools resolve the module before generation. Only `build` writes the standalone bundles to `dist/child-host/worker/`, which the published package includes. Workers need Node.js and their harness binaries.

`build`, `check`, the `codex:*` scripts, and the Vitest global setup run Node.js with `--experimental-strip-types`, which needs Node.js 22.6 or later; earlier 22.x releases fail with `bad option`. `engines` stays at `>=22` because the published package and its worker programs don't use the flag.

Run `pnpm --filter @usine/agents test` for the direct worker tests and harness tests. The direct tests run real Node processes against temporary journals and inject a process identity reader that works on Linux and macOS. Production remote owners use Linux `/proc` boot IDs and process start times. The orchestrator relay keeps replay history and output checkpoints in Effect refs and separates connection, replay, streaming, and reattachment.

A supervisor that fails during setup, for example because it cannot read its own or its lifeline's process identity, records the failure as the harness exit before it exits, so the relay reports it at once. By then the lifeline has usually started the harness; the supervisor's exit closes the lifeline pipe, which stops it. One window stays open: if the transport directory is removed between the lifeline starting the harness and recording its PID there, the lifeline fails and the harness runs on without an owner. Only a stop or cleanup of the same child removes that directory, so the window isn't expected to be reachable.

`ChildRequest.host` (`/child-host`) sets where a child runs, and `ChildRequest.worker` names that machine's worker:

- `LocalProcess`: on this machine, with `ChildRequest.environment` as the whole environment.
- `RemoteShell`: one `ssh <args> <destination> -- <remote command>`, which connects to the worker process owner and sends the request's environment as the first stdin message. The owner adds those variables to the supervisor's environment without including their values in SSH or container command arguments. Stop and remove commands receive no child environment. The owner records its PID in `<worktree>.child-<n>.pid` and runs the harness in its own process group. The SSH client gets only `RemoteShell.sshEnvironment`. An optional `RemoteShell.stdinEnvironment` contains redacted secret variables. The remote shell reads a base64-encoded block of quoted exports before the child protocol starts; the values stay out of command arguments and files. Callers using `sshArguments` directly pair it with `remoteInput` to prepend the block to the command's input stream; the command line then starts with `STDIN_ENVIRONMENT_PREFIX`. `hostSpawn` and `hostCommand` take the command's input as a stream, as `HostCommandOptions`. With `container`, the remote command is `<runtime> exec -i <name> sh -c <command line>`, so the directory, variables, and pid file are inside that container.
- `ExecShell`: the same remote command line, process owner, `stdinEnvironment`, and `container` as `RemoteShell`, run through an `ExecTransport` in this process instead of a local SSH client. `hostSpawn` returns a process handle for any host. On an exec shell, `stdout` and `stderr` end with every byte received, and a command that the transport loses fails `exitCode` with a `PlatformError` whose cause is `HostUnreachable`, where an SSH client exits with `SSH_FAILURE`. `hostOutput` fails with `HostUnreachable` for either, and the process owner reattaches after either. `kill` cancels the command and reports exit code 143. A transport may end the output streams when the command's leader process exits. A command without input reads end of file at once, where an SSH client keeps an open pipe unless its host has a `stdinEnvironment`, which it reads before end of file. An input stream that fails closes the command's stdin with a warning, even when `endOnDone` is `false`.

Executors run `CHILD_KILL_SCRIPT` remotely to stop every child in those pid files and remove transport journals before keeping or removing a worktree. Claude Code runs remotely through `spawnClaudeCodeProcess`, Codex over the same SSH command. Pi children run tools in this process and fail on `RemoteShell` with `AgentResultError`. They get only Pi's default tools, `read`, `bash`, `edit`, and `write`, whatever the global Pi `defaultTools` setting adds, and `bash` runs with exactly `ChildRequest.environment`.

The worktree is repo-controlled input: Pi ignores the project's `.pi/` settings, extensions, prompt templates, skills, and themes; Claude omits project setting sources; Codex marks the worktree untrusted. AGENTS instructions still apply. The executor isolates the worker.

Codex starts its app server in `/` and applies checkout trust through a top-level `projects` table override. Project-local configuration, hooks, and exec policies stay disabled even when Codex's saved configuration lists the checkout as trusted. Starting outside the home directory also avoids diagnostics about disabled project configuration in the worker's `.codex` directory. Other Codex diagnostics log at Warning.

## Session events and operator actions

Child output becomes typed events: `SessionStarted`, `TextOutput` for completed assistant text (streaming deltas stay out of the transcript), tool calls, pool observations, and `SessionFinished`. Each child session has one parent session; recursive child events can't enter the public model.

`ChildRequest.idle` restores a completed report without starting a turn. Release returns that report unless the child is paused; operator guidance starts another turn. `SessionIdle.message` supplies the report for durable recovery.

`RunningSession.intervene(action, onDelivery)` applies steer, interrupt, and holds. A message to an idle or paused child starts a turn and emits `SessionResumed`. A message to a working child joins the turn and returns `InterventionState.queued`; `onDelivery` runs once, with the child's state when the harness reads it, or with none if the child stops first. Pi reads it when the queued steering message starts, Codex when it records a `userMessage` item, and Claude Code with a result whose `queued_turn_count` no longer counts it. A finished turn has read all its queued messages.

## Host login lock

A Claude child holds the `HostLoginLock` of its worker, or of its machine (`ChildRequest.machine`) on a provisioned worker, from process start until its first messages prove the login (a rate-limit or thinking update, an API retry, a model answer, or the turn result), for one minute at most. `launch` returns then.

If the first turn ends with `Failed to refresh OAuth token: another Claude Code process ...` and no tokens spent, another process had the refresh lock. The backend stops the process and relaunches after 15, 30, then 60 seconds, logging each retry at info. Only the running launch is transcribed. If the last launch fails the same way, the parent gets Claude's error as the child's report.

## Background work

Claude children use the CLI's background-task snapshots and session-idle signal to wait for background work and its follow-up answer, without an operator hold. Queued user turns delay completion; ambient watchers don't. An output stream that closes without a completed answer fails with `SessionOperationError`.

The prompts tell parents and children, before returning, to run gates, tests, and CI watches in the foreground, wait for background results and pending checks, finish dependent steps, record real blockers on the issue or pull request, and push commits, since cleanup removes the worktree. This also covers older CLIs without background-task or session-state messages.

## Process ownership and lost connections

`@usine/agents/child-host/owner` is the Node process boundary for stdio and HTTP harnesses. Claude Code supplies its SDK process callback through this owner, and Codex uses it for app-server stdio. Harness adapters translate SDK or RPC messages; the owner manages process groups, stderr, exit monitoring, transport recovery, and termination. The `/child-host` schemas remain platform-free.

Call `startChildProcess(target, command, input, options?)` in a scope with `ChildProcessSpawner`. `ProcessTarget` supplies the host, environment, checkout, and optional child session ID; `ProcessCommand` supplies the executable, arguments, and working directory. The optional `ProcessOptions` record has three fields: `transport` (`"replace"` or `"resume"`), `acknowledgement` (`"received"`, the default, or `"handled"`), and `onInputAcknowledged`. The returned handle provides `stdout`, `exit`, `generation`, `acknowledgeOutput(bytes)`, and `kill()`. SDK bridges select `acknowledgement: "handled"` and acknowledge bytes after applying messages to the session. `onInputAcknowledged` receives stdin bytes once the owner acknowledges their input frame and returns any additional handled stdout bytes. `exit` returns `ChildProcessLost` with the exit code and the last 8192 bytes of remote stderr (8192 characters locally), including exits before any stdout. Transport failures use `SessionOperationError`. `generation` identifies a retained owner's last input sequence, allowing protocol clients to avoid reusing request IDs. `stopChildProcess(target)` stops a retained child and removes its journals without starting a harness.

A remote child requires Node.js on the Linux worker and a session ID. A fresh launch replaces any owner for that child; only a saved-session resume can adopt a retained process. A detached owner keeps one stable PID file per child and private journals in `<pid-file>.transport`, beside the checkout. SSH exit 255 reconnects to that owner with delays of 1, 2, 4, 8, 16, then 30 seconds. The owner accepts complete newline-framed input with sequence numbers, acknowledges it, and deduplicates replay. Reconnection within one transport reads buffered output from the last received frame. Claude restart replays from the last handled message, including partial progress within a stdout frame. Hook callbacks remain replayable until the owner acknowledges the SDK response for their request ID or Claude cancels the request. Each cancellation logs its request ID at Info, with a separate message when it releases no pending request. The owner's acknowledgement of the SDK's late response to a released request logs that request ID at Info; the late response releases nothing. The first turn result handled after a control request that is still unanswered logs its request ID and subtype once. Unanswered hooks replay after restart, with the restored pause state applied before they run. Heartbeats start after the ready frame restores the checkpoint. Orderly detachment confirms that the worker saved the final checkpoint. A saved-session resume uses the last acknowledged output cursor and retains the running process when its exported child environment matches; an active Codex turn continues without another `turn/start`. A changed exported variable stops the previous process before starting a replacement. Variables supplied by the SSH login, such as `XDG_SESSION_ID`, do not affect retention. Saved-session resume stops legacy process groups before creating the shared owner. Preflight uses short-lived commands.

The owner records the Linux boot ID and process start time for its supervisor and lifeline. Reattachment reports process loss if the owner disappeared without recording an exit, including after a worker reboot. Stop and attempt cleanup check the recorded identity before signaling a PID.

Orchestrator heartbeats renew a two-minute lease. A surviving worker relay cannot renew it by itself. Lease expiry sends TERM to the harness process group, followed by KILL after five seconds. A local child instead has a dedicated pipe from the orchestrator; closing it stops the process group, including after an orchestrator crash or SIGKILL. The worker owner uses the same pipe boundary, so its own crash also stops the harness and preserves the exit diagnostics.

The durable attempt runtime supplies `ChildSessionLifecycle`. Detaching an attempt channel marks it as stopping before transports and credentials close. The shared owner suppresses EOF, reconnect, stop, and journal removal during that shutdown, so restart can reattach the same remote process within its lease. Shutdown errors stay out of child failure reports. Direct callers can supply the same lifecycle service; ordinary scope closure stops the child when the lifecycle is active.

An exited remote Claude Code or Codex process reopens its saved conversation through a replacement owner after confirming the old group stopped. The shared `/continuation` policy also applies to durable restart and Pi. Working children receive one instruction to inspect interrupted work before continuing, followed by unread operator messages. Held, paused, and idle children wait for guidance. Interrupted tool calls close with error results. A child can start at most three continuation turns within ten minutes; the fourth fails with `ContinuationLimitError`. The durable journal saves this history before sending input, so restart preserves the limit. Failed reopening returns an interrupted result and uses the existing child-session budget slot. If Codex native history confirms that the saved thread is empty, the shared policy sends the original task as its first input. A thread with saved work receives the continuation instruction.

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

`reportedOutcome` recognizes blocker and question markers at the start of any line in the final answer. It also recognizes a report header appended directly to narration, with no space or opening quote before the marker and a line break after it. An opening quote is a run of one repeated quote character (`"`, `'`, or a backtick) at the start of a line or after whitespace, `(`, or `=`; any other quote character closes a quoted string or inline code, so ``run `gh pr view`[usine:blocked]`` and ``run `git commit -m ""`[usine:blocked]`` still report. A closing quote that itself follows whitespace, `(`, or `=`, as in ``set `FOO=`[usine:blocked]``, reads as an opening quote, so that marker remains ordinary text. It uses the first such marker and the text after it as the report; text before it is omitted. A marker after a space within a line, inside a fenced code block at any indentation, or directly after an opening quote character remains ordinary text, so a quoted string that spans several lines does not report. Failure and capacity markers still require the start of the answer. It reads blocker and question markers as `AgentBlockedError` and `AgentQuestionError`, and `reportText` writes them. A parent's blocker becomes a non-retryable `BlockedFailure` and its question a non-retryable `QuestionFailure`: the run fails, its loop suppresses the item, and the run waits for the operator. A child's harness failure (`AgentResultError`) goes to the parent as a `[usine:failed]` report that `reportedOutcome` reads back, so the attempt ends with `AgentFailure` and suppresses nothing: the harness posted nothing.

Claude Code, Codex, and Pi children log blocker and question reports at Info with `kind` (`blocked` or `question`), `message`, and `sessionId`. Harness and infrastructure failures log at Error. The log level does not change the typed outcome returned to the parent.

A child's report returns to the parent's `subagent` call as text opening with its marker, to return verbatim. The parent keeps the first: a later ordinary answer fails with it, and the paraphrase stays in the transcript. Successful siblings don't clear it. Held children can take guidance and replace their answer before release. A marker without details still fails.

Model ids stay opaque until the harness checks its registry. Task failures use `AgentResultError`. `toAttemptFailure` maps `SessionOperationError` (SDK, process, and protocol failures) to a retryable infrastructure failure; `ChildSessionBudgetExceededError` becomes a non-retryable `ChildSessionBudgetFailure`.

## GitHub identity and reviews

Agents share the installation's GitHub App identity. The instructions require comment reviews at the reviewed head and the loop's outcome labels. A success label doesn't satisfy GitHub's required review: an independent reviewer approves and the operator merges. See [Write review and fix loops](https://docs.usine.dev/guides/review-fix-loops/).

## Resume a harness session

Claude children save sessions, and Codex threads aren't ephemeral. `SessionStarted.harnessSession` and launch logs (`harnessSessionId`, `sessionId`, `cwd`) give the id and directory. While the worktree and session files exist, run `claude --resume <id>` or `codex resume <id>` there, on the same worker and account. A Codex child whose environment sets `CODEX_HOME` saves its sessions there, and `HarnessSession.home` and the launch log's `home` record that directory: run `CODEX_HOME=<home> codex resume <id>`. An attempt behind a gateway gets its own `CODEX_HOME`, and its model credential isn't in your shell.

Pi children save conversations in `<checkout>/.usine/pi/sessions`. Their `SessionStarted.harnessSession` records the Pi ID, checkout as `cwd`, and session directory as `home`. Keep the checkout and this directory to continue the conversation after the process exits. Every registered runtime requires `resume(request, savedReference)`: it returns `Some({ running, active })` when the native conversation is available and `None` when it cannot reopen it. Reopening sends no prompt. Call `running.steer` to supply explicit guidance, or use `launch` with `request.resume` to apply the shared continuation policy. Keep the scope open until `running.result` returns. Preflight uses in-memory sessions.

Claude receives a usine-generated UUID as `sessionId` before its first prompt. `ChildSessionJournal.started` checkpoints the native reference before SDK startup, so recovery does not depend on an `init` message. Operator messages carry UUIDs through storage and transport. Claude receives each ID as `SDKUserMessage.uuid` and acknowledges `user_message_uuids`. A successful result's pending-send count also acknowledges submitted guidance folded without a UUID receipt. Codex correlates distinct native user-message item IDs with submitted input, restores those IDs on active-turn reattachment, and resubmits unconsumed guidance before the next operator message. Repeated native receipts are ignored, and identical text can have separate receipts. `sessionConversation.read(ids)` acknowledges only those IDs. Restored messages already submitted to a retained process wait for native delivery evidence without being sent again.

The durable parent's `subagent` tool resumes saved child conversations after an orchestrator restart in the retained checkout. An incompatible continuation returns an interrupted call with its committed output. Explicit Pi runtime callers can also use `resume`.

## Preflight

`preflight(brain, target)` (`/preflight`, Node) checks a worker without a prompt through the injected `Harnesses` service. Each runtime uses the process spawner and login lock captured when the registry was built. Each check sees the target environment as a child does. On a `RemoteShell` host, checks run over SSH, an SSH failure (exit 255) is an incomplete check rather than a missing harness, and a Pi brain is unavailable.

It accepts Codex CLI **0.164.0 (or 0.159.0 through 0.159.3)** (`supportedCodexVersions`; `unsupportedCodexVersion` returns the error for other `codex --version` output) with a verified ChatGPT account, a Claude subscription in `claude auth status --json`, and Pi's model and API key or `openai-codex` ChatGPT login through the SDK. `HarnessUnavailableError` reports a missing binary, version, or login; `SessionOperationError` an incomplete check, such as a timeout or failed SDK connection. Install and log in as the worker user before starting usine.

## Transport replay tests

`pnpm --filter @usine/agents test` replays recorded Claude SDK messages, Codex app-server JSON-RPC traffic, and Pi provider streams through the real adapters, conversation controls, and session channels. CI runs this suite on every pull request. The fixtures cover simple turns, steering, messages queued during a tool call, interrupt and guidance, holds and release, transport loss and recovery, a process that exits before its first message, and, for Claude Code and Pi, usine tool sets. Pi runs in process, so it records at the model runtime's stream, runs its tools for real in both modes, and has no transport-loss or early-exit fixture; its restart fixture stops the session during a command and reopens the saved conversation.

`test/contract/host-tools.ts` defines the one toolkit that the `host-tool` and `closed-tools` scenarios serve on every harness that declares `usine-tools`, through the registry, so admission checks the descriptor. In `host-tool`, the first call fails in its handler, the model reads the error and calls again, and events carry the toolkit's name. In `closed-tools`, the role closes native tools, and the recorded tool list, Claude Code's `init` message or Pi's provider request, holds only the toolkit's tool. A Claude replay sends each recorded call to the session's tool server and checks the result; Pi runs the handler for real in both modes. A Claude recording keeps only the SDK's traffic: the replay answers at the SDK boundary, so it never starts the Claude Code process beneath it.

`test/contract/capabilities.ts` maps each capability to the scenarios that prove it, or, for a capability that no session scenario shows, such as `model-check`, to the suites that check it for each harness. The contract suite fails when a descriptor declares a capability whose scenarios have no replayed fixture for that harness, or that no suite checks for that harness. It also checks that admission refuses every lacking capability with the descriptor's reason. Simple replays also check reported tokens and, where declared, USD.

The usage-limit scenario runs on all three harnesses: a session whose provider refuses the first request at a usage limit fails with `AgentCapacityError`, and its run retries at the reported reset, or after the default capacity delay when a transform removes the reset time. A working harness can't reach a usage limit on demand, so each fixture is a recorded `simple` session with the refusal frames that the pinned harness emits substituted. The Pi fixture is the `simple` request on the `openai-codex` model, answered with the `error` stream event that Pi's ChatGPT provider emits for an HTTP 429 `usage_limit_reached` response.

`pnpm --filter @usine/durable test` also replays restart and credential-kind-change fixtures through `AttemptRuntime.execute`, the durable `subagent` tool, and SQLite. Each case closes the first runtime during a tool call, opens another runtime on the same database, and checks the child's events and the final report.

The shared fixture format in `test/fixtures/replay/` contains protocol, harness version, model, scenario, and redacted environment metadata. Its entries are `expect_outbound`, `emit_inbound`, and `runtime_exit`. Replay matches outbound requests in order within each connection and requires every entry to be consumed. Independent connections can interleave. Tool hooks and operator release actions preserve ordering at tool boundaries. A request mismatch stops the replay immediately and reports the transcript entry and changed payload, including during initialization and resume. After five seconds without transport progress, replay reports the next missing request in each connection. Failed tapes settle fake process exits and end their stdout streams so adapter shutdown completes promptly. Temporary paths and credential values use placeholders; supervisor frames contain decoded base64 bytes so redaction also applies to their payloads. Frames that split a UTF-8 character use a byte string that preserves each byte.

Record fresh fixtures with Claude Code 2.1.311 and Codex 0.164.0 installed, working harness credentials or gateway configuration, and explicit models:

```sh
USINE_CLAUDE_INTEGRATION_MODEL=claude-sonnet-5-5 pnpm --filter @usine/agents test:integration:claude
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_CLAUDE_INTEGRATION_MODEL=claude-sonnet-5-5 USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/durable exec vitest run test/integration/replay.test.ts
USINE_PI_INTEGRATION_MODEL=openai/gpt-5.6-luna pnpm --filter @usine/agents test:integration:pi
```

The Pi recorder uses the worker user's Pi credentials and model configuration, and keeps the user's Pi settings out of the session. Set `PI_CODING_AGENT_DIR` to record with a `models.json` and `auth.json` other than the user's, such as one that points a provider at a gateway.

The interrupt-and-guidance fixture waits at the tool boundary before sending guidance. Claude records and replays the SDK tool hooks and checks that the post-tool hook stays blocked until guidance arrives. Codex interrupts the first turn, waits for the interrupted completion and idle event, and starts a new turn with the guidance. Both check the guided reply and include a separate command interrupted through the harness cancellation API. Restart fixtures retain the harness home and assert that the child resumes with the same saved home. Credential-change fixtures require `USINE_GATEWAY_TOKEN` and add the API-key auth variable on resume. They simulate a change in the gateway credential kind and check the billing pool on resumed usage events and Codex rate-limit events. The recorded vendor session uses subscription authentication.

Recorded vendor output is preserved when client request expectations change. The legacy Claude recordings predate native UUID receipts and verify delivery through result pending-send counts. A derived Claude replay inserts an intermediate result with queued turns and verifies that only the final result makes the session idle. Focused SDK tests verify UUID acknowledgements and folded guidance while additional sends remain queued. Replay also checks a single session start across hold and release, converts recorded Codex rate-limit windows, and verifies that interrupting an owned Claude process stops it. The Claude transport-loss replay advances the reconnect delay with `TestClock`. Request expectations include assigned session IDs, operator UUIDs, unread replay, and the shared continuation message.

The recorder runs in disposable directories and writes fixtures only after the scenario passes. Review fixture diffs before committing them. Transport-loss recordings use an SSH shim that runs real processes locally and a PID file to terminate the active relay while the shared owner and harness keep running; replay uses recorded traffic and needs neither harness credentials nor model access. Early-exit recordings terminate the real harness before it sends a protocol message. Recorder tests stay outside `pnpm test` and CI, and skip when their model variables are unset.

Hand-scripted fixtures remain for cases that require traffic a working binary cannot produce on demand, such as malformed responses, unavailable models, refresh-lock failures, provider retries, and shutdown races. Claude transport-loss replay runs recorded CLI messages through the real SDK and shared process owner with an SSH shim. Early-exit replay starts failing commands through the owner for both harnesses. Restart coverage asserts one retained Claude process and stable owner PID. Shared owner tests check input deduplication, lease expiry through the SSH shim, bounded early-exit diagnostics, and local cleanup after orchestrator SIGKILL. Focused usage tests verify seeded token and cost totals.

Pi's in-process SDK retains its opt-in live contract:

```sh
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

Codex response and notification schemas are generated from the upstream app-server JSON schema. `src/protocol/codex/version.ts` records the release version and immutable upstream commit together; the harness descriptor uses that version as its preflight baseline. `src/protocol/codex/codex.ts` selects the fields the adapter consumes and applies domain constraints. A selection that narrows a generated field names that field, so an upstream rename or incompatible type change fails `pnpm check`. The replacement guard also checks key optionality, so making a selected key optional upstream requires updating its replacement. Selected keys are optional where upstream marks them optional. New status and phase strings decode without a protocol error; recognized tool kinds remain a closed set because the adapter maps each kind to a transcript tool. The tool item `id` replacement names the `id` field of each of the seven tool kinds. When an item of a recognized tool kind does not decode, the adapter logs `Skipping an undecodable Codex tool item` and skips the item. The warning includes the decoding cause and the item type, both for item notifications and for the in-progress turn of a resumed thread. The transcript's tool input and output carry the full item as Codex sent it. Message items follow the same rule: an `agentMessage` that does not decode, whether notified on `item/completed` or saved in the resumed turn, logs `Skipping an undecodable Codex agent message`, and a `userMessage` notified on `item/started` that does not decode logs `Skipping an undecodable Codex user message`, each with its cause and item type. A notified item of a kind other than a tool or a message, such as `collabAgentToolCall` or `reasoning`, has no transcript event; the adapter logs `Skipping a Codex item without a transcript event` with the item type at Info.

Generated `Values` tuples preserve known enum members, including the string members of a union's inline and referenced enum alternatives, such as `CodexErrorInfoValues`. The tuple of a union does not list enum members nested inside its object alternatives. The adapter uses typed comparisons for turn statuses, tool statuses, message phases, authentication modes, and turn error codes. A tool status comparison accepts only a value that every compared tool kind lists: command, file-change, MCP, and dynamic tool items. Image generation items report a free-form status that upstream doesn't list. `codex-protocol.test.ts` pins each comparison's lists by identity, because the command and file-change lists have the same members. Removing or renaming a compared value upstream causes `pnpm check` to fail after regeneration, while decoders continue to accept unknown strings.

`src/protocol/codex/upstream-schema.json` is a byte-for-byte copy of the upstream schema at the pinned commit, and the generator reads it without network access. `pnpm --filter @usine/agents codex:generate` writes `src/protocol/codex/generated.ts` from the copy. `pnpm --filter @usine/agents codex:check` compares the generated output with that file without writing it, and rejects manual edits or stale generation.

`pnpm --filter @usine/agents codex:check:upstream` runs the same check, then fetches the schema from `raw.githubusercontent.com` at the pinned commit and fails if the copy differs, naming both. If the fetch fails, it prints `upstream fetch failed: <reason>; the local copy was checked` and exits with code 2. CI runs this command and fails on any non-zero exit, including code 2. Without network access, exit code 2 still means the local check passed.

After updating the pin in `src/protocol/codex/version.ts`, run `pnpm --filter @usine/agents codex:update`, which fetches the schema, replaces the copy, and regenerates the output. Review `src/protocol/codex/generated.ts` and run the conformance and replay tests. The generator formats its output with the repository's `.oxfmtrc.json`. Inline single-value enums tag union variants, so they generate literals on any key, such as `type` or `kind`; other string enums generate open strings. The generator fails on these schema shapes: two schemas with the same export name, enums with a non-string type, `const` schemas, recursive definitions or wrappers, reference wrappers with sibling constraints, union siblings other than annotations and common object fields, simultaneous `oneOf` and `anyOf`, and a `null` alternative beside common fields. It also fails on a union of two or more non-null alternatives whose variants a decoder can't tell apart: a variant whose field on another variant's tag key isn't a required single-value enum, or a variant whose required fields all appear in a later variant with no differing tag. A variant that accepts every object, such as `true`, an untyped schema, `{ "type": "object" }`, or `{ "type": ["string", "object"] }` without fields, generates a record or `Schema.Json`. It follows only variants that a tag tells apart from it, with one exception: it may come last after variants that each declare one required key and `additionalProperties: false`, as `CodexErrorInfo` does. A value with one of those keys decodes as that variant, so any extra keys are dropped, and any other object decodes as the last variant. Such a variant can't come before another variant that accepts objects. An alternative that refers to another union is checked as that union's variants, in decoding order, and a union that contains itself is rejected. A single schema with a `null` alternative keeps ordinary `type` fields without a literal tag. `scripts/codex/emit.test.mjs` covers these cases, and `scripts/codex/generate.test.mjs` covers the commands with a replaced `fetch`.

The protocol conformance baseline is 0.164.0, and the `@pwrdrvr/codex-app-server-protocol` version that `protocol-conformance/check.ts` compiles against must match it. Preflight also accepts 0.159.0 through 0.159.3 so existing worker images can upgrade, and refuses 0.153.4. Install 0.164.0 for its updated TLS certificate roots. Other CLI builds need verification first.

When Codex 0.164.0 is on `PATH`, the unit suite also checks launch overrides with `--strict-config` and verifies project configuration isolation locally and over the SSH shim. These tests use temporary homes and start threads without sending model requests.

Provider capacity refusals use `AgentCapacityError`, which maps to `ProviderCapacityFailure`. Codex's `serverOverloaded` code and Claude's `overloaded` code take precedence over error text. HTTP 529 and HTTP 503 with a retry hint also qualify. A usage limit is also a capacity refusal, and its `resetsAt` is the reset time the harness reports, or `None` if it reports none:

- Claude's `rate_limit` code and HTTP 429 mark a usage limit. Its `resetsAt` is the reset time from Claude's last `rejected` rate-limit report.
- Codex's `usageLimitExceeded` and `rateLimitExceeded` codes mark a usage limit, except a billing quota (“Quota exceeded”), a plan without Codex, or a workspace that is out of credits (“Your workspace is out of credits”) or at its spend cap (“You hit your spend cap”), which don't reset until someone changes the account. A turn that fails with HTTP 429 after Codex's own retries (`responseTooManyFailedAttempts`) marks an API-key rate limit; Codex reports an exhausted API-key quota as `usageLimitExceeded` instead. Its `resetsAt` is the latest reset time among the used-up windows of the last `account/rateLimits/updated` snapshot.
- Pi's ChatGPT plan limit (“You have hit your ChatGPT usage limit” over HTTP, “The usage limit has been reached” over WebSocket), a shared subscription limit (`subscription_sharing_usage_limit_exceeded`), and HTTP 429 with rate-limit text mark a usage limit; HTTP 429 for billing exhaustion doesn't. A plan limit that states its wait (“Try again in ~N min”) resets one minute after that wait, counted from the timestamp of the failed assistant message, which is when the failed model request started. When no assistant message failed with that error, as when a blocking compaction fails, the wait counts from when the failure is classified. The extra minute covers Pi rounding the wait to the nearest minute. The Pi parent and Pi children classify a failed turn the same way.

Claude Code ends a turn on an API error with a `success` result that has `is_error`: that result fails the session after a capacity refusal or usage limit, or when it has HTTP 429 or 529 or capacity error text that `harnessFailure` recognizes; after any other API error, its text stays the session's answer. When a harness exposes only text, `harnessFailure` recognizes “Selected model is at capacity”, `overloaded_error`, HTTP 529, and 503 with a retry hint. Other task failures remain `AgentResultError`.

`reportText` relays capacity refusals with `[usine:provider-capacity]`; `reportedOutcome` restores their classification. Pi children classify the final assistant error when a turn settles, including when SDK retries are disabled or the SDK does not retry that error. A successful SDK retry completes normally.

## CI handoff

For a loop with a CI policy, the task instructs the agent to push, record completion labels in a `[usine:awaiting-ci]` JSON answer, and end its session. The parent relays that answer unchanged. usine checks the harvested PR head and waits for CI before applying those labels. The agent must leave completion labels for the monitor. Other loops retain ordinary final answers.

## Schema contracts

Session records and errors use nominal Schema brands. Construct records with their schema’s `make` method. Codex request serialization is pure over validated parameters. Child backends decode responses inside Effects and report invalid responses through session operation errors.

The harness implementations are grouped under `src/harness/claude/`, `src/harness/codex/`, and `src/harness/pi/`. Shared dispatch, conversation, session-channel, and usage helpers are in `src/harness/`. Consumers use the published subpaths shown above.

Run `pnpm --filter @usine/agents check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## Step outputs

Parent and child completion instructions describe `.usine/outputs/<name>.json`: a non-empty opaque `type` of at most 128 UTF-16 code units, optional pinned-base `commit`, and JSON `content`. Both prompts include the pinned base commit, even when the checkout resumes from salvage. Agents leave child outputs in place and keep `.usine/` out of commits. The limit is ten outputs per attempt and 8 MiB per file and per compact JSON content body.
