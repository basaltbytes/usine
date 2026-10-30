# @usine/server

## 0.6.0

### Minor Changes

- 25728fa: Allow a boolean CEL condition to require approval per run. Save and display the
  approval decision, require approval when evaluation fails, and validate conditions
  in the loop editor and configuration API.
- 13bdef9: Guide first-run setup through GitHub App creation, credential recovery, installation, and first-admin sign-in. Save App and OAuth secrets atomically with mode 0600, support existing credential files, and initialize empty instance configuration in the database.
- a7bd195: Add an exact browser origin allowlist with credentialed CORS and security headers on all server responses. Configure additional origins in `auth.origins` and restart; loopback browser origins now require an explicit entry unless they are the canonical server origin. Document public HTTPS deployment with Caddy, Cloudflare Tunnel, and Tailscale Serve.
- 50ab3dd: Run preflight on an idle worker from Configuration > Workers or `POST /api/workers/:worker/preflight`. Checks refresh the worker's stored results, scheduling availability, and Needs attention without a restart. Busy workers return a typed refusal.

### Patch Changes

- 1f12974: Apply webhook mode and URL changes and add Cloudflare workers without restarting the orchestrator. New Cloudflare workers resolve credentials and register a client before preflight; existing clients remain unchanged. A refused addition of a never-accepted worker releases its client, so a corrected revision can add the worker; an accepted worker keeps its client. Document why tracing and existing worker connection fields require a restart.
- 45bb9cb: Keep worker slots free while an idle upgrade defers new attempts. Show the requested version on deferred runs and worker rows, and report prolonged waits in Needs attention. Cancel a pending upgrade from Settings or with `DELETE /api/upgrade` to resume attempts without restarting.
- Updated dependencies [25728fa]
- Updated dependencies [13bdef9]
- Updated dependencies [13bdef9]
- Updated dependencies [1f12974]
- Updated dependencies [a7bd195]
- Updated dependencies [45bb9cb]
- Updated dependencies [50ab3dd]
  - @usine/config@0.6.0
  - @usine/engine@0.7.0
  - @usine/orchestrator@0.6.0
  - @usine/github@0.5.0

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- 21813b5: Add configuration editing, creation, deletion, revision history, export-format diffs, and reverts to the web UI. Preserve drafts on validation errors and revision conflicts. Include declared labels in the configuration view and remove the obsolete configuration reload endpoint.
- 8cb790a: Show cloud quota refusals in Needs attention with recovery steps and explain affected runs on board cards and run pages. Retain quota warnings through retries and clear them after machine creation succeeds.
- fdecd7e: Add configuration forms for agents, workers, settings, and repositories with lanes. Forms validate with the entity schemas, display field errors, preserve drafts when switching to text, and save revisions with optional messages. Add installation repository and live label choices, keyboard and drag lane ordering, persona previews, and worker restart and container-limit guidance.
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
- 24dc884: Add project boards and task navigation across several repositories, with repository filters and redirects from repository-based URLs. Add project forms for names, repository order, and shared lanes. Loop creation selects a project and limits selector choices to that project's repositories.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- 794dd6e: Publish the operator HTTP API as an OpenAPI 3.1 document at the public `/api/openapi.json` endpoint. Add route descriptions, authentication requirements, and a generated HTTP reference to the documentation site.
- d903ac6: Add Dismiss and Undo to Needs attention. Dismissals persist with the operator and time, exclude matching entries from attention counts and badges, and show under Dismissed on the overview. Changed entries appear again. Dismissing preserves run actions and cycle budgets.
- 7010543: Add a command palette with project, task, run, and configuration navigation and available page actions. Show running counts in the sidebar and last refresh times with persistent failure warnings in page headings.
- 4f37e20: Add npm channel checks and browser upgrades for global server installations managed by systemd. Automatic upgrades wait for running attempts to finish; a separate helper restores the previous package version if the new operator API fails to start. Configure the channel and mode with `usine config edit settings instance` and install the helper service from the server guide.
- e59f7b8: Support endpoint webhook delivery with HMAC-SHA256 verification and startup configuration of the GitHub App hook URL. Refresh registered repositories through existing hints, show the running mode and last hint in Settings, and warn after ten minutes without a verified delivery. Endpoint mode requires an active App webhook and `USINE_GITHUB_WEBHOOK_SECRET` in the instance environment.
- 5e4644e: Add webhook deliveries mode to refresh managed repositories about every 10 seconds using GitHub App delivery summaries. Persist the delivery cursor across restarts, preserve the normal polling cadence, and show the last received hint in Settings.

### Patch Changes

