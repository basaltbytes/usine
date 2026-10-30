# @usine/config

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- fdecd7e: Add schema validation for configuration form drafts and API endpoints for supported harnesses, efforts, installation repositories, and live repository labels.
- 88eac4f: Add operator API endpoints to read configuration revisions, edit and delete entities, and revert changes. Reject stale writes and report validation problems by entity and field. Check runtime compatibility before saving API changes, apply accepted revisions live, and start newly created loops paused.
- 9e14070: Add a configuration aggregate, atomic revision log, SQLite and in-memory stores, and strict folder import and export. Validate schema, CEL, and references before saving, and reject stale revisions. Expose an explicit CEL engine factory for deterministic validation without layers.
  
  Preserve worker preference order when importing configuration, including imports that also change worker values, and restore that order when replaying revisions.
- 1c1e516: Expose the latest label-addition actor and time for current issue and pull request labels through `item.labelEvents`. Loop conditions can use this history to select App-set labels for approval.
- 59d6496: Add loop forms with live CEL diagnostics, payload completion, registry selectors, and prompt previews. Preview stored matches before saving or resuming a loop. Expose read-only check and preview endpoints, and preserve expression positions in validation errors.
- 79174da: Order waiting runs with integer CEL priority expressions over item labels and other stream fields. Priorities default to zero and sort highest first, followed by lane rank and event arrival. Failed evaluations log a warning and use zero. Overview and wait and lease logs show the evaluated value; loop checks and previews validate and evaluate expressions.
  
  Scheduler layers now require `ExpressionEngine`.
  
  Queue positions now include priority and lane together. Loop preview items and Overview’s queued-run responses include the evaluated priority.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.
- 4f37e20: Add release version and upgrade outcome schemas, plus `upgrade_channel` and `upgrade_mode` settings. The defaults select the `latest` channel and propose available upgrades.

### Patch Changes

- 0536c26: Exclude unchanged configuration entities from import revisions when adding or removing a worker. Preserve worker preference changes and canonical values across configuration export and import.
- 40a70c2: Record configuration revision positions only for workers, relative to the worker list. Adding or removing an entity no longer adds unrelated entities to the revision or their `usine config log` history. Preserve worker order when importing and replaying revisions.
- 24dc884: Support project drafts in the configuration form codec, with validation of repository membership and lanes on save. Keep repository tag edits separate from project lanes.
- dfc713d: Document the public configuration API, including revision stores, project scope, file parsing, and worker settings.
- Updated dependencies [d1fd769]
- Updated dependencies [9e14070]
- Updated dependencies [6541e90]
- Updated dependencies [79174da]
- Updated dependencies [6d7f66f]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [460d50b]
- Updated dependencies [1c1e516]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0
  - @usine/expression@0.5.0

## 0.4.0

### Minor Changes

- b3e696a: Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).
  
  - `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a stop that ends every process that a command started, including what it left running after it exited, a keepalive alarm that also keeps a held sandbox running, an image init that records the platform's SIGTERM, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex, only on the provider routes that the harnesses call. Each sandbox applies its credential changes one at a time and refuses credentials older than the ones it holds, so a delayed renewal can't undo a revocation. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
  - `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
  - `@usine/executor/cloudflare` creates a sandbox per attempt, checks the attempt's harness version in it before it grants credentials, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps and holds it until it reconciles or destroys it, drains an attempt within the platform's 15 minutes after SIGTERM by salvaging its checkout and failing it retryably, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions. Each child reports the outbound handler's API key as its credential, so a Codex child runs without a ChatGPT login check, and Claude Code and Codex children count in the API keys pool.
  - `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
  
  Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)).
- ac701f0: A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.
  
  The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.
  
  `@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.
  
  `StepExecutor.reserve` takes the run ID as its first argument.
  
  `WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
- 7d338a2: `usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
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
- Updated dependencies [9c7ea97]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/core@0.5.0
  - @usine/expression@0.4.0

## 0.3.0

### Minor Changes

- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.

### Patch Changes

- a3a230c: Renames the decoded agent fields `parent_model` and `parent_effort` to `parentModel` and `parentEffort`; agent files don't change.
- efdcf43: A loop's `if:` accepts unquoted YAML `true` or `false`. Other non-string YAML values fail with a message to quote them.
- 9464a41: Repository names in `usine.yaml` and loop selectors, and board lane labels, match case-insensitively, as on GitHub. `usine.yaml` rejects repos or selector entries that differ only in case, and lane `label` sources that differ only in case count as one.
- 9739f3a: Loop expressions can use CEL optional values, such as `item.?milestone.?title.orValue("none")`, which is `"none"` on an issue without a milestone. `relatedStringLiterals` accepts the same syntax, so a loop that uses `.?` no longer makes the instance load without undeclared-label warnings.
- eedf20c: Behind a gateway, Codex, and Claude Code if the gateway has no Anthropic credential, use the operator's login on the worker machine and reach their provider through the gateway's forward proxy (ADR 0027, amendment of 2026-10-15).
  
  Preflight on an SSH worker behind a gateway accepts these brains if the machine reaches each login host through the forward proxy: `api.anthropic.com` and `platform.claude.com` for Claude Code, `chatgpt.com` and `auth.openai.com` for Codex. A refused host fails preflight with a `gateway` capability error that names the host to add to the egress allowlist, and `SshExecutorOptions.harnessReadiness` replaces only the login and binary checks.
- 32cf39b: Declares nullable GitHub payload fields, such as a team review request's `requestedReviewer.login`, as nullable in the CEL environment. On a null field, a comparison with a value is false, a comparison with `null` works either way, and `has()` below it is false; `ObjectField` takes a `nullable` flag, and prompts accept a `null` result.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- e5d9483: Rewords TSDoc for `Settings.maxAttemptMinutes`, `maxAttemptTokens`, and `parentModel`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 8665053: Depend on `yaml` 2.9.1 to parse `usine.yaml`, loop files, and agent files.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [9739f3a]
- Updated dependencies [af28e0e]
- Updated dependencies [499dd2c]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [32cf39b]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [8c6a3aa]
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
  - @usine/expression@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.

### Patch Changes

- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0
  - @usine/expression@0.2.0

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 95b26af: Loads, validates, and edits the instance folder with per-loop quarantine and checked CEL prompts, and adds a typed CEL service over plain JSON.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.

### Patch Changes

- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 57d383b: Adds GitHub App authentication, installation discovery, per-project installation coverage, local credential loading (mode 0600), and single-repository worker tokens.
- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
