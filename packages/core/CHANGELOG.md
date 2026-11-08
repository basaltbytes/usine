# @usine/core

## 0.7.0

### Minor Changes

- e0cedc8: Classify pending CI deadlines as infrastructure failures and report running jobs with elapsed times and previous successful durations when available. Bound diagnostic reads so a stalled request cannot prevent timeout settlement.
- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 1c981c9: Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.
  
  Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.
- 7e5bb5b: Record accepted CI fixes as neutral handoffs with links to the continuing run. Keep source runs out of failure statistics and Needs attention when a fix run continues the work. Task lists and board cards show the fix run's status. Unavailable fix loops, refused events, exhausted budgets, and CI timeouts still require attention.
  
  Preserve pending completion actions across CI fix runs and apply them with the final successful head’s actions.
- 4f87593: Add project roles and revisioned role bindings, enforce API permissions, and filter project data by access. Add token permission ceilings and controls for bindings and token scopes. Attribute local API writes and configuration CLI revisions to local admin. Existing members retain instance admin access through a one-time migration.
  
  Authorize run actions and cycle-budget resets against the repository’s current project, including after a repository moves. Refresh the configuration revision after writes and stale-revision failures so later writes use the current revision.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 7c58461: Add opt-in machine reuse for Boat and Hetzner SSH workers with `provisioner.reuse: { attempts: 5, max_age: 2h }`. Reuse requires Docker, successful cleanup, gateway attachment revocation, and preflight before each assignment. Machines retire at the attempt or age limit and when their worker connection is removed.
  
  Show machine assignment counts and age on the overview and worker page, and persist daily machine-start counts for statistics.
- 1948b10: Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
- 9cf0b5e: Share child continuation policy across Claude Code, Codex, Pi, and durable restart. Native resume reopens a conversation without sending input. Working children receive one continuation and unread guidance; supervised children wait. Persist a limit of three continuation turns per ten minutes and close interrupted tool calls with errors.
  
  Assign Claude session UUIDs before the first prompt and give operator messages stable UUIDs. Acknowledge guidance by native message IDs so identical messages have separate delivery receipts, and use Claude's pending-send count only for results without UUID receipts. Send the task to a retained Claude process that never acknowledged its prompt. A restored child keeps its unread messages until its call ends. Preserve unread Codex guidance across turn boundaries and active-turn reattachment. Failed resume returns interrupted without spending another child-session slot, and a replacement clears the previous child's infrastructure failure.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.
- 81330c9: Show whole pull request and recorded attempt changes on task pages with collapsed file diffs, change counts, and CI and review state. Add a project-scoped files API and commit-based caching, with explicit reporting for missing and truncated GitHub patches.
  
  Keep recorded attempt changes available after failed or canceled CI waits, including when a later retry succeeds.
  
  Backfill older comparisons only when their producing attempt is identifiable, and let each attempt's completion replace an existing backfilled result.
  
  Classify generated files by path to avoid marking hand-written files whose patches mention generated-file markers.
- d0900a3: Publish web change notices after committed writes. Idle connections send heartbeats without rebuilding overview, desk, or configuration projections. Filter live notices and bounded replay by project access.
  
  Refresh open statistics at UTC midnight as rolling windows advance.

### Patch Changes

- 6a1cf79: Run SSH attempt containers with memory-backed `/dev/shm` and `/tmp` storage. Configure their capacities per worker with `container.shm_size_mib` and `container.tmpfs_size_mib`; each defaults to 2048 MiB and is capped at the container memory limit.
- 01467e3: Reduce overview responses with compact board run summaries and a bounded recent run list. Preserve all board cards, task totals, and Needs attention entries. Load complete board run history when its menu opens.
  
  Read polling metadata without prompts, results, or comments. Select current board runs with SQL windows and aggregate historical counts, timing, and loop states in storage.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- 82b55aa: Show a dismissed cycle-budget entry again when a later event is blocked on the same item, and display the most recently blocked loop. Preserve dismissals during repeated polling of the same blocked events and keep the ask's reset identity unchanged.
  
  Add `CycleBudgetBlock`, `CycleBudgetAsk.blocks`, `recordBlock`, and `blockedLoop` to record the latest refused event per loop. Older asks decode with an empty block list.
