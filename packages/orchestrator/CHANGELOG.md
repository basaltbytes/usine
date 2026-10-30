# @usine/orchestrator

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- 21813b5: Add configuration editing, creation, deletion, revision history, export-format diffs, and reverts to the web UI. Preserve drafts on validation errors and revision conflicts. Include declared labels in the configuration view and remove the obsolete configuration reload endpoint.
- 8cb790a: Show cloud quota refusals in Needs attention with recovery steps and explain affected runs on board cards and run pages. Retain quota warnings through retries and clear them after machine creation succeeds.
- fdecd7e: Add schema validation for configuration form drafts and API endpoints for supported harnesses, efforts, installation repositories, and live repository labels.
- 88eac4f: Add operator API endpoints to read configuration revisions, edit and delete entities, and revert changes. Reject stale writes and report validation problems by entity and field. Check runtime compatibility before saving API changes, apply accepted revisions live, and start newly created loops paused.
- 9e14070: Store authored configuration in the runtime database with atomic revisions, validation, and live updates. Import the instance folder once, and add `usine config export`, `import`, `edit`, and `log` for running and stopped instances. Reject stale edits and invalid imports without saving a revision.
  
  Share the runtime database connection between the engine and configuration store.
- 59d6496: Add loop forms with live CEL diagnostics, payload completion, registry selectors, and prompt previews. Preview stored matches before saving or resuming a loop. Expose read-only check and preview endpoints, and preserve expression positions in validation errors.
- 6d7f66f: Require a member session or instance token for operator API requests, including requests from loopback. Add GitHub browser and device sign-in, one-time setup links, local admin tokens, member management, token revocation, and browser CSRF checks. Attribute operator actions and configuration revisions to the signed-in member. Convert stored GitHub ask approvals to the UI channel while preserving their approvers.
  
  Existing instances must configure GitHub App user authorization to use GitHub sign-in. Run `usine sign-in-link` on the instance machine for access before those settings are configured.
  
  Keep the version health endpoint public so existing upgrade helpers can verify the first release with member authentication.
- 79174da: Order waiting runs with integer CEL priority expressions over item labels and other stream fields. Priorities default to zero and sort highest first, followed by lane rank and event arrival. Failed evaluations log a warning and use zero. Overview and wait and lease logs show the evaluated value; loop checks and previews validate and evaluate expressions.
  
  Scheduler layers now require `ExpressionEngine`.
  
  Queue positions now include priority and lane together. Loop preview items and Overview’s queued-run responses include the evaluated priority.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- d903ac6: Add Dismiss and Undo to Needs attention. Dismissals persist with the operator and time, exclude matching entries from attention counts and badges, and show under Dismissed on the overview. Changed entries appear again. Dismissing preserves run actions and cycle budgets.
- f54b3bd: Show Needs attention warnings when a pool's latest reported rate window reaches 80% and has a future reset. Include the recorded login, percentage, and reset time, with Dismiss and Undo. Clear warnings when a newer report recovers or the window resets, independently of scheduling.
  
  Expose the latest stored snapshot per pool through `RunReader.latestPoolRateLimits()`, with a partial index on the existing transcript table.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 4f37e20: Add npm channel checks and browser upgrades for global server installations managed by systemd. Automatic upgrades wait for running attempts to finish; a separate helper restores the previous package version if the new operator API fails to start. Configure the channel and mode with `usine config edit settings instance` and install the helper service from the server guide.
- e59f7b8: Support endpoint webhook delivery with HMAC-SHA256 verification and startup configuration of the GitHub App hook URL. Refresh registered repositories through existing hints, show the running mode and last hint in Settings, and warn after ten minutes without a verified delivery. Endpoint mode requires an active App webhook and `USINE_GITHUB_WEBHOOK_SECRET` in the instance environment.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- 5e4644e: Add webhook deliveries mode to refresh managed repositories about every 10 seconds using GitHub App delivery summaries. Persist the delivery cursor across restarts, preserve the normal polling cadence, and show the last received hint in Settings.

### Patch Changes

- fd4123b: Fix Boat gateway preflight by using Node's HTTP client for SSH workers. Gateway probes now preserve the `Host` header when connecting to a tailnet address.
- 52d1734: Include the same diagnostic message in board move rejection logs and HTTP responses for missing projects, items, or lanes and read-only lanes.
- 4739c13: Document public exports, service operations, and operator view fields, including units, defaults, failure conditions, and configuration revision behavior.
- 4144c5f: Preserve GitHub's 64-bit webhook delivery IDs when decoding summaries, filtering newer deliveries, and saving cursors. `WebhookDeliveryId` now accepts decimal strings instead of numbers; compare IDs with `BigInt`. Existing numeric cursors reset once and subsequent polls store exact strings.
- 129d669: Start with healthy workers when another worker fails preflight. Exclude failed workers from scheduling, show their messages in Needs attention, and retry with backoff until they recover. Worker preflight includes address and credential initialization. Startup still fails if every worker fails, and live reload still refuses revisions whose preflight fails.
- 78b1a94: Keep items with open runs visible on the board beyond the 500-item history window. Task detail and board moves use the same expanded selection, preserving linked-task grouping and bounded historical reads.
- 9ea42f2: Block new attempts across all loops on an item before requesting a parent stop. Keep the block until the stop succeeds, recheck it after a worker slot becomes available, and show stops from other loops in the overview and run detail.
- a22dc8e: Create provisioned machines after persisting their attempt, with the attempt label present in the creation request. Retry provider failures within the same attempt and release its machine on cancellation. `WorkerMachines.create` now requires the attempt ID; the separate `assign` operation is removed.
  
  Resume worker reservations when creation backoff expires, even if the attempt that started the pause was canceled.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.