- fd4123b: Fix Boat gateway preflight by using Node's HTTP client for SSH workers. Gateway probes now preserve the `Host` header when connecting to a tailnet address.
- 0536c26: Exclude unchanged configuration entities from import revisions when adding or removing a worker. Preserve worker preference changes and canonical values across configuration export and import.
- 973be48: Hide the resume action for Codex children that used an external credential, including the gateway's ChatGPT login. Sessions that used a local login keep their resume command and recorded Codex home.
- f7b42bb: Highlight the selected command palette item. Previously, hovering an item or moving the selection with the arrow keys changed nothing on screen.
- 40a70c2: Record configuration revision positions only for workers, relative to the worker list. Adding or removing an entity no longer adds unrelated entities to the revision or their `usine config log` history. Preserve worker order when importing and replaying revisions.
- 52d1734: Include the same diagnostic message in board move rejection logs and HTTP responses for missing projects, items, or lanes and read-only lanes.
- 68b5681: Fix durable backup filenames for destinations with dots. Preserve only `.sqlite` and `.db` extensions; append `.durable.sqlite` to all other destination names.
- 129d669: Start with healthy workers when another worker fails preflight. Exclude failed workers from scheduling, show their messages in Needs attention, and retry with backoff until they recover. Worker preflight includes address and credential initialization. Startup still fails if every worker fails, and live reload still refuses revisions whose preflight fails.
- e3202dc: Print startup sign-in links only on terminals. Check local admin token ownership and reject symbolic links, and fail lifecycle commands when the token file is unreadable or unsafe. Record token use at most once a minute, delete expired credentials when listing tokens, and revoke GitHub user tokens after reading identity.
- 93bbe77: Upgrade the Pi packages to 1.4.0 and define the checkpoint policies required by pi-durable. Attempt and hold documents retain their existing delta-storage behavior. Disable the task restart limit to preserve automatic resumption after repeated crashes.
  
  Back up the instance with `usine backup <path>` before upgrading. Starting the upgraded server migrates `durable.sqlite` to SQLite storage schema version 2, which pi-durable 1.3.0 and earlier cannot open. Do not downgrade usine past this release: `usine upgrade <older version>` cannot reverse the storage migration.
- e13fcb6: Prune attention acknowledgements when overview entries disappear or change revision. Preserve current dismissals and Undo while removing obsolete records for repeated schedule failures and changing worker attempt counts.
- faa6750: Show needs attention in a header notification tray with grouped rows, live counts, and run actions. On phones, the tray opens as a full-width sheet. Overview keeps the full list and dismissed entries.
  
  Cycle-budget rows show the exhausted loop and provide keyboard-accessible details with completed rounds and each loop's run count.
  
  Unconfigured-worker rows provide keyboard- and touch-accessible details with attempt counts and recovery instructions.
- 56d4c04: Wait for all usine dependencies to resolve on npm before offering or starting a server upgrade. Retry registry propagation errors during installation, and record the rollback failure stage so automatic mode can retry install failures while continuing to skip health-check failures.
- 9af38cb: Install Pi's HTTP dispatcher before opening the first parent harness. Server requests use proxy-aware HTTP/1.1 connections with five-minute stream timeouts, and interrupted response streams reject without an unhandled dispatcher error terminating the process.
- f54b3bd: Show Needs attention warnings when a pool's latest reported rate window reaches 80% and has a future reset. Include the recorded login, percentage, and reset time, with Dismiss and Undo. Clear warnings when a newer report recovers or the window resets, independently of scheduling.
  
  Expose the latest stored snapshot per pool through `RunReader.latestPoolRateLimits()`, with a partial index on the existing transcript table.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 8cd2d1c: Restart the previous server after a failed upgrade or rollback install when that version remains installed. Preserve the original upgrade failure reason after recovery, and request a manual reinstall only when the installed version matches neither the target nor the previous version.
- 52d1734: Keep the last verified upgrade version available while a newer release is still publishing. Report registry probe details in logs and reserve the upgrade status message for upgrade failures.
- f648872: Prefetch web screen data during navigation and share query options across pages, drawers, and actions. Keep statistics visible during window changes and preserve transcript history when opening a run from its drawer.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.
- de8dcb8: Preserve conversation following when scroll input leaves the viewport still, including gestures at a tool output's edge, horizontal code scrolling, and scroll keys in a focused tool output.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- f24b4a3: Preserve attention dismissals during startup until polling and schedule triggers each report a cycle. Overview refreshes then resume pruning obsolete dismissals.
- 34eae4d: Calculate worker utilization from slot counts in configuration revisions. Clarify that every second successful run of a loop on one item, including a rebase loop, counts against first time right.
- 2bf4be2: Add the usine logo to the sidebar and the browser tab, and show running runs, attempts, and tool calls with an animated logo instead of a pulsing dot or a spinner.
- 8e49188: Show exe.dev attempts' GitHub label changes, comments, and reviews in the run reader. Match each attempt against its worker's bot identity and preserve operator board moves under the instance App.
  
  Recompute cached attribution when the configured worker identities change, including workers used by overlapping attempts.
  
  `GitHubItemHistory.appChanges` now requires the writer's `BotLogin` as its fourth argument, and `Operator.githubChanges` takes the current instance before the run ID. Removed workers have unknown writers, so the reader logs and omits their agent changes. exe.dev VMs share an integration bot; another VM's writes in the same attempt window can be attributed to the attempt.
