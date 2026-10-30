# @usine/executor

## 0.5.1

### Patch Changes

- 1f12974: Apply webhook mode and URL changes and add Cloudflare workers without restarting the orchestrator. New Cloudflare workers resolve credentials and register a client before preflight; existing clients remain unchanged. A refused addition of a never-accepted worker releases its client, so a corrected revision can add the worker; an accepted worker keeps its client. Document why tracing and existing worker connection fields require a restart.

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- a22dc8e: Create provisioned machines after persisting their attempt, with the attempt label present in the creation request. Retry provider failures within the same attempt and release its machine on cancellation. `WorkerMachines.create` now requires the attempt ID; the separate `assign` operation is removed.
  
  Resume worker reservations when creation backoff expires, even if the attempt that started the pause was canceled.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.

### Patch Changes

- 8cb790a: Classify Boat plan limits, including paid-plan machine sizes, as quota refusals. Keep temporary API rate limits separate and preserve the provider message.
- a7692ae: Upgrade the Codex protocol baseline and worker images to 0.164.0, which includes updated TLS certificate roots. Preflight rejects 0.153.4 and accepts 0.159.0 through 0.159.3 for one release while existing worker images upgrade. The gateway model-provider configuration remains compatible. Claude Code stays at 2.1.308.
- 129d669: Start with healthy workers when another worker fails preflight. Exclude failed workers from scheduling, show their messages in Needs attention, and retry with backoff until they recover. Worker preflight includes address and credential initialization. Startup still fails if every worker fails, and live reload still refuses revisions whose preflight fails.
- 9ea42f2: Confirm parent stops before releasing reattached checkouts, including read-permission checkouts. Save each checkout's base commit so recovery removes clean checkouts without creating salvage branches, preserves committed work, and harvests comments with a fresh credential when a later stop succeeds.
  
  Keep a Cloudflare sandbox when its reattachment closes before launch and the parent stop fails. Revoke its credentials while preserving the checkout for recovery.
- 06a10bf: Disable Codex plugin and app sync, startup update checks, and analytics in child and preflight commands. Disable Claude Code's claude.ai connectors and nonessential traffic in the attempt environment on every worker kind.
- 52c76fa: Warn at SSH worker preflight when concurrent container memory limits exceed host memory minus the 1 GiB reserve. Set each container's swap limit equal to its memory limit to prevent attempts from swapping the host.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 56e79a7: Settle attempts after confirmed cancellation so a task that completes or fails while its relay fails doesn't trigger repeated cancellation on restart. Preserve terminal delivery state and skip settlement during worker drains.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.
- a22dc8e: Sweep a removed provisioned worker's machines before discarding its provider token. Warn at startup about machines for the instance whose worker is no longer configured, and use fresh credentials when a worker is added again.
  
  Preserve machines with unrecovered checkouts when their worker is removed and restored. Retain their recovery metadata without retaining the removed worker's credentials.
- 7247fc9: Share a persistent Turborepo cache between attempt containers alongside the pnpm store. Derive each container's CPU limit from all host CPUs divided by `max_concurrent_attempts`, and pin Node.js 22 for the attempt image and new worker machines.
- 8e49188: Add `githubBotLogin(kind, appLogin)` to share the GitHub writer mapping between the scheduler and run reader. Local, SSH, and Cloudflare workers use the supplied App login; exe.dev workers use the integration bot declared in the exe.dev adapter.
- Updated dependencies [d1fd769]
- Updated dependencies [a7692ae]
- Updated dependencies [6541e90]
- Updated dependencies [3fa96e0]
- Updated dependencies [c3ace3b]
- Updated dependencies [6d7f66f]
- Updated dependencies [93bbe77]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [a7f5a57]
- Updated dependencies [06a10bf]
- Updated dependencies [56d4c04]
- Updated dependencies [9af38cb]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [56e79a7]
- Updated dependencies [52c76fa]
- Updated dependencies [98eb9cd]
- Updated dependencies [2ca5ae8]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0
  - @usine/agents@0.6.0
  - @usine/cloudflare@0.1.1
  - @usine/durable@0.2.1
  - @usine/gateway@0.2.1

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
- 80f2eb6: **Discard leftovers** removes the Codex homes of the discarded attempts from an SSH worker that `usine.yaml` no longer declares. `StepExecutor` has a new required member, `discard(worker, attempts)`, which `RunEngine.discardLeftovers` runs after it stops tracking the attempts, and which never fails. The checkouts stay for the operator to remove.
  
  The SSH executor records how to reach each long-lived worker's machine when it adds the worker, in the new `SshExecutorOptions.workerRecordsDirectory`: its destination, port, identity file, and root, without secrets. `sshWorkerRecordsFor(directory)` from `@usine/executor/ssh` returns `discard`, which reads that record and removes `<root>/workers/<name>/codex/<attempt>` for each attempt over SSH. Without a record, or if the machine can't be reached, it logs that and removes nothing. The orchestrator records SSH workers in `.usine/ssh-workers/` in the instance directory and passes that `discard` to `StepExecutor` with every executor kind, so a discard still works after `usine.yaml` replaces the SSH workers with workers of another kind.
