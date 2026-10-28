# @usine/orchestrator

Connects stored loop definitions to GitHub polling, the durable run engine, and the configured workers for [usine](https://github.com/basaltbytes/usine). [Operator surfaces](https://docs.usine.dev/architecture/operator-surfaces/) and [Run lifecycle](https://docs.usine.dev/architecture/run-lifecycle/) describe the behavior in depth.

The platform-free entry points are `PollingTriggers` (`/polling-triggers`), `ScheduleTriggers` (`/schedule-triggers`), `Orchestrator` (`/orchestrator`), and `Operator` with its request and response types (`/operator`). `Orchestrator.run` runs both trigger streams over the factory's `CurrentInstance`.

0.x APIs can change between minor releases. Supply `effect` at the workspace's pinned version.

## Operator

`Operator` provides run and board observation, transcript pages, label-backed board moves, approve, retry, cancel, and loop pause. It returns typed data, and consuming apps own the wording. Captured executor defects appear as `DefectFailure` with a safe message, without the original cause. `OperatorObservation` gives the same read-only projection without execution services.

`OperatorConfiguration.view(instance)` returns the instance folder as already parsed: each loop, agent, worker, registered repo with its lanes, and the settings; every quarantined loop and invalid agent with its error; each loop's pause; each worker's slots, last preflight per harness, and Attempt container limits (from `WorkerStatus`); and each repo's labels as polling last read them. A gateway's admin token appears only as its variable name.

`Operator.overview(instance)` keeps the latest polling and schedule failures visible after sibling work continues. Concurrent reads at one durable revision share a computation.

`Operator.statistics(instance, window)` and `Operator.runStatistics(instance, window)` cache their computed views in memory for up to five minutes, separately for `7d`, `30d`, and `all`. Concurrent requests for the same view and window share a computation. Each request checks the store's projection revision: run closure, retry, failure resolution, and close-time changes invalidate cached views, as do item and budget changes. Reloading the instance also invalidates them. If the revision record is missing, requests bypass the cache. Debug logs report cache hits and misses with the window.

`GET /api/statistics/runs` includes `needsAttention.failureWait`, the median time from failure to the first recorded operator answer. `retryWait` and `resolutionWait` report those answers separately. A resolution followed by a retry counts once, as a resolution. Unanswered failures and older resolutions without timestamps contribute no wait.

### Overview and board

The overview joins the latest 500 polled items into task cards in each repo's authored lanes. Same-repo issue-closing links and saved run PR results join an issue to a PR. Repos without lanes get proposals from the label catalog, including unused labels and repos without items. Items matching no source go to a read-only `Unmapped` lane; label matches beat state sources. Each card keeps every saved run on its items, oldest first.

The newest open run sets the current item; between runs, an open PR, then the latest settled PR, replaces the issue. Its labels and state pick the lane, so a task whose PR is in review stays put when the issue loses its trigger label. While the newest open run is `Running` on an open item, the card goes to the first label lane matching the item's current labels; if none matches, to the first label lane matching the labels in that run's event payload (`RunReader.events`), until the run ends; if neither matches, the item's state decides. `Operator.task` places tasks the same way, and `Operator.moveBoardItem` records the lane the card left (ADR 0024).

A card also has `pullRequest` (the open PR, else the newest merged one) and `usage` from `RunUsageReader`: ended attempt time, working attempts' starts, and tokens and dollars per billing pool over its runs' sessions. A pool's dollars are its priced sessions'; `unpriced` marks a session in a priced pool without a price yet, such as a Claude session before its first result, so the cost is a lower bound. The overview is kept until the revision or instance changes; token reports change neither, so each read re-reads working attempts' reports and re-sums cards whose runs used more.

A malformed item projection is quarantined and reported on the board and the needs-attention strip; valid items stay visible. A failed declared-label creation is a repo preflight finding and doesn't block triggers.

`Operator.moveBoardItem(instance, move)` accepts authored label-backed lanes, adds the target lane's labels, and removes only labels the authored map owns, even with a stale snapshot or truncated label connection. Proposed lanes are read-only (`BoardLaneReadOnlyError`); define [`repos[].lanes`](https://docs.usine.dev/reference/configuration/usine-yaml/) and reload to enable moves. Every attempted label write, including an uncertain or partial failure, queues an item hint: the poller fetches the snapshot, places it, and evaluates its loops at once unless GitHub requested backoff.

### Run detail

A `GitHubPushFailureView` shows a refused push in the run's attempt outcome and Needs attention. Its message includes the repository, refused ref, GitHub's diagnostic, and the single-repository installation token scope. The attempt's salvage still identifies the retained checkout.

`Operator.detail` takes distinct cold, live-tail, and earlier-page requests. A cold read keeps the newest 500 rows per attempt, with an earlier cursor per truncated attempt for paging back. A live tail returns at most 500 rows across the run and advances its cursor from the last row. Each response also has:

- the newest attempt's worker;
- `run.agentBrain`: the saved agent definition's harness, model, and effort, which Retry reuses, including any edit-and-retry amendment;
- `agentDefinitionChanged`: whether the loaded agent definition differs from the saved one (false if the agent is no longer loaded). Edit and retry takes the current loaded definition, even when the task and agent name stay the same;
- `RunDurationView`: ended attempts' time, the running one's start, and how many ended without a recorded end or transcript row;
- `RunUsageView`: each session's highest token report, summed per session, pool, and run, at the harness's price or, for a Codex session, at OpenAI's API rates for its token breakdown (`@usine/agents/openai-prices`), as an estimate on the Claude and ChatGPT plans (ADR 0013). A Codex model without rates stays unpriced, with one warning per model. Pools come from `sessionPool` (`@usine/core/agent/session`), so a Claude Code child on its gateway's API key counts in API keys at the model's rate. Ended attempts' reports are kept in memory until restart, so polling reads only the attempt in flight.

Each `AttemptView` has `start`, the last reattach time, and `workerAccess`: `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port` from `usine.yaml` (exe.dev reads as `<name>.exe.xyz`), or null if the worker is no longer declared. `detail`, like the overview, task, and desk reads, takes the loaded instance. `Operator.retry` and `Operator.editAndRetry` pass the instance's `operator` login to the next attempt.

### Task

`Operator.task(instance, repository, item)` returns the `TaskView` containing `item`, found from any member and named by its originating item (the earliest issue, else the earliest PR). It uses the board projection over the repo's 500 newest items, and `RunReader.forItems` for every saved run, outside the overview's window. It has the lane and current item; each item's state, labels, and base conflict; runs newest first; and the runs' comments and reviews, newest first per run: a succeeded attempt's `Comment` facts and a failed or canceled attempt's recorded comments, each with GitHub's post time (if recorded) and the attempt's end. An item outside the window fails with `BoardItemNotFoundError`. API: `GET /api/projects/:owner/:repository/tasks/:item`.

### GitHub changes

`Operator.githubChanges(runId)` returns `RunGitHubChangesView`: per attempt, the labels added and removed, comments, and submitted reviews on the run's item, oldest first. It reads the timeline through `GitHubItemHistory`, keeps the App's changes, and gives each to the attempt at work when GitHub recorded it, from its start second to its end (or now). An attempt that ended before end times were recorded ends at its last transcript row. All agents write as one App, so a change during two runs' overlapping attempts belongs to neither and is logged.

Board moves use the same App, so `moveBoardItem` records each move in `BoardMoves` (`@usine/engine/board-moves`) before sending labels, and doesn't send a move it can't record. A timeline label change that the move sent the same way, recorded from 1 second before to 10 seconds after the move's second, belongs to the move: it leaves the attempt's list, and the move appears as `BoardMoved` with its lanes in the attempt at work then. A move with no label recorded, such as a refused write, doesn't appear. Moves from before recording existed still read as the agent's.

One read asks GitHub once, from the earliest uncached attempt's start. Attempts are cached in memory a minute after they end, so a finished run asks GitHub nothing until a restart. Schedule runs have no item and list no attempts. API: `GET /api/runs/:runId/github-changes`; a gone item returns 404 `GitHubItemNotFoundError`.

### Cycle budgets, run again, and failure resolution

Cycle exhaustion is a `CycleBudgetNeed` in the overview and marks the card as needing attention. `Operator.resetCycleBudget` answers the exact ask, at `POST /api/cycle-budgets/reset` with `{ "askId": "…" }`; a stale or differently answered ask returns 409. Polling then restarts the repo cursor, fetches current items, and evaluates active loops before opening runs, retrying a failed refresh. Each item fetch captures its budget generation, resets supersede in-flight observations, and new events use the current loop configuration. GitHub delivery of these asks is [#36](https://github.com/basaltbytes/usine/issues/36).

Each poll cycle closes the ask of an item that is closed, merged, or gone from GitHub with the reason `ItemClosed`, without a reset, so the ask leaves the overview and the item keeps its budget. A failed run on such an item stays in `ProjectView.runs` with `canResolveFailure`, but the overview lists no `RunFailureNeed` for it, and it doesn't count toward `ProjectView.status`, the card's `needsYou`, or the run the card shows (`BoardTaskView.run`). `RunDetailView.settledItemState` gives the item's state. A waiting run on a closed item is revoked when its loop's `if:` stops matching, as with a label change. The overview lists no `ApprovalNeed` or `RunFailureNeed` for a run in a repository that `usine.yaml` no longer lists, which has no `ProjectView`.

`Operator.runAgain(instance, runId, edit)` opens a new run for a succeeded or canceled run's item state, with the edit's task and roster agent and the loaded loop's step, approval, and cycle limit, as the `operator` login. It returns `Claimed` or `CycleBlocked` with the ask, and fails with `LoopNotFoundError` if the loop isn't loaded. API: `POST /api/runs/:runId/run-again` with `{ "task": "...", "agent": "..." }`. `RunView.canRunAgain` says when it applies; `RunView.runAgain` names the original run.

`Operator.resolveFailure(instance, runId, attemptId)` clears attention for the current failed attempt, at `POST /api/runs/:runId/resolve-failure` with `{ "attemptId": "..." }`. The resolution records its time and the instance's configured operator login. The failure stays in history with retry available; Needs attention, project status, and board attention reflect it, and a later failure asks again. For a question (`QuestionFailureView`) or blocker (`BlockedFailureView`), it lifts the loop's suppression of the item and gives the newest queued event its turn.

## Operator HTTP

Import `FactoryOverview`, `RunView`, `RunDetailView`, board views, operator needs, and transcript request types from `/operator`. The `Operator` service and its HTTP contract share these schemas.

`/operator/http` exports `OperatorApi`, the HTTP contract for observation and interventions. Call it with Effect's `HttpApiClient.make` and an `HttpClient` layer, or implement its `operator` group with `HttpApiBuilder.group`. Servers provide `OperatorHttpPolicy` for origin checks and failure translation; `apps/server` is the local server.

The generated client takes `Operator.detail`'s `ColdTranscriptRequest`, `TailTranscriptRequest`, and `EarlierTranscriptRequest`, encodes their exclusive query parameters, and decodes with the shared schemas. `OperatorHttpError` keeps the failure's `error` discriminator, readable `message`, and `status`; the wire response is `{ error, message }`. Successful actions return `{ ok: true }`; clients follow progress through the read endpoints.

## Polling triggers

`PollingTriggers.poll(instance)` runs one cycle. `PollingTriggers.run(instances)` repeats them every `poll_interval`, longer under rate-limit pressure, reading `instances.get` before each cycle and hint. A reload on `instances.changes` starts the next cycle at once, or when GitHub asked, if later. Repo failures are isolated and reported on the cycle.

`PollingTriggers.hint(repository, item)` queues a bounded, coalesced self-write nudge, serialized with cycles through the same projection and dedup path. Hints leave REST cursors, the poll cadence, and the last full cycle's findings unchanged, and polling repairs dropped or failed ones. GitHub backoff, including a failed writer's deadline, delays hints too. The write's own outcome still reaches its caller.

Each cycle first refreshes every repo's label catalog, which supplies lane colors, and creates labels declared in `usine.yaml` that are missing. It never touches existing labels, and logs color or description drift. Creation failures become preflight findings, and the cycle continues.

It then gets changed items from `GitHubPolling`, fetches one snapshot each, updates the projection, and evaluates each stream-matching loop's CEL `if:`. A match renders every `{{ CEL expression }}` in the loop body, resolves the agent and parent model, and stores that immutable context with the event, whose identity covers the loop, canonical repo, item number, and timestamp-free content hash. An unmatch revokes the loop's pending or approval-waiting work on the item. Repos without matching loops are still polled for the board.

Change detection never lists deleted or transferred issues, so at most every 10 minutes per repo, the cycle checks every stored open issue with `GitHubPolling.missingIssues`. Missing ones are marked gone, leaving the open lanes, and their pending or approval-waiting work is revoked. A failed check is logged and reported, and retried 10 minutes later.

A pull request's mergeability changes when its base branch moves, without a change that detection lists. The cursor keeps each open pull request with its base branch, `mergeable`, and whether checks are unsettled, plus the head of each base branch. Each cycle reads every base head with `GitHubPolling.baseRefHead`, and fetches an open pull request again when its base head moved or can't be read, or while its `mergeable` is `UNKNOWN`. The first read of a head counts as moved.

Polling also fetches an open pull request on every cycle while its check rollup is `PENDING` or `EXPECTED`, or while the rollup is absent and `mergeStateStatus` is `BLOCKED`. An absent rollup on a blocked pull request conservatively means checks are expected, including when reviews also block merging. A terminal rollup stops these retries; an absent rollup with another merge state does not cause them. Each retry costs one snapshot request, uses the existing projection and loop evaluation path, and respects GitHub backoff. Older cursors refresh open pull requests once to learn their check state. A later check rerun on a settled pull request still needs an item update or base movement to trigger a fetch.

An `if:` or prompt that fails on an item affects only that loop and item, and the cursor advances. The cursor records the failing item, so each cycle reports it until the loop evaluates, logging the error once per loop, item, and content hash. The first cycle after a restart or instance change fetches failing items again, so a fix applies without waiting for a change.

Cursors live in the engine's `CursorStore`. When a loop starts watching a repo or its trigger changes, the orchestrator drops that repo's cursor and polls cold; the event ledger absorbs repeats.

Before a queued event's run opens, the orchestrator re-checks its trigger against the item's GitHub state, with a five-second limit. A failed or timed-out check logs a warning and lets the event proceed; later polling can revoke the run. If GitHub no longer has the item, the engine revokes its queued events and marks it gone.

PR-triggered attempts check out the immutable `headRefOid` saved in their event payload; a later push is a new event. Issue and schedule attempts use the default branch.

`PollingTriggers.layer` needs `CursorStore`, `LoopControl`, `RunEngine`, `ConfigParser`, `ExpressionEngine`, `GitHubPolling`, the item and repo-label projection readers and writers, and `LabelReconciler`, whose layer needs `GitHubLabelWriter`. The engine's local SQLite layer supplies the engine services:

```ts
import { Layer } from "effect"
import { PollingTriggers } from "@usine/orchestrator/polling-triggers"

const dependencies = Layer.mergeAll(
  engineLayer,
  configParserLayer,
  expressionLayer,
  githubPollingLayer,
)

export const triggersLayer = PollingTriggers.layer.pipe(
  Layer.provide(dependencies),
)
```

Call `poll` if another scheduler owns timing; `run` is the built-in endless loop.

## Schedule triggers

`ScheduleTriggers.tick(instance)` evaluates the latest due tick of every `on: schedule` loop and fans it out to the loop's selected repos. Each repo gets one event with the payload `item.tick = { scheduledAt, scheduledAtLocal, cron, tz }`: `scheduledAt` is the UTC due time, `scheduledAtLocal` the same instant in the loop's `tz:`, and the event's `receivedAt` is when the orchestrator saw it.

The event key covers the loop, canonical repo, and scheduled time. An in-memory record of fired ticks makes repeated `tick` calls free; after downtime, a restart, or a reload, only the latest missed tick fires. A cron whose boundaries can't be computed at an instant (Effect's Cron can fail inside a DST spring-forward gap) fails only that schedule for that cycle, reported on the returned `ScheduleCycle`. The repo is the schedule stream's item, so a later tick follows the supersede rules of issue and PR state. Schedule runs use the same engine, approval gate, scheduler, executor, and agent layer; with no issue or PR to comment on, they block only in the UI.

`ScheduleTriggers.run(instances)` evaluates once at startup to catch up, then sleeps until the next tick, at most a minute, reading `instances.get` before each tick. A reload on `instances.changes` ends the sleep, so added or changed schedule loops are evaluated at once. Its layer needs `RunEngine`, `ConfigParser`, and `ExpressionEngine`.

## Instance reload

`CurrentInstance` (`/current-instance`) is the running instance snapshot. `CurrentInstance.layer(directory, initial, revisionNumber)` starts from the stored configuration and needs `ConfigurationStore` and `ConfigParser`. Polling, schedules, queued-event re-checks, App project discovery, attempt settings, and the operator backend read `get` when they act.

The layer follows committed revisions. `reload` re-reads the store and replaces the running snapshot. It returns an `InstanceReload` that names the loops, agents, labels, repos, and workers added, removed, or changed, and the files left out. An unreadable configuration store fails with `FactoryConfigError`, and a changed `webhooks` block with `RestartRequiredError`, whose `fields` and message name the change; both keep the running snapshot. `changes` streams the snapshot, then each one an accepted reload installs.

`registerWorkers(workers)` passes each later reload to the workers first. They refuse a `workers` change they can't apply (`RestartRequiredError`), preflight added workers, slots, and brains, refuse a failed preflight (`ReloadPreflightError`), and apply the new `workers` block after the snapshot is replaced. `stepExecutorLayer` registers itself; until then, as in setup mode, a reload refuses any `workers` change and preflights nothing. A run keeps the agent, task, and parent model it opened with.

## Worker scheduling

`stepExecutorLayer(config, brains, options)` (`/scheduler`, platform-free) takes the roster's `BrainSpec` values. At startup it checks every worker independently against the roster and the instance's agents, gives each passing worker `max_concurrent_attempts` slots, and assigns a free slot of the first worker in `usine.yaml` order to the first waiting run in `leaseOrder` (`lease-order.ts`): a reservation naming a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run, each group in event order. The position is read from the current loop file and the repository's `lanes` when the run starts waiting. Runs stay pending while all slots are taken. Each lease logs the run, its position and its source, and how many waiting runs with earlier events it passed.

A worker that fails startup preflight takes no new attempts. Other workers start, and Needs attention shows the failed worker and its preflight message with a link to its configuration. Runs waiting for that worker remain queued. Preflight retries after 1, 2, 5, and 10 minutes, then every 10 minutes. A passing retry restores scheduling and clears the entry. A reload that changes its slot count checks it immediately; a refused revision keeps the running configuration and scheduling availability. Removing the worker stops its retries. Startup fails with the preflight error if no worker passes.

A reservation naming a worker, as a reattaching run's does, takes only that worker's slot, before unnamed ones; it waits while that worker is full, and later runs can take other workers. For an undeclared worker, it logs a warning and waits for a reload that declares it. `occupy` takes a slot at once for an attempt already running, as at engine startup, even with none free, logging a warning; the worker then takes no new attempt until enough end, and each extra slot retires with its attempt. An unknown worker gets no slot, with a warning.

With `options.machines` (`WorkerMachines`, which the SSH composition passes), the scheduler leases a slot before the engine persists the attempt. `execute` then creates the machine with that attempt's ID in its initial labels. A failed creation retries within the same attempt, keeping its slot, and pauses further creation on that worker for `provisioner.timings.creation_backoff_min` seconds, doubling up to `creation_backoff_max` (30 and 600 by default). It does not consume an engine retry. Other workers continue. Cancellation interrupts creation and deletes the machine; releasing the lease frees the slot. A reattachment adopts its existing machine, and `occupy` uses that machine too. `StepExecutor.sweep` runs the executor cleanup, then the machine sweep.

`StepExecutor.discard` runs `options.discard`, or does nothing without it. The local, SSH, Cloudflare, and exe.dev compositions pass the `discard` of `sshWorkerRecordsFor` on `.usine/ssh-workers` in the instance directory, where the SSH executor records each long-lived SSH worker's machine (`withSshWorkerDiscard`). So **Discard leftovers** removes the discarded attempts' Codex homes from an SSH worker that `usine.yaml` no longer declares, even after it replaced the SSH workers with workers of another kind.

The layer registers with `CurrentInstance`, so a reload changes workers without touching running attempts:

- A worker with the same name, kind, and settings and a higher `max_concurrent_attempts` is preflighted with the new count and every rostered brain, and its new slots take waiting runs at once. With a lower count, it takes new attempts only while it runs fewer than the new count, and each extra slot retires with its attempt.
- A new worker of the executor's kind is preflighted with every brain and takes attempts once it passes. With `options.workers`, as the SSH composition sets, it joins the executor before preflight and leaves if the reload is refused.
- A removed worker takes no new attempt and stays in `StepExecutor.workers` until its last attempt ends; only then can its leftovers be discarded. Until then, its `UnconfiguredWorkerNeed` counts its running attempts as `running`, and `Operator.discardLeftovers` fails with `LeftoversDiscardRejectedError`. With `options.workers`, it then leaves the executor too.
- A changed kind or other setting, a renamed worker, or a worker the executor can't run fails the reload with `RestartRequiredError` naming the field, such as `workers.build-1.destination`.

Other workers are preflighted with the brains the reload adds; any failed preflight refuses the reload. Resizes, additions, removals, and retired slots are logged with counts. Attempts read `max_children`, the runaway ceilings, and the parent effort from `CurrentInstance` at start, so reloads apply to the next attempt. The layer rejects worker kinds its executor can't run. Capability failures during preparation become non-retryable `AgentFailure` outcomes, like missing model credentials.

The layer also provides `WorkerStatus` (`/worker-status`): each worker's slots and how many are taken, the waiting runs in lease order, and the last preflight of each worker's own prerequisites and of each harness, with time and result: passed, failed, for an SSH worker without Docker, degraded, or, for a provisioned worker's harnesses before its next due machine check, deferred. With them, it keeps the limits of each attempt container from the last passed preflight that checked the worker's machine, which a provisioned worker's next due machine check reports; a preflight without a machine keeps them. It also lists the provisioned workers' machines in flight and each provisioned worker's last failed creation with its next try. It records the startup preflight, retries, and every reload's, refused ones included. `unavailable` lists the workers still excluded after startup preflight, with their latest retry messages; a successful check in a refused revision does not clear this list. The local, SSH, and exe.dev compositions pass it on; `WorkerStatus.idle` stands in where no worker runs attempts.

## Compositions

`/local` composes the scheduler with the Node local executor and the engine's local SQLite adapter. It needs a caller-owned `CredentialProvider`: `gitHubCredentialLayer` with `@usine/github`, or another provider that mints one repo credential per attempt.

```ts
import { layer as localLayer } from "@usine/orchestrator/local"

const EngineLive = localLayer(instanceDirectory, config, brains, {
  repositoryUrl: (repository) => `https://github.com/${repository}.git`,
})
```

Provide `CredentialProvider` and `CurrentInstance` to `EngineLive`, then request `RunEngine`. Repos are cached under `<instance>/.usine/workers/<worker>/repos`; worktrees are removed after completion or cancel.

All three compositions run each attempt's Pi parent in the orchestrator as a durable task (`@usine/durable`). `layer` needs the `AttemptRuntime` and the `ClaudeLoginLock` shared by its Claude children and the worker's preflight, and builds the runtime before the engine, so tasks are resumed before run recovery and a restart reattaches live attempts. Stored v3–v6 transcripts stay readable.

`runtimeLayer(instanceDirectory, instanceId)` (`/runtime`) composes the whole application, adding GitHub polling, schedule triggers, CEL parsing, `Orchestrator`, and `Operator`. It uses the SSH composition if every worker is `ssh`, the Cloudflare composition if every worker is `cloudflare`, otherwise the local one, which refuses other kinds at startup. One `ClaudeLoginLock` serves both the attempt runtime and the worker composition. Preflight requirements come from the instance's agents at build time. It needs `GitHubCredentials` and `CurrentInstance`, which the host loads. `operatorObservationLayer(instanceDirectory)` is the read-only Node composition for setup and maintenance: it provides `OperatorObservation` and `OperatorConfiguration` from durable runs and loop state, with triggers idle and no worker running attempts.

`/ssh` composes the scheduler with the SSH executor, and also needs a `CredentialProvider` for the token each attempt writes on its machine or attaches to its gateway. `sshWorkersOf(config)` returns the declared SSH workers; `sshWorkerAddressesOf(config)` turns them into executor addresses, with their `container` settings, reading each gateway's admin token from its `admin_token_env` variable, and fails with a `gateway` capability error naming an unset one. The SSH executor uses Node's HTTP client for provider and gateway requests, preserving the `Host: git.<domain>` header when preflight probes a gateway's tailnet address. Admin requests use the executor's forward to each gateway's `destination`. `workerEngineLayer` labels the SSH executor's attempt containers with `github-app-<App ID>` from `GitHubCredentials`, the instance's identity (ADR 0011), and with the `InstanceId` that the host passes, which tells apart instances that share the App.

`sshStepExecutorLayer(config, brains)` lets a reload resize, add, and remove SSH workers through `SshWorkers`. An added worker joins the executor before preflight, and its gateway's token is read then; an unset variable refuses the reload with `ReloadPreflightError` naming it, since a running process doesn't see variables set after it started. A removed worker leaves the executor once its last attempt ends, and its gateway's forward closes if no other worker uses it.

`/cloudflare` composes the scheduler with the Cloudflare executor, with the GitHub App's ID as the instance that owns the sandboxes. `cloudflareWorkersOf(config)` returns the declared Cloudflare workers; `cloudflareWorkerAddressesOf(config)` turns them into executor addresses, reading each worker's Access service token and provider API keys from the variables that it names, and fails with a `credentials` capability error naming an unset one. The executor reads these secrets once, so a reload can resize or remove a Cloudflare worker, and add back only one that `usine up` started with; any other addition refuses the reload with `ReloadPreflightError`.

```ts
import { InstanceId } from "@usine/core/instance"
import { layer as sshLayer, sshWorkerAddressesOf } from "@usine/orchestrator/ssh"
import { Effect, Layer } from "effect"