- e13fcb6: Prune attention acknowledgements when overview entries disappear or change revision. Preserve current dismissals and Undo while removing obsolete records for repeated schedule failures and changing worker attempt counts.
- 794dd6e: Publish the operator HTTP API as an OpenAPI 3.1 document at the public `/api/openapi.json` endpoint. Add route descriptions, authentication requirements, and a generated HTTP reference to the documentation site.
- 56d4c04: Wait for all usine dependencies to resolve on npm before offering or starting a server upgrade. Retry registry propagation errors during installation, and record the rollback failure stage so automatic mode can retry install failures while continuing to skip health-check failures.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.
- f24b4a3: Preserve attention dismissals during startup until polling and schedule triggers each report a cycle. Overview refreshes then resume pruning obsolete dismissals.
- 34eae4d: Calculate worker utilization from slot counts in configuration revisions. Clarify that every second successful run of a loop on one item, including a rebase loop, counts against first time right.
- e57d084: Show item numbers, titles, and links on approval needs when their items are outside the board's item window.
- 8e49188: Show exe.dev attempts' GitHub label changes, comments, and reviews in the run reader. Match each attempt against its worker's bot identity and preserve operator board moves under the instance App.
  
  Recompute cached attribution when the configured worker identities change, including workers used by overlapping attempts.
  
  `GitHubItemHistory.appChanges` now requires the writer's `BotLogin` as its fourth argument, and `Operator.githubChanges` takes the current instance before the run ID. Removed workers have unknown writers, so the reader logs and omits their agent changes. exe.dev VMs share an integration bot; another VM's writes in the same attempt window can be attributed to the attempt.
- Updated dependencies [8cb790a]
- Updated dependencies [d1fd769]
- Updated dependencies [0536c26]
- Updated dependencies [a7692ae]
- Updated dependencies [fdecd7e]
- Updated dependencies [88eac4f]
- Updated dependencies [9e14070]
- Updated dependencies [9e14070]
- Updated dependencies [40a70c2]
- Updated dependencies [e59f7b8]
- Updated dependencies [6541e90]
- Updated dependencies [3fa96e0]
- Updated dependencies [dd88a31]
- Updated dependencies [4144c5f]
- Updated dependencies [d64b7c3]
- Updated dependencies [129d669]
- Updated dependencies [79174da]
- Updated dependencies [9ea42f2]
- Updated dependencies [1c1e516]
- Updated dependencies [59d6496]
- Updated dependencies [e3202dc]
- Updated dependencies [6d7f66f]
- Updated dependencies [9ea42f2]
- Updated dependencies [a22dc8e]
- Updated dependencies [93bbe77]
- Updated dependencies [79174da]
- Updated dependencies [24dc884]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [e13fcb6]
- Updated dependencies [d903ac6]
- Updated dependencies [06a10bf]
- Updated dependencies [56d4c04]
- Updated dependencies [9af38cb]
- Updated dependencies [f54b3bd]
- Updated dependencies [52c76fa]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [56e79a7]
- Updated dependencies [52c76fa]
- Updated dependencies [a22dc8e]
- Updated dependencies [98eb9cd]
- Updated dependencies [dfc713d]
- Updated dependencies [460d50b]
- Updated dependencies [7247fc9]
- Updated dependencies [1c1e516]
- Updated dependencies [4f37e20]
- Updated dependencies [5e4644e]
- Updated dependencies [8e49188]
- Updated dependencies [8e49188]
  - @usine/executor@0.5.0
  - @usine/core@0.6.0
  - @usine/config@0.5.0
  - @usine/agents@0.6.0
  - @usine/github@0.4.0
  - @usine/engine@0.6.0
  - @usine/expression@0.5.0
  - @usine/durable@0.2.1

## 0.4.0

### Minor Changes