- 80f2eb6: An SSH worker no longer keeps the Codex home of an attempt that a crash ended. `Executor` has a new required member, `sweep`, which removes the files on the workers that no attempt holds or can use, and never fails. `StepExecutor.sweep` in the orchestrator's scheduler runs it before the sweep of provisioned machines, after startup recovery and at each reconcile.
  
  The SSH executor's sweep lists `<root>/workers/<name>/codex/` on each worker with its own machine and removes each Codex home whose attempt has no checkout there and that no attempt in this process holds. An attempt holds its Codex home from before the executor writes it until cleanup removes it, so a running attempt keeps its home, and so does a checkout that startup keeps for a reattachment. The local, exe.dev, and Cloudflare executors remove nothing.
- 9be864d: Two instance folders that share a GitHub App and an SSH worker machine no longer remove each other's attempt containers at startup.
  
  - `usine up` reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start. A file that doesn't contain a UUID stops `usine up` with status 1 instead of being replaced, because with a new ID usine no longer removes the containers it left before.
  - Each attempt container gets the label `dev.usine.instance-id=<instance ID>` beside `dev.usine.instance=github-app-<App ID>`, and a process removes only the containers that have both its labels. A container that an earlier version left after a crash has no ID label, so no process removes it; remove such containers once with `docker rm`.
  - `@usine/core/instance` adds `InstanceId`. `SshExecutorOptions` requires `instanceId`, and `runtimeLayer` and `workerEngineLayer` in `@usine/orchestrator` take it after the instance directory.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). `WorkerCredential.value` still keeps the `Redacted` token that the `CredentialProvider` issued, so releasing an attempt's checkout wipes that token, and `Redacted.value` on it throws. Effect 4.0's `Schema.Redacted` would store a copy, which left the issued token readable after the release.
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
- 9be864d: The attempt image, `ATTEMPT_IMAGE` in `@usine/executor/ssh`, runs Node.js 24, the major version that `infra/hetzner/cloud-init.yaml` installs on the worker machine; it ran Node.js 22. `NODE_MAJOR` in `infra/worker-image/Dockerfile` now sets both, and `infra/hetzner/render-cloud-init.sh` writes it into the cloud-init user data that `create-worker.sh`, `snapshot.sh`, and `gateway.sh worker-user-data` send. The image keeps its tag, so workers get Node.js 24 at their next preflight.
- d819599: Attempts commit as the GitHub App's bot account on every worker kind. Before, a local worker's commits took the identity in the operator's global git config, unless the agent passed one itself.
  
  `@usine/core/worker` adds `BotAccount`, a bot's `BotLogin` and `BotUserId`, with its ID-based noreply address in `noreplyEmail`. `GitHubApp.botAccount()` returns the App's bot account, read from `GET /users/<slug>[bot]` once per App slug; the bot's user ID differs from the App ID.
  
  `CheckoutRequest` requires `commitAuthor`. The local, SSH, and exe.dev executors set it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, which git prefers to `user.name` and `user.email` in any config. The values aren't secret, so remote workers export them in the command line and the machine's sshd needs no `AcceptEnv` change.
  
  The scheduler reads the bot account for each attempt and sets both `commitAuthor` and, on local and SSH workers, `botLogin` from it. If the account can't be read, the attempt fails before preparation: with an infrastructure failure, which is retried, or without a retry if GitHub refused, for example because the App has no installation.
