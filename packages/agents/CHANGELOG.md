# @usine/agents

## 0.7.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 389f35e: Generate worker image packages and tags from harness descriptors. Export `workerImageInputs` from `@usine/agents/harness`, derive the default SSH attempt image from it, and keep both Dockerfiles, Hetzner cloud-init, image publishing, and snapshot creation consistent with the catalog.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 12c3921: Check harness capabilities by role, credential route, and placement with one admission policy. Configuration and preflight refusals identify the missing requirement and adapter reason. Validate parent models, efforts, and credentials before accepting configuration imports, reloads, or saved edits. At startup, quarantine agents with refused parent brains and their loops in Needs attention while keeping the server available. Restore them after a corrected reload.
- 548e6b7: Register harness preflight and launch through `Harnesses` on `@usine/agents/harness/node`. Registration rejects incomplete descriptor/runtime pairs and duplicate IDs. Gateway, injected-key, and Cloudflare preflight use the registered runtime with their credential route. Refusal messages name the harness and its installation location, mention a login only for host-login probes, and retain sandbox-image guidance for Cloudflare. Successful binary probes log the installed version.
  
  Replace the three harness-specific backend tags with `ChildBackend`, and rename the single-harness layers to `claudeChildLayer`, `codexChildLayer`, and `piChildLayer`. Replace `ClaudeLoginLock` and `claudeLoginLockLayer` with `HostLoginLock` and `hostLoginLockLayer`; `withLock` takes the harness ID before the worker and machine. Share one lock layer between the executor and attempt runtime.
  
  `preflight` accepts a `ProbeTarget` and requires the injected `Harnesses` service. Build the registry once with the process spawner and shared `HostLoginLock`, then provide it to the executors and durable attempt runtime. Registration errors remain typed until the server reports a startup failure. It returns capability gaps as readiness reports and fails on transport errors or timeouts. Custom `HarnessProbe` wrappers forward the worker and machine context in their second argument.
- 1c981c9: Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.
  
  Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.
- fc15261: Save Pi child conversations under each attempt checkout and expose a runtime operation to continue them by saved session ID after the process exits. Record saved session metadata in the transcript and declare the resume-session capability in harness descriptors. Preflight probes remain in memory.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 10154eb: Continue saved child conversations through `ChildRequest.resume`. Launch admission checks the resume capability for the worker and credential route, and each harness restores its saved session location.
  
  Codex stops the original and reconnect app-servers before replacing retained transports for a saved-thread resume.
  
  Restore paused child sessions as idle and wait for operator guidance before starting another model turn.
  
  Initialize resumed Claude Code and Pi usage meters from `ChildRequest.usage` so token and cost totals include earlier processes.
- 9cf0b5e: Share child continuation policy across Claude Code, Codex, Pi, and durable restart. Native resume reopens a conversation without sending input. Working children receive one continuation and unread guidance; supervised children wait. Persist a limit of three continuation turns per ten minutes and close interrupted tool calls with errors.
  
  Assign Claude session UUIDs before the first prompt and give operator messages stable UUIDs. Acknowledge guidance by native message IDs so identical messages have separate delivery receipts, and use Claude's pending-send count only for results without UUID receipts. Send the task to a retained Claude process that never acknowledged its prompt. A restored child keeps its unread messages until its call ends. Preserve unread Codex guidance across turn boundaries and active-turn reattachment. Failed resume returns interrupted without spending another child-session slot, and a replacement clears the previous child's infrastructure failure.
- 9e30c8c: Add the Node `child-host/owner` API and use one process owner for Claude Code and Codex. Remote children reattach across SSH loss and orderly restart, with a two-minute orchestrator lease and bounded exit diagnostics. Local children terminate their process groups when the orchestrator pipe closes, including after a crash.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.

### Patch Changes