- 8ea9f5b: The run page shows how many processes the kernel killed for memory in an attempt's containers on an SSH worker, and separately gives the memory limit of the last container with recorded kills, under the attempt's outcome (#600). Before, a command that needed more than `memory_mib`, such as Chromium or Vitest during `pnpm test`, was killed while the container kept running, and only the agent saw it.
  
  - Before the release removes an attempt's container, it reads the `oom_kill` count of the container's cgroup from `/sys/fs/cgroup/memory.events`, and counts one more for each start after the kernel killed the container's init, since a start gives the container a new cgroup. A count above zero is recorded through `Sink.outOfMemory` with the container's ID, and a warning logs it as `The kernel killed processes in the container for memory`. A reattachment runs the attempt in a new container, whose kills add to those of the earlier container. A count that can't be read or recorded is logged and doesn't stop the removal.
  - `@usine/core/attempt` exports `OutOfMemoryKills`, with `kills` and `memoryMib`, `ContainerOutOfMemoryKills`, which adds the `container` ID, `totalOutOfMemoryKills`, and `Attempt.outOfMemory`. `@usine/core/worker` exports `ContainerId`. `AttemptChannel.Sink` has `outOfMemory`, which takes one container's kills.
  - `RunStore.recordOutOfMemory` stores each container's kills in the new `out_of_memory_json` column of `usine_attempts`, and replaces the count of a container recorded before. `Attempt.outOfMemory` and `AttemptView.outOfMemory` add up the kills of the attempt's containers, with the memory limit of the last one, or return none and null.
- b3e696a: Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).
  
  - `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a stop that ends every process that a command started, including what it left running after it exited, a keepalive alarm that also keeps a held sandbox running, an image init that records the platform's SIGTERM, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex, only on the provider routes that the harnesses call. Each sandbox applies its credential changes one at a time and refuses credentials older than the ones it holds, so a delayed renewal can't undo a revocation. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
  - `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
  - `@usine/executor/cloudflare` creates a sandbox per attempt, checks the attempt's harness version in it before it grants credentials, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps and holds it until it reconciles or destroys it, drains an attempt within the platform's 15 minutes after SIGTERM by salvaging its checkout and failing it retryably, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions. Each child reports the outbound handler's API key as its credential, so a Codex child runs without a ChatGPT login check, and Claude Code and Codex children count in the API keys pool.
  - `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
  
  Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
- 9be864d: Two instance folders that share a GitHub App and an SSH worker machine no longer remove each other's attempt containers at startup.
  
  - `usine up` reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start. A file that doesn't contain a UUID stops `usine up` with status 1 instead of being replaced, because with a new ID usine no longer removes the containers it left before.
  - Each attempt container gets the label `dev.usine.instance-id=<instance ID>` beside `dev.usine.instance=github-app-<App ID>`, and a process removes only the containers that have both its labels. A container that an earlier version left after a crash has no ID label, so no process removes it; remove such containers once with `docker rm`.
  - `@usine/core/instance` adds `InstanceId`. `SshExecutorOptions` requires `instanceId`, and `runtimeLayer` and `workerEngineLayer` in `@usine/orchestrator` take it after the instance directory.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)). The operator API still answers a request body with an unknown key with 400 and `InvalidRequestError`, through `HttpApi.PayloadParseOptions` on its group. Effect 4.0 ignores the payload annotations that did this before.
- ac701f0: A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.
  
  The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.
  
  `@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.
  
  `StepExecutor.reserve` takes the run ID as its first argument.
  
  `WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
- 6388474: Record the time and configured operator of each failure resolution. Include resolutions in the failure-to-answer median, with separate retry and resolution figures, and refresh cached statistics after resolution. Preserve the first resolution across repeated requests and later retries.
- 7d338a2: `usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- d819599: Attempts commit as the GitHub App's bot account on every worker kind. Before, a local worker's commits took the identity in the operator's global git config, unless the agent passed one itself.
  
  `@usine/core/worker` adds `BotAccount`, a bot's `BotLogin` and `BotUserId`, with its ID-based noreply address in `noreplyEmail`. `GitHubApp.botAccount()` returns the App's bot account, read from `GET /users/<slug>[bot]` once per App slug; the bot's user ID differs from the App ID.
  
  `CheckoutRequest` requires `commitAuthor`. The local, SSH, and exe.dev executors set it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, which git prefers to `user.name` and `user.email` in any config. The values aren't secret, so remote workers export them in the command line and the machine's sshd needs no `AcceptEnv` change.
  
  The scheduler reads the bot account for each attempt and sets both `commitAuthor` and, on local and SSH workers, `botLogin` from it. If the account can't be read, the attempt fails before preparation: with an infrastructure failure, which is retried, or without a retry if GitHub refused, for example because the App has no installation.
- ceba675: Show the saved harness and model used by Retry and flag agent definition changes in run details. Edit and retry uses the current loaded definition, including when the task and agent name stay the same. Reject cancellation of failed and succeeded runs with a clear error while preserving repeated cancellation of canceled runs.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- 80f2eb6: **Discard leftovers** removes the Codex homes of the discarded attempts from an SSH worker that `usine.yaml` no longer declares. `StepExecutor` has a new required member, `discard(worker, attempts)`, which `RunEngine.discardLeftovers` runs after it stops tracking the attempts, and which never fails. The checkouts stay for the operator to remove.
  
  The SSH executor records how to reach each long-lived worker's machine when it adds the worker, in the new `SshExecutorOptions.workerRecordsDirectory`: its destination, port, identity file, and root, without secrets. `sshWorkerRecordsFor(directory)` from `@usine/executor/ssh` returns `discard`, which reads that record and removes `<root>/workers/<name>/codex/<attempt>` for each attempt over SSH. Without a record, or if the machine can't be reached, it logs that and removes nothing. The orchestrator records SSH workers in `.usine/ssh-workers/` in the instance directory and passes that `discard` to `StepExecutor` with every executor kind, so a discard still works after `usine.yaml` replaces the SSH workers with workers of another kind.