- 9786f67: An attempt whose CI pull request can't be verified now fails with the reason in its message. A handed-off head that differs from the checkout, a pull request that origin doesn't have or that comes from another repository, and a branch that isn't at the pushed head are agent failures. A GitHub read that still fails is a retryable infrastructure failure.
  
  The pull request read during harvesting retries twice, on the same schedule as the GitHub polling reads, and logs the branch's commit on origin against the pull request's head on GitHub.
  
  A loop with a CI policy whose agent ends without a handoff now verifies the open pull request of the checkout's branch on origin and uses branches on origin at HEAD for detached checkouts. When only pull request refs match, it uses GitHub's commit-to-pull-request index. An unchanged detached checkout from a branch or tag revision fails as an agent failure instead of waiting on an unrelated pull request.
  
  For a detached fixed-commit checkout, indexed pull requests from a fork now fail with `RepositoryMismatch`. When an origin branch matches the detached HEAD but has no open pull request, verification fails with `PullRequestNotFound` even if a matching pull request ref is also on origin. The commit index is queried only when no origin branch matches.
  
  A plain success whose GitHub or git verification read fails now records an `InfraFailure` instead of an `AgentFailure`. This includes persistent authorization failures such as HTTP 403, so the attempt can run up to three times. A local branch pushed under a different remote name fails with `BranchNotAtHead`; an explicit handoff verifies the pull request's source branch independently of the local branch name.
- d740598: Forward parent steers to the single live child and record the receiving child in delivery receipts. Require a separate parent turn when a steer cannot be delivered, including after a restart. Withdraw unread guidance on interruption and keep the parent paused until new guidance or release. Show forwarding, parent delivery, and unread steers in the run transcript.
- bb96f16: Save a Claude child's zero usage for its replacement process before the replacement launches, so an orchestrator stop during that launch keeps the earlier process's tokens and cost in the session total. Wait for the worker to acknowledge pending input before the detach checkpoint, so an answered hook is not replayed after the restart. Save active and uncheckpointed assistant message IDs with the process usage, so a reattached process doesn't count their replay again.
- 6316707: Connect Claude and ChatGPT from setup, Settings, or `usine login`, with subscription and API-key options. Save completed logins on the configured gateway or in local harness storage, show credential metadata, and replace or disconnect credentials without manually transferring files.
- 5796627: Verify explicit CI handoffs against the pushed origin branch when GitHub's pull request head is stale. Keep CI pending until the PR head catches up, and classify unverified handoffs as retryable infrastructure failures.
- 4d60236: Record kernel task names and host PIDs for processes killed by attempt container memory limits. Show available process details and missing-detail counts below attempt outcomes, and report memory kills and repeated kills beside first-time-right statistics. Older records retain their kill counts with empty process lists.
  
  Serialize the repository check and build tasks to fit the worker memory limit, matching the existing test command. Document gate memory requirements and host kernel-log permissions.
- 9476883: Pass the rendered loop task unchanged to each child, with parent-written text as supplemental context. Record the exact child prompt in the transcript and display it in the run page's attempt details.
- 10154eb: Keep held children that finished their turn idle after an orchestrator restart. Release returns the saved report to the parent; operator guidance starts another turn. Include the completed report in SessionIdle events for recovery.
- 9e30c8c: Add the Node `child-host/owner` API and use one process owner for Claude Code and Codex. Remote children reattach across SSH loss and orderly restart, with a two-minute orchestrator lease and bounded exit diagnostics. Local children terminate their process groups when the orchestrator pipe closes, including after a crash.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- d0900a3: Refresh open task details and history when newly linked items change task membership or cycle-budget asks change attention state.
- 0e34ec1: Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.

## 0.6.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- 6d7f66f: Require a member session or instance token for operator API requests, including requests from loopback. Add GitHub browser and device sign-in, one-time setup links, local admin tokens, member management, token revocation, and browser CSRF checks. Attribute operator actions and configuration revisions to the signed-in member. Convert stored GitHub ask approvals to the UI channel while preserving their approvers.
  
  Existing instances must configure GitHub App user authorization to use GitHub sign-in. Run `usine sign-in-link` on the instance machine for access before those settings are configured.
  
  Keep the version health endpoint public so existing upgrade helpers can verify the first release with member authentication.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.
- f54b3bd: Record the provider login in `PoolRateLimitsUpdated.login`. Codex records the ChatGPT login email and refreshes it after an account change. Older snapshots and gateway-backed sessions remain readable without a login.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- 4f37e20: Add release version and upgrade outcome schemas, plus `upgrade_channel` and `upgrade_mode` settings. The defaults select the `latest` channel and propose available upgrades.