- df0bd8f: Log child blocker and question reports at Info with their report kind across Claude Code, Codex, and Pi. Keep harness and infrastructure failures at Error.
- 09417f7: Preserve Claude Code sessions across orchestrator restarts on container-isolated SSH workers. Store projects in an attempt-scoped worker directory until checkout cleanup, and remove orphan session directories during sweeping and provisioned machine resets. Harness descriptors declare container session storage independently of credential wiring.
- b7ff637: Report Claude Code subscription allowance windows for the Claude plan pool. Five-hour and seven-day utilization reports update pool health and Needs attention warnings, preserving the latest observation of the other window across children and attempts. API-key sessions do not update Claude plan windows.
- 10822d3: Fix Codex checkout trust overrides so children disable project-local configuration, hooks, and exec policies even when the saved configuration marks the checkout as trusted. Start the app server outside the home directory to avoid repeated configuration warnings.
- 1674238: Generate Codex app-server response and notification schemas from a pinned upstream commit. Accept new status and phase strings when decoding saved threads and notifications, while preserving domain validation and the supported CLI version policy.
- 92f21ce: Keep remote Codex app-servers running through SSH drops and reattach to their pending turns. Resume the saved thread once if the app-server exits, preserving operator pauses and idle sessions. Record child transport failures as infrastructure failures even after earlier child reports or parent blockers, so attempts retry automatically from recorded salvage.
  
  Preserve the original task when an app-server exits before saving its first user message. Recovery continues saved work when the task is already recorded.
  
  Replay unread operator guidance when recovering a Codex thread. Report delivery after the recovered turn accepts the messages, and preserve unread guidance while the child waits for the operator to resume it.
  
  Replay incomplete output frames after an SSH disconnect, preserving the last complete output offset.
  
  Discard incomplete input frames before journaling them so reconnecting preserves the running app-server. Acknowledge guidance included in resumed input when Codex reads it, preventing replay after another pause.
  
  Preserve the recorded process-loss error when the app-server exits before the first turn request starts, so recovery resumes the saved thread.
- 8c079aa: Route coordinator model requests through the instance's first configured gateway with a caller token. The orchestrator host needs no provider login when a gateway is configured. Check coordinator gateway credentials at startup and keep usage in the API-key or ChatGPT plan pool. Expose the gateway model route for orchestrator-hosted runtimes.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- 35f68ef: Stop child connection recovery when an attempt detaches during orchestrator shutdown. Codex preserves its remote supervisor and journals for reattachment, and Codex, Claude Code, and Pi suppress shutdown infrastructure failures.
- 3229601: Run Pi children on a ChatGPT subscription with an `openai-codex` model. Preflight accepts the Pi login without an API key, and child usage counts in the ChatGPT plan pool. OAuth providers without a supported billing pool remain unavailable.
- bb96f16: Save a Claude child's zero usage for its replacement process before the replacement launches, so an orchestrator stop during that launch keeps the earlier process's tokens and cost in the session total. Wait for the worker to acknowledge pending input before the detach checkpoint, so an answered hook is not replayed after the restart. Save active and uncheckpointed assistant message IDs with the process usage, so a reattached process doesn't count their replay again.
- 6316707: Connect Claude and ChatGPT from setup, Settings, or `usine login`, with subscription and API-key options. Save completed logins on the configured gateway or in local harness storage, show credential metadata, and replace or disconnect credentials without manually transferring files.
- 89ae7ee: Group the Claude Code, Codex, and Pi child harness implementations under `harness/` while preserving the published subpaths.
- 9476883: Pass the rendered loop task unchanged to each child, with parent-written text as supplemental context. Record the exact child prompt in the transcript and display it in the run page's attempt details.
- b6a858e: Send remote child environments over stdin so gateway caller tokens stay out of SSH and container command arguments during launch, reconnection, and cleanup.
- 10154eb: Keep held children that finished their turn idle after an orchestrator restart. Release returns the saved report to the parent; operator guidance starts another turn. Include the completed report in SessionIdle events for recovery.
- 1948b10: Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
- ef5aa4d: Save the remote child's output checkpoint when the worker doesn't acknowledge pending input within 4 seconds of a detach, instead of skipping it. The worker relay now ignores an input line cut off by a dropped connection and exits normally. If the worker cannot identify the process that holds the child, it stops that process and exits instead of leaving the child unsupervised.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- fc18d3f: Build the child process owner and lifeline from TypeScript into self-contained Node programs. Add direct worker lifecycle tests for input replay, lease expiry, stale process identities, environment changes, and TERM-to-KILL shutdown.
  
  Track relay input history, retry state, and output checkpoints in Effect refs, with separate connect, replay, stream, and reattach phases.