- 80f2eb6: An SSH worker no longer keeps the Codex home of an attempt that a crash ended. `Executor` has a new required member, `sweep`, which removes the files on the workers that no attempt holds or can use, and never fails. `StepExecutor.sweep` in the orchestrator's scheduler runs it before the sweep of provisioned machines, after startup recovery and at each reconcile.
  
  The SSH executor's sweep lists `<root>/workers/<name>/codex/` on each worker with its own machine and removes each Codex home whose attempt has no checkout there and that no attempt in this process holds. An attempt holds its Codex home from before the executor writes it until cleanup removes it, so a running attempt keeps its home, and so does a checkout that startup keeps for a reattachment. The local, exe.dev, and Cloudflare executors remove nothing.
- 3d54b01: Codex sessions now have a price. `SessionTokensUpdated` has an optional `breakdown` of input, cached input, cache write, and output tokens, which Codex children report. `@usine/agents/openai-prices` exports `openAiPrice`, which prices a breakdown at OpenAI's API rates for the models that the supported Codex CLI versions list.
  
  Run and task usage prices a Codex session that its harness didn't price from that table, marked as an estimate in the ChatGPT plan and not in the API keys pool. ChatGPT plan sessions that Pi prices keep Pi's figure, now shown as an estimate. A Codex model without rates stays unpriced and is logged once. The run page shows ChatGPT plan prices instead of `No dollar rate`.
- 4c63872: The orchestrator's requests to GitHub and to the gateways' admin APIs no longer send `traceparent` and `b3` headers. Neither service joins usine's traces, so the headers only exposed trace IDs. Each request still has a client span.
- b689685: Board items now include their GitHub state (`BoardItemLink.state`), so every view that lists an item can show whether it is open, closed, or merged.
  
  The web UI shows each issue and pull request the same way on every page: its GitHub icon and number in GitHub's state colour, linked to GitHub. A task is named after its earliest issue, or its pull request if it has no issue, with that item's number inline in the title. The run page, the run drawer, and the task page share one header. Run actions depend on the run's state: for a question from the agent, **Mark answered** is the primary action, and actions that apply less often are under **More actions**.
- 4c63872: `LoopFileView` adds `priority`, the loop file's queue priority, or null if it sets none. **Configuration** > **Loops** shows it on the loop's page.
- dfd0936: Polling fetches an open pull request again only when change detection reports it, its base branch head moved or can't be read, or its `mergeable` is `UNKNOWN`, instead of on every poll. Each poll reads each base branch head with one conditional request. `GitHubPolling` adds `baseRefHead`, `@usine/github/polling` exports `BaseRefName` and `BaseRefHead`, and `PullRequestPayload.baseRefName` is a `BaseRefName`.
- cd25ce0: The operator API adds `GET /api/statistics?window=7d|30d|all` (30 days by default), which computes from the stored runs, their usage, and the stored items how the factory ran in the window: closed runs by outcome, loop, agent, and harness, model, and effort; run and attempt time with median and 90th percentile beside the mean; tokens per pool and the cost of priced runs; runs closed per day; first-pass merges and lead time to merge; queue wait, attempts per run, and slot use per worker; and Needs attention entries with their waits. `RunReader.closedSince` reads the runs closed since a time.
  
  The overview ends with a Statistics section that shows these as figures and charts, with a switch between 7 days, 30 days, and all runs.
- b6f6afe: `GET /api/statistics` now returns the tasks done in the window, a task being done when its pull request merges: each task's time from its first run to the merge with the median, the split of task time between the loops' attempts and waiting, each loop's median run time, the share of tasks with no second round, the operator actions per task, and the tokens per task by loop, with a cost only when every session has a price. The run statistics move to `GET /api/statistics/runs`, which reports medians only.
  
  The Statistics section now leads the overview with four blocks: Tasks done, Time per task, First time right, and Tokens per task. The run statistics sit behind a collapsed Details disclosure and load when it opens.