const EngineLive = Layer.unwrap(
  Effect.map(sshWorkerAddressesOf(config), (workers) =>
    sshLayer(instanceDirectory, config, brains, {
      workers,
      instance: "github-app-123456",
      instanceId: InstanceId.make("0b4e7f3c-5a2d-4c1e-9f6b-8d7a2e1c3b4f"),
    }),
  ),
)
```

The live SSH test runs one attempt on a real machine, with a scripted parent using the machine's gh and git with the minted token, and preflights Claude Code and Codex there, printing `ready` or why a login is missing. It runs only if `USINE_SSH_INTEGRATION_DESTINATION` is set, and needs an instance directory whose App installation covers the repo:

```sh
export USINE_SSH_INTEGRATION_DESTINATION=usine@203.0.113.7
export USINE_SSH_INTEGRATION_IDENTITY_FILE=~/.ssh/usine_worker   # optional
export USINE_SSH_INTEGRATION_KNOWN_HOSTS=/path/to/known_hosts    # optional
export USINE_SSH_INTEGRATION_ROOT=/home/usine/.usine             # the default
export USINE_SSH_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
pnpm --filter @usine/orchestrator test:ssh
```

The same file tests a worker behind a gateway (`infra/hetzner/gateway`). The scripted child fetches through the gateway, calls `gh api`, pushes and deletes a `usine-gateway-test/<uuid>` branch through a `https://github.com/` URL, reaches the npm registry through the forward proxy, and looks for GitHub tokens on the machine; the test then checks that the gateway has no attachment for the worker. The repo must accept the App's pushes. It runs only if `USINE_GATEWAY_INTEGRATION_DESTINATION` is set. Besides the executor's own forward, the post-attempt check opens one on local port 17070:

```sh
export USINE_GATEWAY_INTEGRATION_DESTINATION=worker-one                # a Host with ProxyJump through the gateway
export USINE_GATEWAY_INTEGRATION_SSH_CONFIG=/path/to/ssh_config        # optional
export USINE_GATEWAY_INTEGRATION_ROOT=/home/usine/.usine               # the default
export USINE_GATEWAY_INTEGRATION_DOMAIN=gw.internal                    # the default
export USINE_GATEWAY_INTEGRATION_GATEWAY=usine-gateway                 # the default: the Gateway's SSH destination
export USINE_GATEWAY_INTEGRATION_ADMIN_TOKEN=...                       # from /etc/usine-gateway/secrets.env
export USINE_GATEWAY_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
pnpm --filter @usine/orchestrator test:ssh
```

For exe.dev, `/exe-dev` keeps the engine and SQLite runtime local and runs the worker contract on the named VM:

```ts
import { RepositoryName } from "@usine/core/repository"
import { GitHubIntegration, IntegrationName } from "@usine/executor/exe-dev"
import { layer as exeDevLayer } from "@usine/orchestrator/exe-dev"

const EngineLive = exeDevLayer(instanceDirectory, config, brains, {
  githubIntegrations: [
    new GitHubIntegration({
      repository: RepositoryName.make("acme/widget"),
      name: IntegrationName.make("usine-acme-widget"),
    }),
  ],

})
```