- Updated dependencies [6a1cf79]
- Updated dependencies [6e60662]
- Updated dependencies [01467e3]
- Updated dependencies [a1c0d36]
- Updated dependencies [e007d09]
- Updated dependencies [9290433]
- Updated dependencies [1c981c9]
- Updated dependencies [82b55aa]
- Updated dependencies [7e5bb5b]
- Updated dependencies [d740598]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [9476883]
- Updated dependencies [10154eb]
- Updated dependencies [7c58461]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0

## 0.6.0

### Minor Changes

- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.

### Patch Changes

- a7692ae: Upgrade the Codex protocol baseline and worker images to 0.164.0, which includes updated TLS certificate roots. Preflight rejects 0.153.4 and accepts 0.159.0 through 0.159.3 for one release while existing worker images upgrade. The gateway model-provider configuration remains compatible. Claude Code stays at 2.1.308.
- 93bbe77: Upgrade the Pi packages to 1.4.0 and define the checkpoint policies required by pi-durable. Attempt and hold documents retain their existing delta-storage behavior. Disable the task restart limit to preserve automatic resumption after repeated crashes.
  
  Back up the instance with `usine backup <path>` before upgrading. Starting the upgraded server migrates `durable.sqlite` to SQLite storage schema version 2, which pi-durable 1.3.0 and earlier cannot open. Do not downgrade usine past this release: `usine upgrade <older version>` cannot reverse the storage migration.
- 06a10bf: Disable Codex plugin and app sync, startup update checks, and analytics in child and preflight commands. Disable Claude Code's claude.ai connectors and nonessential traffic in the attempt environment on every worker kind.
- f54b3bd: Record the provider login in `PoolRateLimitsUpdated.login`. Codex records the ChatGPT login email and refreshes it after an account change. Older snapshots and gateway-backed sessions remain readable without a login.
- 98eb9cd: Document the public agent API, including harness SDK contracts, session errors, child hosts, and prompt inputs.
- Updated dependencies [d1fd769]
- Updated dependencies [6541e90]
- Updated dependencies [6d7f66f]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0

## 0.5.0

### Minor Changes

- 113d150: Preflight accepts Codex CLI 0.153.4 and 0.159.0 through 0.159.3, and refuses 0.144.0. The protocol conformance baseline is `@pwrdrvr/codex-app-server-protocol` 0.159.2. `@usine/agents/preflight` exports `supportedCodexVersions`.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)).

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 2f78d3a: A remote Claude child whose SSH connection breaks, for example while the orchestrator's machine sleeps, resumes its saved session instead of failing ([#603](https://github.com/basaltbytes/usine/issues/603)). The backend stops the Claude process left on the worker with the new `CHILD_STOP_SCRIPT`, then starts Claude with `resume` in the same child session, so the parent spends no child budget. It tries after 5 s, 15 s, 30 s, 1 min, 2 min, and 5 min, and fails the child as before after the last try. A child whose Claude process exits on its own, or that runs on the orchestrator's machine, still fails.
  
  `claudeChildLayer` and `claudeChildBackendLayer` require a `ChildProcessSpawner`. `/child-host` exports `SSH_FAILURE`, the exit code of the OpenSSH client when the connection fails.