### Patch Changes

- 6541e90: Document the public core API, including record fields, channel messages, and operation contracts. Replace relative ADR links in core and expression API comments with portable references.
- 56d4c04: Wait for all usine dependencies to resolve on npm before offering or starting a server upgrade. Retry registry propagation errors during installation, and record the rollback failure stage so automatic mode can retry install failures while continuing to skip health-check failures.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.

## 0.5.0

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
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). `CycleBudgetAsk`, `LoopCycleCount`, `RunAgain`, and `ApprovalSource` still reject a key they don't declare, whatever `onExcessProperty` the decoder passes. Effect 4.0 no longer reads the `parseOptions` annotation that made them strict.
- 6388474: Record the time and configured operator of each failure resolution. Include resolutions in the failure-to-answer median, with separate retry and resolution figures, and refresh cached statistics after resolution. Preserve the first resolution across repeated requests and later retries.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- d819599: Attempts commit as the GitHub App's bot account on every worker kind. Before, a local worker's commits took the identity in the operator's global git config, unless the agent passed one itself.
  
  `@usine/core/worker` adds `BotAccount`, a bot's `BotLogin` and `BotUserId`, with its ID-based noreply address in `noreplyEmail`. `GitHubApp.botAccount()` returns the App's bot account, read from `GET /users/<slug>[bot]` once per App slug; the bot's user ID differs from the App ID.
  
  `CheckoutRequest` requires `commitAuthor`. The local, SSH, and exe.dev executors set it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, which git prefers to `user.name` and `user.email` in any config. The values aren't secret, so remote workers export them in the command line and the machine's sshd needs no `AcceptEnv` change.
  
  The scheduler reads the bot account for each attempt and sets both `commitAuthor` and, on local and SSH workers, `botLogin` from it. If the account can't be read, the attempt fails before preparation: with an infrastructure failure, which is retried, or without a retry if GitHub refused, for example because the App has no installation.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
- 80f2eb6: `HarnessSession` has an optional `home`: the directory the harness saved the session in when the attempt set one in place of the harness's default. A Codex child records its `CODEX_HOME` there and in the `Codex child session saved` log, so a resume command can find a session that an attempt behind a gateway saved in its own Codex home. Older records decode `home` to `Option.none()`.
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
- fdbad56: The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, even if the agent staged them, as well as what Git ignores. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `PartlyPushed`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.
  
  `@usine/core/attempt/salvage` adds `SalvagePartlyPushed` to `AttemptSalvage`, with the salvage `ref`, the pushed `commit`, the worktree's `path`, and a `message` that names the files left out. The engine resumes the run's next attempt from its `ref` and `commit`, as it does from a `Pushed` salvage. The executors keep its worktree, provisioned machine, or Cloudflare sandbox, as they do for a `Retained` one. The run drawer shows the pushed ref and commit, the worktree's path, and the files left out.
- fdbad56: A salvage push that GitHub refuses for a file over its size limit (`GH001`) is now recorded as `Rejected`, and startup recovery doesn't push the same commit again. Before, the salvage recorded it as `Retained`, and every startup pushed the checkout again before the HTTP server listened, about a minute each time, and GitHub refused it each time (#581).
  
  `@usine/core/attempt/salvage` adds `SalvageRejected` to `AttemptSalvage`, with the worktree's `path`, the refused `commit`, and the remote's `message`. `AttemptRecovery` requires `rejected`, the attempt's recorded `SalvageRejected` or `None`, and the engine's salvage candidates fill it from the stored salvage. The executors keep the worktree, the provisioned machine, or the Cloudflare sandbox of a `Rejected` salvage as they do for a `Retained` one. Recovery records the same `Rejected` salvage while the checkout's head is the refused commit, and salvages and pushes again once the checkout changes. A recovery that can't inspect the checkout, or can't commit its changes on top of the refused commit, also records the same `Rejected` salvage instead of `Retained`, so that a later startup doesn't push the refused commit again. The run drawer shows the rejected work's path and GitHub's message.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.