- 962517f: Refresh open pull requests while check rollups are pending or expected, including absent rollups on blocked pull requests. Polling observes completed checks without waiting for a pull request update or base-branch movement.
- 4c63872: `Waiting for a free worker slot, behind N runs` counts the fewest runs that take a worker slot first, so the count doesn't overstate with several workers. A run that waits for a slot on its reattached attempt's worker counts only on the open worker with the fewest such runs: it no longer counts while another worker has none, and it still counts when every worker has one. `QueuedRun` adds `ahead`, which the desk now reads instead of the run's index in `WorkerStatus.queue`, and the `Run waits for a worker slot` log uses the same count.
- 5bc5cf5: The Board places a running card by its Item's current labels first. While a Task's newest open Run is `Running` and its current Item is open, the card goes to the first label lane that matches the Item's current labels, so a card moves to In progress as soon as `start-dev` swaps `ready-for-agent` for `agent-in-progress`. The card stays in the lane its Run's trigger matched, read from the Run's Event, only if the current labels match no label lane, for example after a Loop removes its trigger label and sets no other. The Task page names the same lane, and a Board move records the lane the card showed in.
- f01e5f2: Salvage commits and salvage rebases are authored and committed by the attempt's `commitAuthor`, the GitHub App's bot account, on every worker kind. Before, they used `usine <usine@basaltbytes.dev>`, which no GitHub account owns. The executor's git commands on a checkout now set the same `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables as the attempt's children.
  
  `Executor.recover` takes a third argument, `commitAuthor`: an effect that returns the salvage commit's author. It runs only before a salvage, so removing the checkout of a succeeded or `read` attempt doesn't read it, and its failure leaves the checkout for a later reconciliation. The orchestrator passes the App's bot account.
- 4c63872: A board card no longer shows the failure note, run line, or **Retry** of a failed run on an issue that is closed or a pull request that is closed or merged. `BoardTaskView.run` now prefers a run that needs the operator by the same check as `needsYou`, so such a run gives way to the task's open run. The run keeps **Retry** on the task page and the run page.
- 770b9a4: A failed run on an issue that is closed or a pull request that is closed or merged no longer sets the project's status to `needs-you` or marks its board card and task as needing attention. The project status, the card, the task, and Needs attention now use the same check, so a project no longer shows `needs-you` with an empty Needs attention list.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.
- 40be06c: A task's time in the overview statistics now ends at its last run's close instead of its merge, so the wait for the operator to merge a ready pull request is left out. A run still open at the merge counts until the merge. The time split per loop uses the same span.
  
  The median price of a task now covers the tasks whose sessions all have a price, instead of disappearing when one session lacks a price. `TaskCostView` has the count of priced tasks in `tasks`. The overview shows the median price beside the median time in usine, and the line under the blocks counts the tasks left out of it.
- 905bbc4: Cache task and run statistics per window for up to five minutes. Repeated requests reuse computed views while the instance and store revision remain unchanged. Run closure, retry, close-time changes, and item or budget updates invalidate the cache. Concurrent requests share computation, and debug logs report hits and misses.
- a55ab58: Each run is now a trace of its own: its root span, `RunDriver.drive`, links to the span that launched the run, such as a poll cycle or an approval request. The **Settings** configuration page shows the `tracing` block, and a reload refused for a changed `tracing` block links to it. A malformed `OTEL_RESOURCE_ATTRIBUTES` now stops `usine up` with a message that names the key, instead of crashing it. The web UI no longer sends trace headers.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.
- a5ed825: Fixes a canceled attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt could start on that worker beside the task. The attempt now keeps its run's slot, also after its execution acquired the checkout and without a restart. Each reconcile retries the stop and frees the slot once the stop succeeds. After a restart, startup still occupies a slot for each closed attempt whose stop it can't confirm.
  
  `RunEngine.cancel` moves the slot of the run's fiber to the attempt before it stops the parent task. `UnconfirmedStops` in `@usine/engine/engine` lists the attempts whose stop the engine retries, and `UnconfirmedStops.empty` lists none; `OperatorObservation` requires it. **Needs attention** shows each attempt as an `UnconfirmedStopNeed`, **\<loop\>: parent task not stopped**.
- 4c63872: **Needs attention** no longer lists the approval or failure of a run in a repository that `usine.yaml` no longer lists. Such a repository has no project, so the entry had no project status to match.
- Updated dependencies [1f7b315]
- Updated dependencies [9be864d]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [2f78d3a]
- Updated dependencies [1514af9]
- Updated dependencies [ceba675]
- Updated dependencies [392e165]
- Updated dependencies [b3e696a]
- Updated dependencies [80f2eb6]
- Updated dependencies [80f2eb6]
- Updated dependencies [4942c44]
- Updated dependencies [113d150]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [4ef6777]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [bf21f9c]
- Updated dependencies [dfd0936]
- Updated dependencies [cd25ce0]
- Updated dependencies [d82c6cd]
- Updated dependencies [266986a]
- Updated dependencies [4c63872]
- Updated dependencies [ac701f0]
- Updated dependencies [9077f43]
- Updated dependencies [6388474]
- Updated dependencies [4c63872]
- Updated dependencies [afbac5c]
- Updated dependencies [f01e5f2]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [9827419]
- Updated dependencies [7d338a2]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [a55ab58]
- Updated dependencies [e5d9dcb]
- Updated dependencies [a5ed825]
  - @usine/agents@0.5.0
  - @usine/config@0.4.0
  - @usine/core@0.5.0
  - @usine/durable@0.2.0
  - @usine/engine@0.5.0
  - @usine/executor@0.4.0
  - @usine/expression@0.4.0
  - @usine/github@0.3.0