The integration grant is a renewal window, not an attempt bound: it lasts `credentialGrantMinutes` (65 by default), renews at half that while the attempt runs, and retries a failed renewal every minute, whatever `max_attempt_minutes` is. If `max_attempt_minutes` is set, the scheduler bounds every launch at it: a hung parent or dead link is interrupted through the normal cancel and reported as a typed infrastructure failure.

The live exe.dev test needs an existing baked VM and its GitHub integration:

```sh
export USINE_EXE_DEV_INTEGRATION_WORKER=worker-name
export USINE_EXE_DEV_INTEGRATION_REPO=owner/repo
export USINE_EXE_DEV_INTEGRATION_REVISION=main
export USINE_EXE_DEV_INTEGRATION_GITHUB_INTEGRATION=integration-name
pnpm --filter @usine/orchestrator test:exe-dev
```

## Live GitHub tests

The opt-in integration test needs a disposable issue in a repo that the configured App covers. It creates a uniquely named label, applies it to the issue, checks the resulting event and restart deduplication, then deletes the label.

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
pnpm --filter @usine/orchestrator test:integration
```

The agent contract test starts the local worker with the production durable parent runtime. The Pi parent delegates to Claude Code, which reads the issue with `gh` and posts one signed comment as the App bot. Build the workspace, provide working Pi and Claude credentials in the worker user's home directory, then run:

```sh
pnpm build
export USINE_GITHUB_INTEGRATION_BOT_LOGIN='your-app[bot]'
export USINE_AGENT_INTEGRATION_PARENT_MODEL=provider/model
export USINE_AGENT_INTEGRATION_CHILD_MODEL=claude-model-id
pnpm --filter @usine/orchestrator test:integration:agent
```

Cleanup removes its kick and result comments.

The operator HTTP contract includes `GET /api/upgrade`, `POST /api/upgrade`, and `GET /api/version`. The upgrade view reports the channel, running and available versions, progress, and rollback outcome, including its `failureStage` (`install`, `health-check`, or `unknown`). A request selects `idle` or `now`, with an optional exact version. The server supplies the systemd implementation; the contract remains platform-free.

The Node runtime and worker compositions accept a supplied `RunDatabase` layer. The server shares it with the configuration store, and stored agent revisions pass the same worker preflight as explicit reloads. A restart-required revision remains in the store while the running snapshot stays unchanged; restart applies it.

## Dismiss attention entries

`Operator.dismissNeed(instance, key)` and `Operator.undoDismissNeed(key)` record or remove an acknowledgement for the entry ID and revision returned by `attentionKey(need)`. The HTTP endpoints are `POST /api/attention/dismiss` and `POST /api/attention/undo`, each with `{ "id": "...", "revision": "..." }`.

The overview returns visible entries in `needsYou` and matching acknowledged entries in `dismissedNeeds`. Project status and task and board attention badges use the visible list. A change to the entry's content makes it visible again; a later failed attempt has its own entry identity. Dismissal preserves approval gates, unresolved failures, and cycle-budget asks.

After polling and schedule triggers each report their first cycle, the overview prunes acknowledgements on refresh for entries it no longer reports or whose content revision changed. Before both reports arrive, including in setup mode, it retains acknowledgements because an empty source can still be uninitialized. It retains acknowledgements for current dismissed entries. If an entry disappears during a refresh and later returns with the same content, it needs a new dismissal. Each failed schedule tick and each change to an unconfigured worker's attempt counts still produces a new revision.

For Boat workers behind a gateway, the SSH adapter resolves `provisioner.tailnet.client_id_env` and `client_secret_env` into redacted OAuth credentials. Missing variables produce a gateway capability error before an attempt starts.

Needs attention includes `UnresponsiveWorkerNeed` after three consecutive unanswered worker probes. Each entry lists the affected running attempts and the last answer time. Worker notices refresh even when the board projection is cached, and remain visible beyond the recent transcript page. Recovery or completion removes the affected attempt; a later outage or changed attempt list resurfaces a dismissed entry. Worker preflight runs for every slot-count change on reload, including reductions.

## Configuration revisions API

`ConfigurationEditor` reads revision history and saves entity changes through `CurrentInstance.commit`. The runtime checks restart requirements and worker preflight before committing, then applies the accepted snapshot before the request returns. A refused API write saves no revision. The actor comes from the stored configuration's `operator` value.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/configuration/revisions` | Newest revision summaries, with optional `kind`, `identifier`, `before`, and `limit` query parameters. |
| GET | `/api/configuration/revisions/:number` | A revision with each entity's before and after values. |
| GET | `/api/configuration/entities/:kind/:identifier` | The current JSON `value`, export-format `text`, and revision `number`. |
| PUT | `/api/configuration/entities/:kind/:identifier` | Creates or replaces an entity from `value` or `text`. |
| DELETE | `/api/configuration/entities/:kind/:identifier` | Deletes an entity. |
| POST | `/api/configuration/revisions/:number/revert` | Creates a revision that restores the earlier values and worker positions. |

Writes require `expected`, the current revision number, and accept an optional `message`. PUT requires exactly one of `value` and `text`; workers also accept a zero-based `position`. Encode identifiers as URL path segments, including the slash in repository names. For example, `owner/repo` becomes `owner%2Frepo`.

Revision lists default to 50 entries and accept limits from 1 to 100. Pass a response's `nextBefore` as `before` for the next page; `null` means there are no more entries. Before and after values use `null` for an absent entity. Actors and messages are nullable; times are ISO timestamps.

Stale writes return 409 with `expected` and `current`. Invalid configuration returns 422 with a `problems` array containing the entity key, field path when available, and message. Unknown entities, kinds, and revision numbers return 404. A revert returns 409 with the conflicting entity keys if a later revision changed them. Restart and preflight refusals use the reload endpoint's error responses.