## 0.4.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- 759db71: Removes the run host byte protocol from `@usine/core/attempt/channel`: `Start`, `InputFrame`, `InputFrameFromJson`, `EnvelopeFromJson`, and `OutboundEnvelopeFromJson`. `admit` violation messages refer to the outbound channel instead of the run host.
- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- a55d12d: `harvestFacts` and `harvestPostedComments` record a comment or review only if its body ends with the signature of the attempt's agent, so attempts of two agents on one item no longer record each other's comments. The harvest log counts other comments as `unsigned`.
  
  `githubSignature` moves from `@usine/agents/prompt` to `@usine/core/agent`, and `HarvestSpec` reads the RunSpec's `agent`.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- 01306e6: `harvestFacts` and `harvestPostedComments` leave out a comment or review that could belong to another attempt: one posted while another attempt of the same agent was open on the item, one posted after the attempt's window ended, or one created before the checkout was prepared and edited since. The harvest summary counts these as `ambiguous`, `outside`, and `edited`.
  
  `@usine/core/attempt` exports `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, and `AttemptWindows`. The harvest functions take `windows`, an `AttemptWindowsRead`, and `harvestFacts` fails with a `HarvestError` at the new `windows` stage if the read fails; `AttemptChannel.Sink` and `RecoverySink` add `windows`, which the engine reads with `RunStore.attemptWindows`.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- b601259: After an orchestrator restart, a reattached attempt's runaway guard resumes from its recorded totals instead of starting over, and sends each 80% warning at most once per attempt. If the guard can't read the transcript or unsupervised time, it cancels the parent task, records the salvage, and fails the attempt with an `InfraFailure`.
  
  Adds `AttemptChannel.Sink.transcript` to `@usine/core`, which the engine reads from the run tables, and `AttemptRuntime.recordUnsupervised`, `AttemptRuntime.unsupervised`, `AttemptRuntime.attached`, and `StubStorage.unsupervised` to `@usine/durable`. A wall-clock guard records its unsupervised time every 30 seconds, so a crash loses at most 30 seconds, and the wall clock starts once the launch registers the attempt's session.
- 2729e91: Startup reconciles the leftover checkout of a succeeded attempt: both executors remove it without salvage or a credential. `RunStore.salvageCandidates` lists every attempt with a `succeeded` flag on `AttemptRecovery`, and the exe.dev executor lists each worker's leftover checkouts once per start.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- cba7d35: Operators can run a succeeded or canceled run again. `RunEngine.runAgain` takes a `RunAgainRequest` and records a new event for the run's item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`; it returns `Claimed` or `CycleBlocked`, and fails for a run in another state or while another run of the loop is open on the item.
  
  Adds `canRunAgain` to `RunState.operatorActions`, `RunAgain` to `@usine/core/run/again`, the `usine_run_again_events` table, `runAgain` to `RunSnapshot`, `RunSummary`, and `RunView`, `Operator.runAgain` with the new `LoopNotFoundError`, and `POST /api/runs/:runId/run-again`. The drawer and run page offer **Run again** and **Edit and run again** on succeeded and canceled runs.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
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

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- c604a43: At startup, the engine records the comments that an open attempt posted on its run's item if its parent task failed before the orchestrator stopped. `@usine/core/attempt/salvage` exports `RecoverySink`, which `Executor.recover` and `StepExecutor.recover` take instead of the salvage callback, with a `comments` recorder.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- e5d9483: Rewords TSDoc for `awaitApproval` and `supersede`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- a3a230c: `harvestFacts` runs `git ls-remote origin` to check whether a ref points at the attempt's new final commit before it asks GitHub for the commit's pull requests. An unpushed commit is recorded with no pull request and a debug log line, instead of an HTTP 422 and two warnings.

## 0.3.0

### Minor Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- bd45cf4: Collects pull request facts from GitHub using the attempt's final commit, and encodes PR and comment URLs as strings.
- e7adbd8: Derives operator actions from the run lifecycle rules.

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- a8d8df4: Adds the Drizzle-backed durable engine with approval, retry, supersede, revoke, and restart recovery; the Node adapter is `@usine/engine/local-sqlite`.
- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 57d383b: Adds GitHub App authentication, installation discovery, per-project installation coverage, local credential loading (mode 0600), and single-repository worker tokens.
- fb24c80: Adds Codex app-server and API-key-only Pi children to the subagents extension (protocol v3).
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.
- 3041f9d: Moves `Instance.Directory` and `Loop.ApprovalRequirement` to `@usine/core`; `@usine/engine` still exports `InstanceDirectory` and `ApprovalRequirement`.

### Patch Changes

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.
- bc17c21: Encodes rate-limit reset dates as ISO strings so session events round-trip through the run-host protocol.

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