- Updated dependencies [fd4123b]
- Updated dependencies [d1fd769]
- Updated dependencies [21813b5]
- Updated dependencies [0536c26]
- Updated dependencies [8cb790a]
- Updated dependencies [fdecd7e]
- Updated dependencies [88eac4f]
- Updated dependencies [9e14070]
- Updated dependencies [9e14070]
- Updated dependencies [40a70c2]
- Updated dependencies [e59f7b8]
- Updated dependencies [52d1734]
- Updated dependencies [6541e90]
- Updated dependencies [4739c13]
- Updated dependencies [3fa96e0]
- Updated dependencies [dd88a31]
- Updated dependencies [4144c5f]
- Updated dependencies [d64b7c3]
- Updated dependencies [129d669]
- Updated dependencies [79174da]
- Updated dependencies [1c1e516]
- Updated dependencies [59d6496]
- Updated dependencies [e3202dc]
- Updated dependencies [6d7f66f]
- Updated dependencies [78b1a94]
- Updated dependencies [9ea42f2]
- Updated dependencies [a22dc8e]
- Updated dependencies [93bbe77]
- Updated dependencies [79174da]
- Updated dependencies [24dc884]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [e13fcb6]
- Updated dependencies [794dd6e]
- Updated dependencies [d903ac6]
- Updated dependencies [56d4c04]
- Updated dependencies [9af38cb]
- Updated dependencies [f54b3bd]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [4f37e20]
- Updated dependencies [56e79a7]
- Updated dependencies [e59f7b8]
- Updated dependencies [52c76fa]
- Updated dependencies [dfc713d]
- Updated dependencies [460d50b]
- Updated dependencies [f24b4a3]
- Updated dependencies [34eae4d]
- Updated dependencies [1c1e516]
- Updated dependencies [4f37e20]
- Updated dependencies [e57d084]
- Updated dependencies [5e4644e]
- Updated dependencies [8e49188]
  - @usine/orchestrator@0.5.0
  - @usine/core@0.6.0
  - @usine/config@0.5.0
  - @usine/github@0.4.0
  - @usine/engine@0.6.0
  - @usine/expression@0.5.0
  - @usine/durable@0.2.1

## 0.4.0

### Minor Changes

- e84a999: Every `usine` command reads `.env` in the instance folder when it starts, so `usine restart` and `usine upgrade` work from a shell that doesn't set a gateway's admin token or the other variables that `usine up` reads. As with dotenv, a variable that the environment sets keeps its value, and `.env` sets the others. usine doesn't expand variables or run commands in `.env`, and doesn't pass its variables to child processes beyond their allowlists. A `.env` that exists but can't be read stops the command with status 1.
- e22d67c: The CLI manages a running instance. `usine up` writes `.usine/instance.json` with its PID, port, version, start time, and command line, next to `.usine/instance.pid`, and removes both when it exits.
  
  - `usine status` reports whether `usine up` runs, its PID, address, engine version, uptime, open runs, and a newer pinned version on npm. It exits with status 3 if none runs.
  - `usine stop [--timeout <seconds>] [--force]` sends `SIGTERM` and waits for the drain. A repeated `stop` doesn't end the drain; `--force` does.
  - `usine restart` stops the instance and starts its recorded command line in the background, with the output in `.usine/usine.log`. `usine up --detach` does the same start for a stopped instance.
  - `usine upgrade [<version>] [--check]` backs up the stores into `.usine/backups/`, moves the `@usine/*` pins in `package.json`, installs them with the instance's package manager, commits the change, and restarts. For an engine outside the instance, such as a checkout, it changes nothing and says how to update it.
  
  `restart` and `upgrade` refuse while a run has a running attempt, unless `--force`, and when neither the shell nor the instance folder's `.env` sets a gateway's admin token variable.