- 1514af9: On a provisioned worker, the Claude login lock covers one machine instead of the whole worker ([#591](https://github.com/basaltbytes/usine/issues/591)). Each machine has its own login, so a Claude child or preflight check on one machine no longer waits for a Claude start on another. A worker's long-lived machine keeps one lock for all its attempts.
  
  `ClaudeLoginLock.withLock(worker, machine)` takes the provider's `MachineId` of a provisioned machine, or `None` for the worker's shared login. `ChildRequest` and `AttemptRequest` require `machine`, which the executor sets from the attempt's machine. `AttemptRequest.machine` isn't stored; each `execute` call supplies it.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
- 4ef6777: Fixes the salvage of an attempt whose container on an SSH worker stopped before the attempt ended, for example because the kernel killed it for memory or a test signaled its init. The salvage ran `docker exec` in the stopped container, failed, and kept the checkout without pushing its work. The release now starts the container again with `docker start`, salvages in it, and then removes it. A warning logs the container's status, exit code, and whether it was killed for memory.
- afbac5c: A salvage git command that doesn't finish within the 10-minute command timeout no longer crashes the release of a failed attempt's checkout. Before, the salvage read the message of the timeout's cause, which has none, and threw "Cannot read properties of undefined (reading 'trim')". The run then failed with "Step executor defect; operator intervention required" instead of the attempt's own failure, and the checkout and its provisioned machine stayed on the worker without a recorded salvage (#602). Now the run fails with the attempt's own failure, and the salvage records `Retained` with the worktree's path, so the checkout stays on the worker as it does after any other failed git command.
  
  A worker command that exceeds the timeout now fails with the message `<command> didn't finish within 10 minutes`, instead of `Can't run <command>`, which also named a command that couldn't start.
  
  `@usine/durable/testing` adds `StubChild.crash`, which ends a stub child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails with a `stream` `SessionOperationError`.
- f01e5f2: Salvage commits and salvage rebases are authored and committed by the attempt's `commitAuthor`, the GitHub App's bot account, on every worker kind. Before, they used `usine <usine@basaltbytes.dev>`, which no GitHub account owns. The executor's git commands on a checkout now set the same `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables as the attempt's children.
  
  `Executor.recover` takes a third argument, `commitAuthor`: an effect that returns the salvage commit's author. It runs only before a salvage, so removing the checkout of a succeeded or `read` attempt doesn't read it, and its failure leaves the checkout for a later reconciliation. The orchestrator passes the App's bot account.
- fdbad56: The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, even if the agent staged them, as well as what Git ignores. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `PartlyPushed`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.
  
  `@usine/core/attempt/salvage` adds `SalvagePartlyPushed` to `AttemptSalvage`, with the salvage `ref`, the pushed `commit`, the worktree's `path`, and a `message` that names the files left out. The engine resumes the run's next attempt from its `ref` and `commit`, as it does from a `Pushed` salvage. The executors keep its worktree, provisioned machine, or Cloudflare sandbox, as they do for a `Retained` one. The run drawer shows the pushed ref and commit, the worktree's path, and the files left out.
- fdbad56: A salvage push that GitHub refuses for a file over its size limit (`GH001`) is now recorded as `Rejected`, and startup recovery doesn't push the same commit again. Before, the salvage recorded it as `Retained`, and every startup pushed the checkout again before the HTTP server listened, about a minute each time, and GitHub refused it each time (#581).
  
  `@usine/core/attempt/salvage` adds `SalvageRejected` to `AttemptSalvage`, with the worktree's `path`, the refused `commit`, and the remote's `message`. `AttemptRecovery` requires `rejected`, the attempt's recorded `SalvageRejected` or `None`, and the engine's salvage candidates fill it from the stored salvage. The executors keep the worktree, the provisioned machine, or the Cloudflare sandbox of a `Rejected` salvage as they do for a `Retained` one. Recovery records the same `Rejected` salvage while the checkout's head is the refused commit, and salvages and pushes again once the checkout changes. A recovery that can't inspect the checkout, or can't commit its changes on top of the refused commit, also records the same `Rejected` salvage instead of `Retained`, so that a later startup doesn't push the refused commit again. The run drawer shows the rejected work's path and GitHub's message.
- 9827419: Share a persistent pnpm store volume across attempt containers on each SSH worker machine. Initialize volume ownership with the image's usine UID before use, refuse a store owned by another UID, and log disk usage at preflight.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [2f78d3a]
- Updated dependencies [1514af9]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [113d150]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [2fad241]
- Updated dependencies [8425053]
- Updated dependencies [2fad241]
- Updated dependencies [4942c44]
- Updated dependencies [d82c6cd]
- Updated dependencies [266986a]
- Updated dependencies [4c63872]
- Updated dependencies [9077f43]
- Updated dependencies [6388474]
- Updated dependencies [afbac5c]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/agents@0.5.0
  - @usine/core@0.5.0
  - @usine/durable@0.2.0
  - @usine/gateway@0.2.0
  - @usine/cloudflare@0.1.0

## 0.3.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- 0799f4f: The exe.dev worker runs its Pi parent in the orchestrator as a durable task and its Claude Code and Codex children on the VM over SSH, so an exe.dev attempt reattaches after an orchestrator restart instead of failing. A Pi brain is unavailable on exe.dev.
  
  `@usine/executor/exe-dev` requires an `AttemptRuntime` and no longer launches the run host: it removes `ExeDevExecutorOptions.runHost`, `RunHostCommand`, and the `run-host` worker capability, and `ExeDevExecutorOptions.ssh` takes an `SshCommand` from `@usine/agents/child-host`. Preflight runs the `@usine/agents/preflight` checks on the VM over SSH, and the `@usine/orchestrator/exe-dev` `layer` requires an `AttemptRuntime`.
- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- eedf20c: Behind a gateway, Codex, and Claude Code if the gateway has no Anthropic credential, use the operator's login on the worker machine and reach their provider through the gateway's forward proxy (ADR 0027, amendment of 2026-10-15).
  
  Preflight on an SSH worker behind a gateway accepts these brains if the machine reaches each login host through the forward proxy: `api.anthropic.com` and `platform.claude.com` for Claude Code, `chatgpt.com` and `auth.openai.com` for Codex. A refused host fails preflight with a `gateway` capability error that names the host to add to the egress allowlist, and `SshExecutorOptions.harnessReadiness` replaces only the login and binary checks.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 01306e6: `harvestFacts` and `harvestPostedComments` leave out a comment or review that could belong to another attempt: one posted while another attempt of the same agent was open on the item, one posted after the attempt's window ended, or one created before the checkout was prepared and edited since. The harvest summary counts these as `ambiguous`, `outside`, and `edited`.
  
  `@usine/core/attempt` exports `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, and `AttemptWindows`. The harvest functions take `windows`, an `AttemptWindowsRead`, and `harvestFacts` fails with a `HarvestError` at the new `windows` stage if the read fails; `AttemptChannel.Sink` and `RecoverySink` add `windows`, which the engine reads with `RunStore.attemptWindows`.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- b601259: After an orchestrator restart, a reattached attempt's runaway guard resumes from its recorded totals instead of starting over, and sends each 80% warning at most once per attempt. If the guard can't read the transcript or unsupervised time, it cancels the parent task, records the salvage, and fails the attempt with an `InfraFailure`.
  
  Adds `AttemptChannel.Sink.transcript` to `@usine/core`, which the engine reads from the run tables, and `AttemptRuntime.recordUnsupervised`, `AttemptRuntime.unsupervised`, `AttemptRuntime.attached`, and `StubStorage.unsupervised` to `@usine/durable`. A wall-clock guard records its unsupervised time every 30 seconds, so a crash loses at most 30 seconds, and the wall clock starts once the launch registers the attempt's session.
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
- 7853f53: The SSH layer adds `SshWorkers`: `addWorker` and `removeWorker` change workers at runtime, opening a gateway's admin forward with its first worker and closing it with its last.

### Patch Changes

- b36ffc7: Canceling an attempt during preparation or process startup releases its resources and prevents the launch.
- ca2e7a5: Adds `CredentialUnavailableError.reason`: `refused` (final) or `unreachable` (retryable).
- b928d0d: Adds TSDoc to every field of the `@usine/executor` schema classes and worker options, and to `CredentialProvider.issue` and `Executor.kind`.
- 425e240: A gateway admin request that gets no answer through an open forward fails with `the admin API through <gateway> has not answered since <time>: no answer (TransportError)`, and the retry warning includes `unansweredSince`. The next answered request clears the time.
- 23e8f15: Startup reconciliation lists local worker checkouts once instead of checking each attempt, caches a listing failure until restart without blocking other workers, and still records salvage before it removes a checkout.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 2729e91: Startup reconciles the leftover checkout of a succeeded attempt: both executors remove it without salvage or a credential. `RunStore.salvageCandidates` lists every attempt with a `succeeded` flag on `AttemptRecovery`, and the exe.dev executor lists each worker's leftover checkouts once per start.
- 81c048b: `Executor.recover` stops a live parent task and reconciles the checkout of an open attempt that no run reattaches, instead of leaving it. If the parent task can't be confirmed stopped, `recover` and `cancel` fail with a `cancel` `ExecutorOperationError` and leave the checkout in place.
- c604a43: At startup, the engine records the comments that an open attempt posted on its run's item if its parent task failed before the orchestrator stopped. `@usine/core/attempt/salvage` exports `RecoverySink`, which `Executor.recover` and `StepExecutor.recover` take instead of the salvage callback, with a `comments` recorder.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- e5d9483: Rewords TSDoc for `Executor.isLive` and `Executor.outcome`.
- ff148e0: Retries a failed exe.dev credential grant renewal every minute until it succeeds, and sizes the grant window independently of `max_attempt_minutes`. The run drawer shows the last salvage failure of a retained worktree, which every startup retries; the recorded failure includes git's stderr and names a stalled push instead of a bare `TimeoutError`.
- 6714868: Repeated cancellation keeps an attempt's typed failure, and concurrent cancels wait for checkout and credential cleanup. After a run ends, operator input is rejected.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- d3942c0: An attempt that starts while its worker is silent gets `WorkerUnresponsive` at once, not at the next unanswered probe.
- fcd3671: An attempt that joins a silent worker's liveness watch gets `WorkerUnresponsive` at the next unanswered probe, and gets `WorkerResponsive` only after a `WorkerUnresponsive`.
- 425e240: The SSH and exe.dev executors probe each worker once a minute while any attempt runs on it, instead of once a minute per attempt. The notices go to the transcript of every attempt on the worker.
- d98bef0: Worker preflight checks the machine's memory against `max_concurrent_attempts`, and `Executor.preflight` takes `maxConcurrentAttempts` as a third argument. Preflight fails with the new `memory` capability below 1.5 GiB per concurrent attempt, or with no swap and more than one concurrent attempt, and warns below 3 GiB per concurrent attempt.
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [6672585]
- Updated dependencies [425e240]
- Updated dependencies [8292038]
- Updated dependencies [acef6eb]
- Updated dependencies [a3a230c]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [7a6d96f]
- Updated dependencies [759db71]
- Updated dependencies [caf041d]
- Updated dependencies [8292038]
- Updated dependencies [0799f4f]
- Updated dependencies [14c2d3c]
- Updated dependencies [d3942c0]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [7db1cae]
- Updated dependencies [a3a230c]
- Updated dependencies [a3a230c]
- Updated dependencies [a3a230c]
- Updated dependencies [425e240]
- Updated dependencies [66f6b0b]
- Updated dependencies [6eb66ff]
- Updated dependencies [be90a08]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5519ca3]
- Updated dependencies [9b78093]
- Updated dependencies [458033e]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [7078fa8]
- Updated dependencies [4d4c6bd]
- Updated dependencies [5870baf]
- Updated dependencies [fba2a72]
- Updated dependencies [71c8b48]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [07a4145]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [0799f4f]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [6764fa7]
- Updated dependencies [466e711]
- Updated dependencies [455652c]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [761099a]
- Updated dependencies [d933ab6]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
  - @usine/core@0.4.0
  - @usine/agents@0.4.0
  - @usine/durable@0.1.0
  - @usine/gateway@0.1.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 410607d: Ignores non-repository entries when pruning local worker bare caches, and keeps Turborepo's worktree cache out of repository cache storage.
- 7dc019e: Logs the process console to stderr and tolerates stray Effect diagnostics on the attempt channel.
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
- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- fb24c80: Adds Codex app-server and API-key-only Pi children to the subagents extension (protocol v3).
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.

### Patch Changes

- 7bd5cdb: Logs and attempt failures include redacted run-host frame diagnostics, without frame content or credentials.
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