- 1514af9: On a provisioned worker, the Claude login lock covers one machine instead of the whole worker ([#591](https://github.com/basaltbytes/usine/issues/591)). Each machine has its own login, so a Claude child or preflight check on one machine no longer waits for a Claude start on another. A worker's long-lived machine keeps one lock for all its attempts.
  
  `ClaudeLoginLock.withLock(worker, machine)` takes the provider's `MachineId` of a provisioned machine, or `None` for the worker's shared login. `ChildRequest` and `AttemptRequest` require `machine`, which the executor sets from the attempt's machine. `AttemptRequest.machine` isn't stored; each `execute` call supplies it.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
- 80f2eb6: `HarnessSession` has an optional `home`: the directory the harness saved the session in when the attempt set one in place of the harness's default. A Codex child records its `CODEX_HOME` there and in the `Codex child session saved` log, so a resume command can find a session that an attempt behind a gateway saved in its own Codex home. Older records decode `home` to `Option.none()`.
- 3d54b01: Codex sessions now have a price. `SessionTokensUpdated` has an optional `breakdown` of input, cached input, cache write, and output tokens, which Codex children report. `@usine/agents/openai-prices` exports `openAiPrice`, which prices a breakdown at OpenAI's API rates for the models that the supported Codex CLI versions list.
  
  Run and task usage prices a Codex session that its harness didn't price from that table, marked as an estimate in the ChatGPT plan and not in the API keys pool. ChatGPT plan sessions that Pi prices keep Pi's figure, now shown as an estimate. A Codex model without rates stays unpriced and is logged once. The run page shows ChatGPT plan prices instead of `No dollar rate`.
- d82c6cd: A Pi child gets only Pi's default tools: `read`, `bash`, `edit`, and `write`. Before, the global Pi `defaultTools` setting could add tools such as `grep` and `find`, which run `rg` and `fd` with the orchestrator's environment and its secrets. `bash` still runs with exactly `ChildRequest.environment`.
  
  The `Started` result of `PiSdk.start` adds `tools`, the names of the session's active tools, which the Pi child backend logs at debug level.
- 266986a: The nine `@earendil-works/*` packages are at 1.2.0. pi-durable 1.2 closes the harness on any storage error, a read included, so `DurableHarness` now handles a failed harness instead of a poisoned session or a stuck step:
  
  - An attempt that is running when a storage error fails the harness fails with a retryable `InfraFailure` whose cause is the new `DurableStorageFailed`, and the engine retries it from salvage. The harness reopens the storage, aborts those attempts' tasks, and resumes the other tasks.
  - A storage error before the harness resumes its tasks fails the layer with a `DurableHarnessError` that names the error, and `usine up` doesn't start.
  - If the reopen fails, or the reopened harness fails within a minute, the harness stops until the orchestrator restarts.
  
  `HarnessListener` replaces `onReopen` and `onStop` with `onFailure`, `BeforeResume` also receives the storage, and `StuckStepReports` is removed. The `subagent` tool returns the child's report as `output`, the field that pi-durable 1.2 reads instead of `content`.
- 4c63872: The Pi preflight session's `bash` tool now gets the worker's environment instead of inheriting the orchestrator's. Preflight never prompts, so no tool ran, but the session was built as if it might.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/core@0.5.0

## 0.4.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- 8292038: `ChildRequest` contains the child's complete environment, and Claude Code, the Codex app server, and the Pi child's bash tool run with only that environment. `@usine/agents/pi/authentication` exports `splitPiModel`, `piAuthentication`, `requiredPiPool`, and `resolvePiPool`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- caf041d: Removes the Pi parent runtime, which runs in `@usine/durable`: `@usine/agents/pi/live`, `AgentRuntime`, `LaunchRequest`, `ChildSessions`, `piParentLayer`, the subagents extension, and the `typebox` dependency. Removes `PiStartOptions.toolMode`, makes `PiStartOptions.model` a required `ModelId`, and removes `requiredPool` from the `AuthenticationUnavailable` and `UnsupportedAuthentication` start results.
- a55d12d: `harvestFacts` and `harvestPostedComments` record a comment or review only if its body ends with the signature of the attempt's agent, so attempts of two agents on one item no longer record each other's comments. The harvest log counts other comments as `unsigned`.
  
  `githubSignature` moves from `@usine/agents/prompt` to `@usine/core/agent`, and `HarvestSpec` reads the RunSpec's `agent`.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 0799f4f: `ChildRequest.host` sets where a child runs: `LocalProcess`, or `RemoteShell`, which runs each child through one SSH command in the worktree. `@usine/agents/child-host` also exports `sshArguments` and `CHILD_KILL_SCRIPT`; Claude Code and Codex children support a remote host, and Pi children refuse it with `AgentResultError`.
  
  `preflight(brain, host, environment)` and `verifyHarness(brain, host, environment)` take the host and environment to check. On a `RemoteShell` host, probes run over SSH, an SSH failure is an incomplete check, and a Pi brain is unavailable.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- acef6eb: Upgrades `@anthropic-ai/claude-agent-sdk` to 0.3.308, which bundles Claude Code 2.1.308 without the compromised eMudhra certificate authorities. Claude children still run the worker's own `claude` from PATH.
- a3a230c: Preflight reports a logged-out Claude Code worker as needing `claude auth login` instead of as a failed command. Other non-zero exits and output that isn't a login status still report the command as failed.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 5519ca3: The Pi backend checks a model's effort with `getSupportedThinkingLevels` from `@earendil-works/pi-ai`, as the Pi parent does. `@usine/agents` depends on `@earendil-works/pi-ai` 1.1.0 directly.
- 9b78093: Upgrades `@earendil-works/pi-coding-agent` to 1.1.0; the Pi parent's steer reports whether the message was handled or queued.
- 458033e: A Pi child records provider retries as `ProviderRetrying`, with Pi's message and the turn's retry count, and recovery as `ProviderRecovered`, like Codex and Claude Code children.
- e518906: Pins `@earendil-works/pi-codemode` to 1.1.0, next to `@earendil-works/pi-coding-agent` 1.1.0. Fixes a `SyntaxError` in `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` when a plain install resolved pi-codemode 1.3.0, which doesn't export `MCP_TYPESCRIPT_PREAMBLE`.
- 7078fa8: Pins the `@earendil-works` packages `chord`, `pi-agent-core`, `pi-mcp`, `pi-telemetry`, and `pi-tui` to 1.1.0, matching `pi-coding-agent`, so a plain install gets the workspace's versions.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 71c8b48: Claude children stay open until background work and notification turns finish. An agent reports an unresolved blocker with the `[usine:blocked]` marker, which fails the attempt without a retry.
- 07a4145: An attempt fails if the Pi parent paraphrases a child's `[usine:blocked]` report; the parent receives the report with its marker intact.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [6764fa7]
- Updated dependencies [466e711]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [d933ab6]
- Updated dependencies [a3a230c]
  - @usine/core@0.4.0

## 0.3.0

### Minor Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 34aeb4a: Upgrades Pi to 0.85.1 and the Claude Agent SDK to 0.3.261. Pi supports GPT-6 Astra with OpenAI API keys or Codex subscriptions, and Claude Fable 5.1 with Anthropic API keys.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 28ec315: Supports Codex CLI 0.153.4 and stops Codex child processes, including leftover background commands, before their sessions complete.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- fb24c80: Adds Codex app-server and API-key-only Pi children to the subagents extension (protocol v3).
- 684757f: The Pi parent can use a ChatGPT subscription through the `openai-codex` provider, and has no repository coding tools, so work goes to the child.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