- 4c63872: `usine up` takes `--log-level <level>`, or `USINE_LOG_LEVEL`, with `trace`, `debug`, `info`, `warn`, or `error`, in any case. The default stays `info`. Use `debug` to see the lines that say why usine skipped or deferred something, such as a run left out of **Needs attention** or a pull request that a poll didn't fetch again. An unknown level stops `usine up` with the usage. `usine up --detach`, `usine restart`, and `usine upgrade` start the new process with the level of the recorded launch.
- 77bf7eb: `usine up --origin <url>`, or `USINE_ORIGIN`, names the URL at which a proxy publishes the UI, such as the HTTPS URL of `tailscale serve` ([#609](https://github.com/basaltbytes/usine/issues/609)). The operator API accepts browser requests from pages at that origin, as it does from the loopback names, and refuses other origins. The server still listens only on `127.0.0.1`. `usine up` records the origin in `.usine/instance.json`, so `usine restart` passes it again, and `usine status` shows it.
- 7d338a2: `usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.
- 77bf7eb: `usine status`, `usine stop`, `usine restart`, and `usine upgrade` manage an orchestrator that a systemd service runs with `systemctl` ([#609](https://github.com/basaltbytes/usine/issues/609)). `usine up` records the system service whose cgroup it runs in, from `/proc/self/cgroup`, as `systemdUnit` in `.usine/instance.json`. If `systemctl show` reports the process as that service's main process, the commands start the drain with `systemctl stop --no-block`, so that systemd doesn't restart the service, and start it again with `systemctl start`, waiting until the new process answers. A start whose service fails or waits to restart is stopped with `systemctl stop --no-block`, so that a failing start, such as a failed migration, doesn't repeat, also when `systemctl start` itself fails. `usine status` adds a `service` line. A failed `systemctl` command, such as one that the user may not run, stops the command with status 1 and names it.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 32535dd: Each board lane scrolls its own cards, so scrolling one lane no longer moves the others. The lanes fill the board's height, and a lane fades its top or bottom edge while cards are hidden there.
- ceba675: Show the saved harness and model used by Retry and flag agent definition changes in run details. Edit and retry uses the current loaded definition, including when the task and agent name stay the same. Reject cancellation of failed and succeeded runs with a clear error while preserving repeated cancellation of canceled runs.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- 80f2eb6: The run page's **Resume this session** command finds a Codex child's session in the attempt's own Codex home, which an attempt behind a gateway with `openai` in `llm_providers` gets: it sets `CODEX_HOME` to that directory before `codex resume`. For a child whose model requests used the gateway's credential, the line under the command says that the gateway credential isn't available from your shell, instead of naming the attempt's harness login. On a provisioned worker, such a child gets that line under the note about the attempt's machine, as the gateway credential or API key.
- 3d54b01: Codex sessions now have a price. `SessionTokensUpdated` has an optional `breakdown` of input, cached input, cache write, and output tokens, which Codex children report. `@usine/agents/openai-prices` exports `openAiPrice`, which prices a breakdown at OpenAI's API rates for the models that the supported Codex CLI versions list.
  
  Run and task usage prices a Codex session that its harness didn't price from that table, marked as an estimate in the ChatGPT plan and not in the API keys pool. ChatGPT plan sessions that Pi prices keep Pi's figure, now shown as an estimate. A Codex model without rates stays unpriced and is logged once. The run page shows ChatGPT plan prices instead of `No dollar rate`.
- 9be864d: Two instance folders that share a GitHub App and an SSH worker machine no longer remove each other's attempt containers at startup.
  
  - `usine up` reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start. A file that doesn't contain a UUID stops `usine up` with status 1 instead of being replaced, because with a new ID usine no longer removes the containers it left before.
  - Each attempt container gets the label `dev.usine.instance-id=<instance ID>` beside `dev.usine.instance=github-app-<App ID>`, and a process removes only the containers that have both its labels. A container that an earlier version left after a crash has no ID label, so no process removes it; remove such containers once with `docker rm`.
  - `@usine/core/instance` adds `InstanceId`. `SshExecutorOptions` requires `instanceId`, and `runtimeLayer` and `workerEngineLayer` in `@usine/orchestrator` take it after the instance directory.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- ce89267: `usine up --detach`, `usine restart`, and `usine upgrade` wait for a long startup recovery instead of reporting that the new process didn't answer. The orchestrator listens only after startup recovery reconciles the checkouts that earlier attempts left on workers, which can take minutes. A start now keeps waiting while the new process writes to `.usine/usine.log`, and gives up after `--timeout` seconds (120 by default) in which the process neither listens nor writes a line. The process keeps running when the command gives up.
- 9c7ea97: Runs on `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). When `usine up` can't open `.usine/runtime.sqlite`, it stops with `runtime store error: could not open local database` and the reason, instead of a defect with SQLite's error.
- 9077f43: `usine stop --force`, `usine restart --force`, and `usine upgrade --force` send `SIGKILL` to an orchestrator that still runs after `--timeout` ([#573](https://github.com/basaltbytes/usine/issues/573)), and print `usine (pid <pid>) did not exit within <timeout>. Sent SIGKILL: the next start reattaches the running attempts.` Before, the command exited with status 1 and suggested `--force`, which was already set. `restart` and `upgrade` then continue with the start. If the process still runs 5 seconds after `SIGKILL`, the command fails with `KillTimeoutError`.
- b689685: Board items now include their GitHub state (`BoardItemLink.state`), so every view that lists an item can show whether it is open, closed, or merged.
  
  The web UI shows each issue and pull request the same way on every page: its GitHub icon and number in GitHub's state colour, linked to GitHub. A task is named after its earliest issue, or its pull request if it has no issue, with that item's number inline in the title. The run page, the run drawer, and the task page share one header. Run actions depend on the run's state: for a question from the agent, **Mark answered** is the primary action, and actions that apply less often are under **More actions**.
- c6efd59: `usine status`, `usine stop`, `usine restart`, and `usine upgrade` read the `.usine/instance.json` of a `usine up` that started before `--log-level` existed. They ignored that record as unreadable, so `usine restart` refused the instance. `usine restart` now starts it again at the `info` log level.
  
  `usine restart` also restarts an instance whose record is missing or still unreadable, such as one that `@usine/server` 0.3.0 started, which writes only `.usine/instance.pid`. It checks for running attempts and gateway variables on the port where that process answers, stops it, and starts `usine up` as `usine up --detach` without flags would, on the port that the shell or `.env` sets. Before, it refused and said to run `usine stop`, then `usine up --detach`.
- 77bf7eb: The macOS sleep warning of `usine up` also suggests running the orchestrator on an always-on server, and links to the new guide [Run the orchestrator on a server](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) ([#609](https://github.com/basaltbytes/usine/issues/609)). The guide creates a Hetzner Cloud server in the gateway's private network with `infra/hetzner/gateway/gateway.sh orchestrator`, runs `usine up` in a systemd service, publishes the web UI on the tailnet with `tailscale serve`, and moves an instance there from a laptop.
- cd25ce0: The operator API adds `GET /api/statistics?window=7d|30d|all` (30 days by default), which computes from the stored runs, their usage, and the stored items how the factory ran in the window: closed runs by outcome, loop, agent, and harness, model, and effort; run and attempt time with median and 90th percentile beside the mean; tokens per pool and the cost of priced runs; runs closed per day; first-pass merges and lead time to merge; queue wait, attempts per run, and slot use per worker; and Needs attention entries with their waits. `RunReader.closedSince` reads the runs closed since a time.
  
  The overview ends with a Statistics section that shows these as figures and charts, with a switch between 7 days, 30 days, and all runs.
- b6f6afe: `GET /api/statistics` now returns the tasks done in the window, a task being done when its pull request merges: each task's time from its first run to the merge with the median, the split of task time between the loops' attempts and waiting, each loop's median run time, the share of tasks with no second round, the operator actions per task, and the tokens per task by loop, with a cost only when every session has a price. The run statistics move to `GET /api/statistics/runs`, which reports medians only.
  
  The Statistics section now leads the overview with four blocks: Tasks done, Time per task, First time right, and Tokens per task. The run statistics sit behind a collapsed Details disclosure and load when it opens.
- 266986a: The nine `@earendil-works/*` packages are at 1.2.0. pi-durable 1.2 closes the harness on any storage error, a read included, so `DurableHarness` now handles a failed harness instead of a poisoned session or a stuck step:
  
  - An attempt that is running when a storage error fails the harness fails with a retryable `InfraFailure` whose cause is the new `DurableStorageFailed`, and the engine retries it from salvage. The harness reopens the storage, aborts those attempts' tasks, and resumes the other tasks.
  - A storage error before the harness resumes its tasks fails the layer with a `DurableHarnessError` that names the error, and `usine up` doesn't start.
  - If the reopen fails, or the reopened harness fails within a minute, the harness stops until the orchestrator restarts.
  
  `HarnessListener` replaces `onReopen` and `onStop` with `onFailure`, `BeforeResume` also receives the storage, and `StuckStepReports` is removed. The `subagent` tool returns the child's report as `output`, the field that pi-durable 1.2 reads instead of `content`.
- 6388474: Record the time and configured operator of each failure resolution. Include resolutions in the failure-to-answer median, with separate retry and resolution figures, and refresh cached statistics after resolution. Preserve the first resolution across repeated requests and later retries.
- 5bc5cf5: The Board places a running card by its Item's current labels first. While a Task's newest open Run is `Running` and its current Item is open, the card goes to the first label lane that matches the Item's current labels, so a card moves to In progress as soon as `start-dev` swaps `ready-for-agent` for `agent-in-progress`. The card stays in the lane its Run's trigger matched, read from the Run's Event, only if the current labels match no label lane, for example after a Loop removes its trigger label and sets no other. The Task page names the same lane, and a Board move records the lane the card showed in.
- fdbad56: The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, even if the agent staged them, as well as what Git ignores. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `PartlyPushed`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.
  
  `@usine/core/attempt/salvage` adds `SalvagePartlyPushed` to `AttemptSalvage`, with the salvage `ref`, the pushed `commit`, the worktree's `path`, and a `message` that names the files left out. The engine resumes the run's next attempt from its `ref` and `commit`, as it does from a `Pushed` salvage. The executors keep its worktree, provisioned machine, or Cloudflare sandbox, as they do for a `Retained` one. The run drawer shows the pushed ref and commit, the worktree's path, and the files left out.
- fdbad56: A salvage push that GitHub refuses for a file over its size limit (`GH001`) is now recorded as `Rejected`, and startup recovery doesn't push the same commit again. Before, the salvage recorded it as `Retained`, and every startup pushed the checkout again before the HTTP server listened, about a minute each time, and GitHub refused it each time (#581).
  
  `@usine/core/attempt/salvage` adds `SalvageRejected` to `AttemptSalvage`, with the worktree's `path`, the refused `commit`, and the remote's `message`. `AttemptRecovery` requires `rejected`, the attempt's recorded `SalvageRejected` or `None`, and the engine's salvage candidates fill it from the stored salvage. The executors keep the worktree, the provisioned machine, or the Cloudflare sandbox of a `Rejected` salvage as they do for a `Retained` one. Recovery records the same `Rejected` salvage while the checkout's head is the refused commit, and salvages and pushes again once the checkout changes. A recovery that can't inspect the checkout, or can't commit its changes on top of the refused commit, also records the same `Rejected` salvage instead of `Retained`, so that a later startup doesn't push the refused commit again. The run drawer shows the rejected work's path and GitHub's message.
- ae53a5a: The web UI's sidebar shows each project after a repository mark: the owner's GitHub avatar, or the repository name's first letter if the avatar doesn't load. Overview, Board, Tasks, and each configuration page have an icon, and the icons and marks line up in one column. The project breadcrumb, the board heading, the Repositories list, a repository's page, and a loop's Repositories fact show the same mark.
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
- 2f78d3a: On macOS, `usine up` reads `pmset -g` at startup and logs a warning if system sleep is on and `caffeinate` doesn't prevent it ([#603](https://github.com/basaltbytes/usine/issues/603)). A sleep drops the orchestrator's SSH connections to workers and the gateway. Run `caffeinate -s` while runs are open, or turn off sleep on AC power with `sudo pmset -c sleep 0`. The check doesn't stop startup.
- 6751a49: The web UI's tables give one column the remaining width and keep the other columns at their content's width. On the Workers list, a worker's slot cells stay on one line. In a worker's preflight table, each check's description wraps at 224px and **Detail** takes the rest of the table; in a narrower table, the time folds under the result and the message under the check. The Workers and Repositories lists fit beside the sidebar and on a phone without scrolling sideways, and a provisioned worker's Machines table wraps what each machine is for instead of scrolling sideways beside the facts rail.
- a55ab58: Each run is now a trace of its own: its root span, `RunDriver.drive`, links to the span that launched the run, such as a poll cycle or an approval request. The **Settings** configuration page shows the `tracing` block, and a reload refused for a changed `tracing` block links to it. A malformed `OTEL_RESOURCE_ATTRIBUTES` now stops `usine up` with a message that names the key, instead of crashing it. The web UI no longer sends trace headers.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.
- a5ed825: Fixes a canceled attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt could start on that worker beside the task. The attempt now keeps its run's slot, also after its execution acquired the checkout and without a restart. Each reconcile retries the stop and frees the slot once the stop succeeds. After a restart, startup still occupies a slot for each closed attempt whose stop it can't confirm.
  
  `RunEngine.cancel` moves the slot of the run's fiber to the attempt before it stops the parent task. `UnconfirmedStops` in `@usine/engine/engine` lists the attempts whose stop the engine retries, and `UnconfirmedStops.empty` lists none; `OperatorObservation` requires it. **Needs attention** shows each attempt as an `UnconfirmedStopNeed`, **\<loop\>: parent task not stopped**.
- 2f78d3a: Log lines start with an ISO 8601 timestamp in UTC, such as `[2026-10-27T02:25:13.123Z]`, instead of the local time of day ([#603](https://github.com/basaltbytes/usine/issues/603)). The local time had no date or offset and depended on the time zone that the process resolved, so after the change from summer time on 2026-10-25, a long-running orchestrator's log read one hour ahead of the machine's clock. Span events still go to the tracer.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [1514af9]
- Updated dependencies [ceba675]
- Updated dependencies [392e165]
- Updated dependencies [b3e696a]
- Updated dependencies [80f2eb6]
- Updated dependencies [80f2eb6]
- Updated dependencies [4942c44]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [4c63872]
- Updated dependencies [bf21f9c]
- Updated dependencies [b689685]
- Updated dependencies [4c63872]
- Updated dependencies [dfd0936]
- Updated dependencies [cd25ce0]
- Updated dependencies [b6f6afe]
- Updated dependencies [962517f]
- Updated dependencies [266986a]
- Updated dependencies [ac701f0]
- Updated dependencies [4c63872]
- Updated dependencies [9077f43]
- Updated dependencies [6388474]
- Updated dependencies [4c63872]
- Updated dependencies [5bc5cf5]
- Updated dependencies [afbac5c]
- Updated dependencies [f01e5f2]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [4c63872]
- Updated dependencies [770b9a4]
- Updated dependencies [7d338a2]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [40be06c]
- Updated dependencies [905bbc4]
- Updated dependencies [a55ab58]
- Updated dependencies [e5d9dcb]
- Updated dependencies [a5ed825]
- Updated dependencies [4c63872]
  - @usine/config@0.4.0
  - @usine/core@0.5.0
  - @usine/durable@0.2.0
  - @usine/engine@0.5.0
  - @usine/expression@0.4.0
  - @usine/github@0.3.0
  - @usine/orchestrator@0.4.0

## 0.3.0

### Minor Changes

- 794a1cf: `usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, to `<name>.durable<ext>` next to the runtime database copy. Restore both files together; an attempt that was running at backup time then reattaches to its parent task.
  
  `@usine/durable/backup` exports `backup` and `DurableStorageBackupError`, and `@usine/durable/live` no longer exports `durableStoragePath`.
- 56ce81e: Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.
  
  `@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".

### Patch Changes

- d866d8f: Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.
  
  Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 4970fc4: The board card menu offers **Run again** when the task's latest run succeeded or was canceled. The event of the new run links to the run it ran again.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- a386108: Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.
  
  On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
- 39a0fae: `usine up` checks its HTTP port before it opens any store or resumes any attempt. If the port is in use, it exits and shows the listening process's id when `lsof` finds it.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 40097d3: **Needs attention** reflects a run action sent from any page: while an approval or cancel is in progress, the entry's buttons are disabled and show the action, such as "Approving…", and the entry disappears when the action succeeds. An approval refused because the run already moved on shows no error on the entry.
- de1b041: `usine up` locks the instance folder with `.usine/instance.lock` until every store closes. A second `usine up` in the same folder exits with a nonzero status before it opens any store and shows the running process from `.usine/instance.pid`.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d0944ca: Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
- 046d10b: Rewrites the web UI copy in short plain words. The home page is **Overview**, with **Needs attention**, **Running**, **Stalled**, and **Recent runs**; stall reasons are short fragments such as `Waiting for a free worker slot`; glossary nouns are lowercase in sentences; and menus say **Open run** and **Cancel run**.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- 8c6a3aa: `/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.
  
  `ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.
- 1d94c11: The run page's reader keeps following a live run when you press End, Space, ArrowDown, or PageDown, or scroll down at the latest message.
- 4f6611b: The run page's reader keeps following a live run when you scroll a long tool output at the latest message.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 39f8d4b: `usine up` reloads the instance folder on `SIGHUP`, `POST /api/instance/reload`, or **Reload configuration** on the Loops page, including in setup mode, and `SIGHUP` no longer ends the process. A refused reload returns 422 `FactoryConfigError` for an invalid `usine.yaml` or 409 `RestartRequiredError` for a changed `workers` or `webhooks` block.
- 419bbd7: A reload whose new or changed agent's brain fails worker preflight returns 409 `ReloadPreflightError` and keeps the running configuration. After an accepted reload, polling starts at once.
- af28e0e: A refused `POST /api/instance/reload` returns the refusal's typed fields with `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). The Configuration section lists what the refusal names, each linked to its page.
  
  `@usine/orchestrator/operator/http` exports `RestartRequiredRefusal`, `ReloadPreflightRefusal`, `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, and the derived client decodes a refused reload into one of them.
- ba8e26f: A reload resizes, adds, and removes workers, and its response lists the changed workers. A `workers` change that needs a restart returns 409 `RestartRequiredError`, and a new worker or slot that fails preflight returns 409 `ReloadPreflightError`.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- e5d9483: Rewords the `--allow-volatile-instance` help and the TSDoc for `VolatileInstanceDirectoryError` and `volatileRoot`.
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
- 40194a0: The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.
  
  `AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
- 34dec09: Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.
  
  The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
- 1480ced: The tasks list appends the last run's time to the status, such as `Done · 28m ago`, and removes the Last run column. Elapsed time and cost show the figure alone, with a muted `*` and a tooltip when the real figure is higher, and the figure columns take only the width they need.
- af49fc2: The tasks list counts a stalled task as in flight only while an open run, a question or blocker, a used-up cycle budget, or an unresolved failure stalls one of its loops. Other stalled tasks sort with finished tasks by when their last run closed and keep the stall reason as their status, and the heading counts a task as needing attention only while a failed run or a suppression waits on the operator.
- f060b57: The tasks list shows only tasks with at least one run, finished ones included, and removes the Done toggle and `?done=1`. Each row shows the status, the loops that ran, the run count, the last run, the pull request, and the task's time, tokens, and cost; tasks in flight come first by when their run opened, then the rest by when their last run closed.
- 1a61d7e: The tasks list keeps each task title on one line in the width the other columns leave, with at least 416px for the title. Past that, Status and Last run wrap and Runs truncates.
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
- Updated dependencies [a3a230c]
- Updated dependencies [d866d8f]
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [f060b57]
- Updated dependencies [0275eff]
- Updated dependencies [a386108]
- Updated dependencies [efdcf43]
- Updated dependencies [af28e0e]
- Updated dependencies [6672585]
- Updated dependencies [9464a41]
- Updated dependencies [9739f3a]
- Updated dependencies [425e240]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [56ce81e]
- Updated dependencies [7a6d96f]
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
- Updated dependencies [66f6b0b]
- Updated dependencies [eedf20c]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [291d428]
- Updated dependencies [3ed742f]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [8a0bcc1]
- Updated dependencies [81c048b]
- Updated dependencies [af28e0e]
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
- Updated dependencies [d0944ca]
- Updated dependencies [562ba5f]
- Updated dependencies [0dac1bd]
- Updated dependencies [72d0fae]
- Updated dependencies [8c6a3aa]
- Updated dependencies [99164fa]
- Updated dependencies [3f13b80]
- Updated dependencies [b601259]
- Updated dependencies [3ed742f]
- Updated dependencies [3088f0e]
- Updated dependencies [6d70b40]
- Updated dependencies [2729e91]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [39f8d4b]
- Updated dependencies [419bbd7]
- Updated dependencies [af28e0e]
- Updated dependencies [425e240]
- Updated dependencies [ba8e26f]
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
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [f060b57]
- Updated dependencies [8f43ed7]
- Updated dependencies [6764fa7]
- Updated dependencies [ec5c4d4]
- Updated dependencies [b99cdc8]
- Updated dependencies [cef956c]
- Updated dependencies [b99cdc8]
- Updated dependencies [466e711]
- Updated dependencies [1877119]
- Updated dependencies [ff148e0]
- Updated dependencies [40194a0]
- Updated dependencies [7853f53]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [ba8e26f]
- Updated dependencies [761099a]
- Updated dependencies [34dec09]
- Updated dependencies [f060b57]
- Updated dependencies [dda5892]
- Updated dependencies [d933ab6]
- Updated dependencies [32651fd]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
- Updated dependencies [d98bef0]
- Updated dependencies [8665053]
  - @usine/config@0.3.0
  - @usine/orchestrator@0.3.0
  - @usine/core@0.4.0
  - @usine/durable@0.1.0
  - @usine/engine@0.4.0
  - @usine/expression@0.3.0
  - @usine/github@0.2.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/orchestrator@0.2.1
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 8b6718d: Reworks the run conversation with expandable tool activity, live session status, transcript filters, and scrolling that keeps your position, and moves task, event, and attempt details to separate tabs.
- 388e59d: Adds `usine export-run <runId>`, which saves a run's detail, attempts, and transcripts to a new JSON file (set the path with `--output <path>`). Adds `RunReader.evidence(runId)` and the read-only `runReaderLayer(instanceDirectory)`.
- 83edd04: Adds `usine backup <path>`, which copies the runtime database, including committed WAL data, while the orchestrator runs, and never overwrites an existing file.
- aeb587f: Groups adjacent completed tools into expandable summaries and shows the active command or file with its elapsed time. File edits show their patch first.
- ef9fd20: Shows new conversation updates while you read earlier activity, and adds jumps to the latest message and to errors.

### Patch Changes

- ffc26c9: Completed tool groups show compact action summaries with file names and recognized test or build commands.
- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- c7c8a79: Expanded run tools use flat disclosure rows; code, terminal output, and diffs keep separate panels with copy controls.
- 5c47dc2: On SIGINT or SIGTERM, the orchestrator drains admitted attempts and defers queued work and retries until restart; a second signal forces a stop.
- f4f5938: Failed commands stay in their activity group, which shows an error count, and error navigation opens collapsed groups to show the failure.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- 28ec315: Supports Codex CLI 0.153.4 and stops Codex child processes, including leftover background commands, before their sessions complete.
- 6b53a10: Simplifies run tool activity with indented groups and fewer separators, and file reads show a line range instead of offset and limit fields.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- 2cfd65b: Serves the web app for direct requests to client-side routes, and still returns 404 for unknown API routes and missing static files.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- 580a873: Each run conversation remembers its filter, open disclosures, and reading position across drawer closes and page refreshes.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [f42d393]
- Updated dependencies [333eacd]
- Updated dependencies [485f244]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [dd81b60]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/orchestrator@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.

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
- Updated dependencies [05937b8]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/orchestrator@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0