## 0.3.0

### Minor Changes

- d866d8f: Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.
  
  Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- f060b57: Removes `updatedAt` from `BoardTaskView` in `@usine/orchestrator/operator`. Remove the field from code that constructs a `BoardTaskView`.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- a386108: Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.
  
  On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- 56ce81e: Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.
  
  `@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
- 0799f4f: The exe.dev worker runs its Pi parent in the orchestrator as a durable task and its Claude Code and Codex children on the VM over SSH, so an exe.dev attempt reattaches after an orchestrator restart instead of failing. A Pi brain is unavailable on exe.dev.
  
  `@usine/executor/exe-dev` requires an `AttemptRuntime` and no longer launches the run host: it removes `ExeDevExecutorOptions.runHost`, `RunHostCommand`, and the `run-host` worker capability, and `ExeDevExecutorOptions.ssh` takes an `SshCommand` from `@usine/agents/child-host`. Preflight runs the `@usine/agents/preflight` checks on the VM over SSH, and the `@usine/orchestrator/exe-dev` `layer` requires an `AttemptRuntime`.
- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- 3088f0e: Before a queued event opens a run, the engine rechecks whether the loop's trigger still matches the item through the new `TriggerCondition` port (`@usine/engine/trigger-condition`), which `layerWithDatabase` and the local SQLite layer require. An event that no longer matches is revoked, and a check that can't complete opens the run as before.
  
  The orchestrator rechecks against a fresh GitHub snapshot, so a run that pushes a commit and then swaps its trigger labels no longer starts a second run.
- 39f8d4b: Loops, agents, and the `labels`, `repos`, `settings`, and `operator` keys of `usine.yaml` reload without a restart; new runs use the new configuration, and an open run keeps its agent. An invalid `usine.yaml` fails the reload with `FactoryConfigError`, a changed `workers` or `webhooks` block fails it with `RestartRequiredError`, and both keep the running configuration.
  
  `@usine/orchestrator/current-instance` exports `CurrentInstance`, whose `reload` returns an `InstanceReload` of what changed, and the operator API adds `POST /api/instance/reload`. `Orchestrator.run`, `PollingTriggers.run(current)`, `ScheduleTriggers.run(current)`, `runtimeLayer(instanceDirectory)`, `triggerConditionLayer`, `gitHubCredentialLayer`, and the worker layers read the instance through `CurrentInstance` instead of taking a loaded instance.
- 419bbd7: An accepted reload starts the next poll cycle at once, but still waits for a time GitHub asked for, such as a rate-limit reset. If the reload adds a brain that no running agent has, it preflights that brain on every worker first, and a failure rejects the reload with the new `ReloadPreflightError`, which names the agents.
  
  `CurrentInstance` adds `changes`, a stream of snapshots, and `registerPreflight`, which `stepExecutorLayer` calls with its worker preflight. `PollingTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance.
- af28e0e: A refused `POST /api/instance/reload` returns the refusal's typed fields with `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). The Configuration section lists what the refusal names, each linked to its page.
  
  `@usine/orchestrator/operator/http` exports `RestartRequiredRefusal`, `ReloadPreflightRefusal`, `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, and the derived client decodes a refused reload into one of them.
- 425e240: An accepted reload evaluates new or changed schedule loops at once instead of up to a minute later. `ScheduleTriggers.run` takes the `get` and `changes` of a `CurrentInstance`, like `PollingTriggers.run`.
- ba8e26f: A reload applies `workers` changes without affecting running attempts. A higher `max_concurrent_attempts` preflights the new slots and lets them take waiting runs at once, a lower one retires extra slots as their attempts end, a new worker of the executor's kind takes attempts once preflight passes (the SSH composition re-adds only workers it started with), and a removed worker leaves the scheduler after its last attempt. A changed kind or setting, a renamed worker, or a new worker that the executor can't run still fails the reload with `RestartRequiredError`.
  
  `RestartRequiredError` adds `fields` (such as `workers.build-1.destination`), `ReloadPreflightError` adds `workers` and allows empty `agents`, and `InstanceReload` adds `workers`. `CurrentInstance.registerWorkers`, which takes a `WorkerReload`, replaces `registerPreflight`, and `stepExecutorLayer` takes `StepExecutorOptions` with `startupWorkersOnly`.
- 2fc760a: Renames the item-level hold to suppression, so hold means only the session hold. In `@usine/engine/engine`, the `Held` submission result becomes `Suppressed`, and in `@usine/engine/run-reader`, `LoopSighting.heldBy` becomes `suppressedBy`. In `@usine/orchestrator/operator`, `HeldForOperatorView` becomes `SuppressedForOperatorView`, whose tag is `SuppressedForOperator`. A migration renames the `usine_loop_items` columns `held_by_run_id` and `held_event_id` to `suppressed_by_run_id` and `suppressed_event_id` and keeps their values.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- cba7d35: Operators can run a succeeded or canceled run again. `RunEngine.runAgain` takes a `RunAgainRequest` and records a new event for the run's item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`; it returns `Claimed` or `CycleBlocked`, and fails for a run in another state or while another run of the loop is open on the item.
  
  Adds `canRunAgain` to `RunState.operatorActions`, `RunAgain` to `@usine/core/run/again`, the `usine_run_again_events` table, `runAgain` to `RunSnapshot`, `RunSummary`, and `RunView`, `Operator.runAgain` with the new `LoopNotFoundError`, and `POST /api/runs/:runId/run-again`. The drawer and run page offer **Run again** and **Edit and run again** on succeeded and canceled runs.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- ec5c4d4: Adds `BoardMoves` to `@usine/engine/board-moves`, which records the operator's board moves in the new `usine_board_moves` table. `Operator.moveBoardItem` records each move before it sends the label swap, and `Operator.githubChanges` lists a matching label change as a `BoardMovedView`, so the run page shows it as the operator's move.
  
  Moves made before this change still show as the agent's label changes.
- cef956c: Adds `GitHubItemHistory.appChanges(repository, item, since)` to `@usine/github/item-history`, which returns the App's label changes, comments, and reviews on an item as `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`; `Installation` adds `appSlug`. `Operator.githubChanges(runId)` returns each attempt's changes as `RunGitHubChangesView` at `GET /api/runs/:runId/github-changes`, which returns 404 `GitHubItemNotFoundError` for an item that GitHub no longer has.
  
  The run page shows each label change, comment, and review that an agent made on the item where it happened.
- b99cdc8: While a task's newest open run is `Running` and its item is open, the board keeps its card in the first label lane that matches the item's labels when the trigger matched. A loop that removes its trigger label first, such as `review-pr` removing `ready-for-review`, no longer moves its card to a state lane while it runs.
  
  `projectBoard` takes the running runs' events as an optional last argument, and the error type of `Operator.moveBoardItem` includes `RunStoreError`.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 40194a0: The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.
  
  `AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".
- 34dec09: Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.
  
  The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
- f060b57: Adds `closedAt` to `RunView` in `@usine/orchestrator/operator`, which the desk's last outcomes use, and `usage` to `BoardTaskView`: a `TaskUsageView` with the task's wall time, tokens, and dollars per billing pool (`TaskPoolUsageView`). A pool's `unpriced` flag marks its `cost` as a lower bound, and `RunUsageReader.read` accepts a run summary as well as a snapshot.
  
  Add the new fields to code that constructs `RunView` or `BoardTaskView`.
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- af28e0e: `Operator.detail` caches the token reports of ended attempts in memory until the orchestrator restarts. Each poll from the run page and drawer reads only the running attempt.
- 9464a41: Repository names in `usine.yaml` and loop selectors, and board lane labels, match case-insensitively, as on GitHub. `usine.yaml` rejects repos or selector entries that differ only in case, and lane `label` sources that differ only in case count as one.
- 81c048b: `StepExecutor.execute` takes an `ExecutionSink`: the attempt's channel sink and `checkoutAcquired`, which the executor runs once preparation acquires the checkout. Until then, the engine reconciles a checkout that a restart kept for reattachment: canceling the run records the salvage and removes the checkout, and a failed reattachment reconciles it before the failure is recorded.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- ebfb373: A deleted or transferred issue that the queued-event recheck finds missing leaves the board's open lanes. `TriggerCondition.recheck` replaces `TriggerCondition.holds` and returns a `TriggerRecheck` from `@usine/engine/trigger-condition`: `matches`, `no-longer-matches`, or `item-gone`.
  
  For the last two, the engine revokes the item's queued events, and for `item-gone` it also calls `ItemProjectionWriter.markGone`. An adapter that can't tell returns `matches`, as it returned `true` before.
- 291d428: At most every 10 minutes per repository, the poll marks deleted or transferred issues as gone, removing their cards from the board's open lanes and revoking their unstarted runs.
- 3ed742f: An open pull request that GitHub no longer has leaves the board's open lanes. The poll calls the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the item's projection until a later poll sees the item again, and the board places a gone item by its closed state; a migration adds `gone_at` to `usine_item_projections`.
- 8a0bcc1: An `if:` that fails to evaluate on an item no longer stops the repository's poll: the failure affects only that loop and item, and the cursor advances. **Needs you** lists `if:` and prompt failures with their loop and item while they last, and the first poll after a restart evaluates failing items again.
- af28e0e: `RunReader.closed({ limit })` returns the `limit` most recently closed runs, newest first, regardless of when they opened. The overview's **Last outcomes** uses it, so it lists a run that opened long ago and closed recently.
- 564449d: An open pull request or failing item that GitHub no longer has no longer stops its repository's poll. The poll logs a warning, drops the item from the cursor, and revokes its unstarted runs; `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the item is missing or GraphQL reports `NOT_FOUND`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d0944ca: Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- 72d0fae: A queued event's trigger recheck gives up after five seconds with a warning, and the event proceeds.
- 8c6a3aa: `/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.
  
  `ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.
- 3ed742f: The queued-event recheck no longer opens a run for an item that GitHub no longer has. On `GitHubItemNotFoundError`, `TriggerCondition.holds` returns `false` and the item's queued events are revoked; a failed request or a recheck over five seconds still opens the queued event.
- ca2e7a5: If GitHub refuses to mint an attempt's token, the attempt fails with GitHub's reason, without a retry; outages and rate limits are retried.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- 3f13b80: `StepExecutor.reserve` takes `worker: Option<WorkerName>`. With a worker, the lease comes only from that worker, and the scheduler serves the reservation before unnamed ones without blocking runs that another worker can take.
  
  `StepExecutor` adds `occupy(worker)`, which takes a slot at once for an attempt already running on the worker, even beyond `max_concurrent_attempts`, and logs a warning in that case.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- ff148e0: Retries a failed exe.dev credential grant renewal every minute until it succeeds, and sizes the grant window independently of `max_attempt_minutes`. The run drawer shows the last salvage failure of a retained worktree, which every startup retries; the recorded failure includes git's stderr and names a stalled push instead of a bare `TimeoutError`.
- 7853f53: A reload can add an SSH worker and reads its gateway's admin token before preflight; an unset token variable refuses the reload. A removed SSH worker leaves after its last attempt.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
- d98bef0: Worker preflight checks the machine's memory against `max_concurrent_attempts`, and `Executor.preflight` takes `maxConcurrentAttempts` as a third argument. Preflight fails with the new `memory` capability below 1.5 GiB per concurrent attempt, or with no swap and more than one concurrent attempt, and warns below 3 GiB per concurrent attempt.
- Updated dependencies [a3a230c]
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [efdcf43]
- Updated dependencies [b36ffc7]
- Updated dependencies [6672585]
- Updated dependencies [9464a41]
- Updated dependencies [9739f3a]
- Updated dependencies [425e240]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [ca2e7a5]
- Updated dependencies [7a6d96f]
- Updated dependencies [b928d0d]
- Updated dependencies [499dd2c]
- Updated dependencies [e518906]
- Updated dependencies [759db71]
- Updated dependencies [8292038]
- Updated dependencies [0799f4f]
- Updated dependencies [14c2d3c]
- Updated dependencies [d3942c0]
- Updated dependencies [d039c91]
- Updated dependencies [0799f4f]
- Updated dependencies [81c048b]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [7db1cae]
- Updated dependencies [425e240]
- Updated dependencies [66f6b0b]
- Updated dependencies [eedf20c]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [3ed742f]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [81c048b]
- Updated dependencies [af28e0e]
- Updated dependencies [23e8f15]
- Updated dependencies [91e2b70]
- Updated dependencies [291d428]
- Updated dependencies [564449d]
- Updated dependencies [32cf39b]
- Updated dependencies [291d428]
- Updated dependencies [75a4fcf]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [4d4c6bd]
- Updated dependencies [5870baf]
- Updated dependencies [562ba5f]
- Updated dependencies [0dac1bd]
- Updated dependencies [8c6a3aa]
- Updated dependencies [99164fa]
- Updated dependencies [3f13b80]
- Updated dependencies [b601259]
- Updated dependencies [3088f0e]
- Updated dependencies [6d70b40]
- Updated dependencies [2729e91]
- Updated dependencies [81c048b]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [7a5249f]
- Updated dependencies [2fc760a]
- Updated dependencies [d799713]
- Updated dependencies [3f13b80]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [f966404]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [f060b57]
- Updated dependencies [8f43ed7]
- Updated dependencies [6764fa7]
- Updated dependencies [ec5c4d4]
- Updated dependencies [b99cdc8]
- Updated dependencies [cef956c]
- Updated dependencies [466e711]
- Updated dependencies [1877119]
- Updated dependencies [ff148e0]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [7853f53]
- Updated dependencies [ba8e26f]
- Updated dependencies [761099a]
- Updated dependencies [dda5892]
- Updated dependencies [6714868]
- Updated dependencies [d933ab6]
- Updated dependencies [32651fd]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
- Updated dependencies [d3942c0]
- Updated dependencies [fcd3671]
- Updated dependencies [425e240]
- Updated dependencies [d98bef0]
- Updated dependencies [8665053]
  - @usine/config@0.3.0
  - @usine/core@0.4.0
  - @usine/durable@0.1.0
  - @usine/executor@0.3.0
  - @usine/engine@0.4.0
  - @usine/expression@0.3.0
  - @usine/github@0.2.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/executor@0.2.1
  - @usine/run-host@0.3.0
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 485f244: Starts PR-triggered attempts at the event's exact head commit.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- e7adbd8: Derives operator actions from the run lifecycle rules.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [3db806c]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [410607d]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [7dc019e]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/executor@0.2.0
  - @usine/run-host@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.
- 05937b8: Adds schedule triggers with IANA time zones, one tick per repository, and catch-up of the latest missed tick.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [24eef02]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [7bd5cdb]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/engine@0.1.0
  - @usine/executor@0.1.0
  - @usine/run-host@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
