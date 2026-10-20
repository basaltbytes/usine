# @usine/orchestrator

`@usine/orchestrator` connects loaded loop files to GitHub polling, the durable run engine, and configured workers for [usine](https://github.com/basaltbytes/usine).

Its platform-free entry points provide `PollingTriggers` at `/polling-triggers`, `ScheduleTriggers` at `/schedule-triggers`, `Orchestrator` at `/orchestrator`, and `Operator` with its request and response types at `/operator`. `Orchestrator.run` runs both trigger streams over the factory's `CurrentInstance`; `Operator` provides run and Board observation, structured protocol transcript pages, label-backed Board moves, approve/retry/cancel, and database-backed Loop pause/unpause. Transcript payloads, Attempt brains/outcomes, and items needing attention remain typed data. Captured executor defects appear as `DefectFailure` with a safe message; original causes stay out of operator responses. Consuming apps own their wording and presentation. `OperatorObservation` exposes the same read-only projection without constructing execution services. `OperatorConfiguration.view(instance)` returns the instance folder as parsed, with no new parsing: each Loop, Agent, Worker, registered repository with its lanes, and the settings, every quarantined Loop and invalid Agent with its error, and beside them each Loop's pause, each Worker's slots and last preflight per harness from `WorkerStatus`, and each repository's labels as polling last read them. A Gateway's admin token appears only as the name of its environment variable. The latest polling and schedule failures remain visible through `Operator.overview(instance)` after their sibling work continues. Concurrent overview reads with the same durable revision share one projection computation.

`Operator.overview(instance)` joins the latest 500 polled Items into Task cards in each repository's authored lanes. Explicit same-repository issue closing links and saved Run PR results join an issue to a PR. Repositories without configured lanes receive proposals from the repository label catalog, including unused labels and repositories with no Items. Items that match no source appear in a read-only `Unmapped` lane, and label matches take precedence over state sources. Each card retains every saved Run on its member Items, oldest first. The newest open Run determines the current Item; between Runs an open PR, then the latest settled PR, takes over from the issue. Its labels and state determine the lane, so removing the issue's trigger label does not strand a task whose PR is under review. See ADR 0024. A malformed Item projection is quarantined and reported in the Board and needs-you strip while valid siblings remain visible. Failed declared-label creation also appears as a repository preflight finding without blocking trigger work.

`Operator.moveBoardItem(instance, move)` accepts authored label-backed lanes, adds the target lane labels, and removes only labels owned by the authored map. Proposed lanes are read-only; direct move requests return `BoardLaneReadOnlyError`. GitHub labels outside the authored map remain unchanged even when the Item snapshot is stale or its label connection is truncated. Configure `repos[].lanes` in `usine.yaml` and reload the instance to enable moves; see the [lane configuration example](../config/README.md). Every attempted GitHub label write queues an Item Hint, including an uncertain or partially applied failure: the running poller fetches the current GitHub snapshot, projects its Board position, and evaluates its Loops immediately unless GitHub has requested backoff.

`Operator.detail` accepts distinct cold, live-tail, and earlier-page requests. A cold read keeps the newest 500 rows per Attempt and returns an earlier cursor for every truncated Attempt; clients can page each cursor backward until the entire transcript is reachable without ballooning the first drawer response. A live-tail response returns at most 500 rows across the Run and advances its cursor from the last returned row.

`Operator.task(instance, repository, item)` reads the Task that holds Item `item` as `TaskView`, found from any of its Items and named by its originating Item, the earliest issue or, without one, the earliest pull request. It joins the Task through the same projection as the overview's Board, over the repository's 500 newest Items, and reads every saved Run of those Items from `RunReader.forItems`, so a Task's Runs do not depend on the overview's recent-history window. It returns the Task's lane and current Item, each Item's state, labels, and conflict with its base, its Runs newest first, and the `Comment` facts of its succeeded Runs, each dated by the end of the Attempt that recorded it. An Item outside the window fails with `BoardItemNotFoundError`. The operator API serves it at `GET /api/projects/:owner/:repository/tasks/:item`.

`Operator.githubChanges(runId)` answers what each of a Run's Attempts changed on the Run's GitHub Item: the labels it added and removed, its comments, and its submitted reviews, oldest first, as `RunGitHubChangesView`. It reads them from the Item's timeline through `GitHubItemHistory`, keeps only the App's own changes, and gives each change to the one Attempt on the Item that was at work when GitHub recorded it, from the second the Attempt started until it ended, or until now while it runs. An Attempt that ended before end times were recorded ends at its last transcript row. Every Agent writes as the same App, so a change made while Attempts of two Runs on the Item overlapped belongs to neither and is logged instead. A Board move is written by the same App, so `Operator.moveBoardItem` records each move through `BoardMoves` (`@usine/engine/board-moves`) before sending its labels, and a move that cannot be recorded is not sent. A label change on the timeline is the move's when the move sent that label the same way and GitHub recorded it from 1 second before the second the move was recorded until 10 seconds after it. Such changes leave the Attempt's changes, and the move appears instead as `BoardMoved`, with its source and destination lanes, in the Attempt at work when the operator made it. A move none of whose labels GitHub recorded, such as a write GitHub refused, does not appear. Moves made before moves were recorded still read as the Agent's. One read asks GitHub once, from the start of the earliest Attempt not yet cached; an Attempt is cached in memory a minute after it ends, so reopening a finished Run asks GitHub nothing until the orchestrator restarts. A schedule Run has no Item and lists no Attempts. The operator API serves it at `GET /api/runs/:runId/github-changes`; an Item GitHub no longer has answers 404 `GitHubItemNotFoundError`.

## Operator HTTP

Import `FactoryOverview`, `RunView`, `RunDetailView`, Board views, operator needs,
and transcript request types from `@usine/orchestrator/operator`. The `Operator`
service and its HTTP contract use the same schemas for these views and requests.

`@usine/orchestrator/operator/http` exports `OperatorApi`, the shared HTTP contract
for operator observation and interventions. Use Effect's `HttpApiClient.make` with
an `HttpClient` layer to call it, or `HttpApiBuilder.group` to implement its
`operator` group. Server implementations provide `OperatorHttpPolicy` to enforce
origin checks and translate request failures; `apps/server` provides the local
server implementation.

The generated client accepts the same `ColdTranscriptRequest`,
`TailTranscriptRequest`, and `EarlierTranscriptRequest` values as `Operator.detail`.
It encodes their exclusive query parameters and decodes responses through the
shared read-model schemas. `OperatorHttpError` preserves the failure's `error`
discriminator, operator-readable `message`, and associated `status`. The wire
response remains `{ error, message }`. Successful actions return `{ ok: true }`;
clients observe subsequent Run or Board progress through the read endpoints.

## Polling triggers

`PollingTriggers.poll(instance)` performs one cycle; `PollingTriggers.run(instances)` repeats cycles, reading the instance from `instances.get` before each cycle and each Hint, using its factory-wide `poll_interval`, and waits longer when GitHub reports rate-limit pressure. A reload accepted while it waits, seen on `instances.changes`, starts the next cycle at once, or at the time GitHub asked for when that is later. Per-repository failures are isolated and reported on the cycle; one failing repository never stops its siblings. `PollingTriggers.hint(repository, item)` queues a bounded, coalesced self-write nudge. The running poller serializes Hint snapshots with regular cycles and uses the same projection and Event dedup path. Hints leave REST cursors, the normal conditional-poll cadence, and the last complete cycle’s findings intact; dropped or failed Hints are repaired by the polling backstop. GitHub request backoff, including deadlines reported by a failed writer, also delays Hint fetches. The original write outcome still reaches its caller.

Each cycle first refreshes the complete label catalog in every managed repository and reconciles the factory-wide declarations from `usine.yaml`. Usine creates missing labels before change detection or Item evaluation. It leaves existing labels untouched and logs color or description drift. Creation failures become preflight findings, and the cycle continues into triggers. The updated catalog remains the Board's source for lane colors.

After label preflight, the cycle asks `GitHubPolling` for changed items, fetches one payload snapshot per changed item, updates the durable Item projection, and evaluates each stream-matching loop's CEL `if:` expression against that snapshot. A match renders every `{{ CEL expression }}` in the loop body, resolves the named agent and effective parent model, then stores that immutable execution context with the Event. The Event identity covers the loop, canonical repository, item number, and timestamp-free content hash. An unmatch revokes pending or approval-waiting work for that loop and item. Repositories without matching loops are still polled for their Board projection.

A loop whose `if:` or prompt fails to evaluate on an item affects only that loop and item: the other loops and items continue and the cursor advances. The cursor records the failing item, so every cycle reports the failure with the loop and item until the loop evaluates on it, and the error is logged once per loop, item, and content hash. The first cycle of a new process, and the first cycle after the instance changes, fetches the failing items again, so a loop fixed before a restart or a reload evaluates them without waiting for a change.

Polling cursors live in the engine's `CursorStore`. When a loop starts watching a repository or its trigger expression changes, the orchestrator discards that repository's efficiency cursor and performs a cold poll, while the permanent Event ledger absorbs repeated state.

Before opening a queued Event's Run, the orchestrator re-checks its trigger against the Item's current GitHub state. The re-check has a five-second limit. A failed or timed-out check logs a warning and lets the queued Event proceed; subsequent polling can revoke a Run whose Item no longer matches. When GitHub no longer has the Item, the engine revokes its queued Events and marks its projection gone, so its Board card leaves the open lanes.

PR-triggered Attempts fetch and check out the immutable `headRefOid` saved in their Event payload. A later push creates a new Event with its new head commit. Issue and schedule Attempts use the repository's default branch.

`PollingTriggers.layer` requires `CursorStore`, `LoopControl`, `RunEngine`, `ConfigParser`, `ExpressionEngine`, `GitHubPolling`, the repository-label projection reader/writer, and `LabelReconciler`. `LabelReconciler.layer` in turn requires `GitHubLabelWriter`. The engine's local SQLite layer supplies the engine services:

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

Call `poll` when another scheduler owns timing. Use `run` for the built-in endless polling loop.

## Schedule triggers

`ScheduleTriggers.tick(instance)` evaluates the most recent due Tick for every `on: schedule` loop and fans it out to the repositories selected by that loop. Each selected repository receives one Event whose payload is `item.tick = { scheduledAt, scheduledAtLocal, cron, tz }`; `scheduledAt` is the UTC time the Tick was due, `scheduledAtLocal` the same instant in the loop's `tz:`, while the Event's `receivedAt` records when the orchestrator observed it.

The Event key covers the loop, canonical repository, and scheduled time. An in-memory fired-tick memory skips already-submitted boundaries, so calling `tick` repeatedly costs nothing, and waking after downtime (or a restart or a reload, which clear that memory) emits only the latest missed Tick. A cron whose boundaries cannot be computed at an instant (effect's Cron can fail inside a DST spring-forward gap) fails only that schedule for that cycle and is reported on the returned `ScheduleCycle`. The repository is the schedule stream's Item, so a later Tick follows the same supersede rules as issue and pull-request state. Schedule Runs go through the unchanged `RunEngine`, approval gate, worker scheduler, executor, and agent layer. Because they have no GitHub issue or pull request to comment on, their blocking moments remain UI-only.

`ScheduleTriggers.run(instances)` evaluates once at startup for catch-up, then sleeps until the earliest next Tick, for at most a minute, reading the instance from `instances.get` before each Tick. A reload accepted while it sleeps, seen on `instances.changes`, ends the sleep, so a schedule Loop the reload adds or changes is evaluated at once. Its layer requires `RunEngine`, `ConfigParser`, and `ExpressionEngine`.

## Reloading the instance

`@usine/orchestrator/current-instance` exports `CurrentInstance`, the instance folder snapshot the orchestrator runs. `CurrentInstance.layer(directory, initial)` starts from the snapshot `usine up` loaded and needs `InstanceFolder` from `@usine/config/instance-folder`. Polling, schedules, queued-Event re-checks, GitHub App project discovery, Attempt settings, and the operator backend read `get` when they act. `reload` loads the folder again with the same per-file quarantine and replaces the snapshot, returning an `InstanceReload` that names the Loops, Agents, labels, repositories, and Workers it added, removed, or changed, and lists the files left out. An invalid `usine.yaml` fails the reload with `FactoryConfigError`, and a changed `webhooks` block fails it with `RestartRequiredError`, whose `fields` and message name what changed; both keep the running snapshot. `changes` streams the snapshot and then each one an accepted reload puts in its place. `registerWorkers(workers)` hands each later reload to the Workers that run Attempts before it replaces the snapshot: they refuse a `workers` change they cannot apply with `RestartRequiredError`, preflight the Workers, slots, and brains the reload adds, and refuse a failed preflight with `ReloadPreflightError`, then apply the reloaded `workers` block once the snapshot is replaced. `stepExecutorLayer` registers itself; before that, as in setup mode, a reload refuses any `workers` change and preflights nothing. A Run keeps the Agent, task, and parent model it was opened with.

## Worker scheduling

`@usine/orchestrator/scheduler` exports the platform-free `stepExecutorLayer`. `stepExecutorLayer(config, brains, options)` accepts the roster’s `BrainSpec` values. At startup it verifies every configured worker against that roster and the current instance's Agents, gives each Worker `max_concurrent_attempts` slots, and assigns a free slot of the first Worker in `usine.yaml` order to the Run whose Event arrived first. Runs stay pending while every slot is occupied. It registers with `CurrentInstance`, so a reload can change the Workers without touching running Attempts:

- A Worker that keeps its name, kind, and settings with a higher `max_concurrent_attempts` is preflighted with its new count and every rostered brain, and its new slots take waiting Runs at once. With a lower count it takes a new Attempt only while it runs fewer Attempts than the new count, and each extra slot retires when its Attempt ends.
- A new Worker of the executor's kind is preflighted with every rostered brain and takes Attempts once it passes. With `startupWorkersOnly`, as the SSH composition sets, only a Worker of `config` with its startup settings can be added back.
- A removed Worker takes no new Attempt; it stays in `StepExecutor.workers` until its last Attempt ends, so its leftovers can be discarded from then on.

The layer also provides `WorkerStatus` from `@usine/orchestrator/worker-status`: the slots of each Worker and how many Attempts hold one, and the last preflight of each Worker's own prerequisites and of each harness, with its time and result. It records the startup preflight and each preflight a reload runs, a refused reload's included. The local, SSH, and exe.dev compositions pass it on; `WorkerStatus.idle` stands in where no Worker runs Attempts.
- A changed kind or other setting, a renamed Worker, and a Worker the executor cannot run fail the reload with `RestartRequiredError` naming the field, such as `workers.build-1.destination`.

The other Workers are preflighted with the brains the reload adds, and any failed preflight refuses the whole reload. Each resize, addition, removal, and retired slot is logged with the Worker and its counts. Each Attempt reads `max_children`, the runaway ceilings, and the parent effort from the `CurrentInstance` when it starts, so a reload applies them to the next Attempt. The layer rejects worker kinds that its supplied executor cannot run. Worker capability failures during preparation become non-retryable `AgentFailure` outcomes, like unavailable model credentials.

`@usine/orchestrator/local` composes the scheduler with the Node local executor and the engine's local SQLite adapter. It requires a caller-owned `CredentialProvider`; use `gitHubCredentialLayer` with `@usine/github`, or supply another provider that mints one repository credential per Attempt.

```ts
import { layer as localLayer } from "@usine/orchestrator/local"

const EngineLive = localLayer(instanceDirectory, config, brains, {
  repositoryUrl: (repository) => `https://github.com/${repository}.git`,
})
```

Provide `CredentialProvider` and `CurrentInstance` to `EngineLive`, then request `RunEngine` from the resulting Effect layer. The local composition caches repositories under `<instance>/.usine/workers/<worker>/repos` and removes Attempt worktrees after completion or cancellation.

For the whole application, `@usine/orchestrator/runtime`'s `runtimeLayer(instanceDirectory)` additionally composes GitHub polling, schedule triggers, CEL parsing, `Orchestrator`, and `Operator`. It selects the Worker composition from the kind of the Workers in `usine.yaml`: the SSH one when every Worker is `ssh`, the local one otherwise, which refuses any other kind at startup. It derives worker preflight requirements from the Agents of the current instance when it builds and requires `GitHubCredentials` and `CurrentInstance`; the server or another host owns how those are loaded. `operatorObservationLayer(instanceDirectory)` is the read-only Node composition for setup and maintenance surfaces: it provides `OperatorObservation` and `OperatorConfiguration`, reading durable Runs and Loop runtime state while trigger execution remains idle and no Worker runs Attempts.

For SSH Workers, `@usine/orchestrator/ssh` composes the scheduler with the SSH executor. Like the local composition it requires a `CredentialProvider`, which mints the token each Attempt writes on its Worker's machine or attaches to its Worker's Gateway. `sshWorkersOf(config)` returns the SSH Workers `usine.yaml` declares, and `sshWorkerAddressesOf(config)` turns them into the executor's addresses, reading each Gateway's admin token from the environment variable its `admin_token_env` names; an unset variable fails with a `gateway` capability error that names it. Gateway admin APIs are called with `fetch`, through the forward the executor opens to each Gateway's `destination`. The SSH executor sets up each Worker's machine and Gateway forward when its layer builds, so a reload can resize or remove SSH Workers but cannot add a new one; a removed Worker's forward stays open until `usine up` stops.

```ts
import { layer as sshLayer, sshWorkerAddressesOf } from "@usine/orchestrator/ssh"
import { Effect, Layer } from "effect"

const EngineLive = Layer.unwrap(
  Effect.map(sshWorkerAddressesOf(config), (workers) =>
    sshLayer(instanceDirectory, config, brains, { workers }),
  ),
)
```

The live SSH check runs one Attempt end to end on a real machine, with a scripted parent whose commands use the machine's gh and git with the minted token, and preflights Claude Code and Codex there, printing each harness's outcome: `ready`, or why its login is missing. It skips unless `USINE_SSH_INTEGRATION_DESTINATION` is set, and needs a GitHub App instance directory whose installation covers the repository:

```sh
export USINE_SSH_INTEGRATION_DESTINATION=usine@203.0.113.7
export USINE_SSH_INTEGRATION_IDENTITY_FILE=~/.ssh/usine_worker   # optional
export USINE_SSH_INTEGRATION_KNOWN_HOSTS=/path/to/known_hosts    # optional
export USINE_SSH_INTEGRATION_ROOT=/home/usine/.usine             # the default
export USINE_SSH_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
pnpm --filter @usine/orchestrator test:ssh
```

The same file has a live check for a Worker behind a Gateway (`infra/hetzner/gateway`). It runs one Attempt whose scripted child fetches through the Gateway, calls `gh api`, pushes a branch named `usine-gateway-test/<uuid>` and deletes it again through a `https://github.com/` URL, reaches the npm registry through the forward proxy, and looks for GitHub tokens on the machine; afterwards it checks that the Gateway holds no attachment for the Worker. The repository must accept pushes from the App. It skips unless `USINE_GATEWAY_INTEGRATION_DESTINATION` is set. The executor opens its own forward to the admin API through the Gateway's destination; the check that follows the Attempt opens a second one on local port 17070:

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

For an exe.dev Worker, use the `@usine/orchestrator/exe-dev` composition. It keeps the engine and SQLite runtime local while the unchanged Worker contract runs on the named VM:

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

The GitHub integration grant is a renewal window, not an Attempt bound. The executor attaches it for `credentialGrantMinutes` (65 by default), renews it at half that length for as long as the Attempt runs, and retries a failed renewal every minute; `max_attempt_minutes` plays no part in it. When `max_attempt_minutes` is set, the scheduler bounds every launch at it: a hung parent or dead link is interrupted through the normal cancel handshake and reported as a typed infrastructure failure.

The live exe.dev check requires an existing baked VM and its GitHub integration:

```sh
export USINE_EXE_DEV_INTEGRATION_WORKER=worker-name
export USINE_EXE_DEV_INTEGRATION_REPO=owner/repo
export USINE_EXE_DEV_INTEGRATION_REVISION=main
export USINE_EXE_DEV_INTEGRATION_GITHUB_INTEGRATION=integration-name
pnpm --filter @usine/orchestrator test:exe-dev
```

## Live GitHub check

The opt-in integration test needs a disposable issue in a repository covered by the configured GitHub App. It creates a uniquely named repository label, applies it to the issue, checks the resulting Event and restart deduplication, then deletes the label.

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
pnpm --filter @usine/orchestrator test:integration
```

The agent contract test also starts the local worker with the production durable parent runtime. The Pi parent delegates to Claude Code, which reads the issue with `gh` and posts one signed comment as the App bot. Build the workspace first, provide working Pi and Claude credentials in the worker user's home directory, then run:

```sh
pnpm build
export USINE_GITHUB_INTEGRATION_BOT_LOGIN='your-app[bot]'
export USINE_AGENT_INTEGRATION_PARENT_MODEL=provider/model
export USINE_AGENT_INTEGRATION_CHILD_MODEL=claude-model-id
pnpm --filter @usine/orchestrator test:integration:agent
```

The test removes its kick and result comments during cleanup.

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

Item cycle exhaustion appears as a `CycleBudgetNeed` in the overview and marks the Item’s Board card as needing attention. `Operator.resetCycleBudget` records an answer to the exact Ask; polling restarts the repository cursor, fetches current Items, and evaluates active Loops before opening further Runs. A failed refresh is retried. Each Item fetch captures its budget generation; resets supersede in-flight observations and fresh Events use the current Loop configuration. GitHub delivery of these Asks is tracked separately in [#36](https://github.com/basaltbytes/usine/issues/36).

The operator HTTP API exposes `POST /api/cycle-budgets/reset` with `{ "askId": "…" }`. A stale or differently answered Ask returns HTTP 409.

Local, exe.dev, and SSH Workers all run each Attempt's Pi parent in the orchestrator process as a durable task (`@usine/durable`); `layer` requires the `AttemptRuntime` and builds it before the engine, so durable storage is open and its tasks resumed before Run recovery. An orchestrator restart reattaches a live Attempt instead of failing it. Stored v3–v6 transcripts remain readable.

`Operator.runAgain(instance, runId, edit)` opens a new Run for the Item state of a succeeded or canceled Run, with the edit's task and roster Agent and the Step, approval, and cycle limit of the loaded Loop file, as asked by the `operator` login in `usine.yaml`. It answers `Claimed` with the new Run, or `CycleBlocked` with the Item's Ask, and fails with `LoopNotFoundError` when the Run's Loop is not loaded. The operator API exposes it as `POST /api/runs/:runId/run-again` with `{ "task": "...", "agent": "..." }`. `RunView.canRunAgain` says when it applies, and `RunView.runAgain` names the Run a Run was opened from.

`Operator.resolveFailure(runId, attemptId)` clears attention for the current failed Attempt. The operator API exposes it as `POST /api/runs/:runId/resolve-failure` with `{ "attemptId": "..." }`. Resolved failures remain in Run history with retry available. Needs you, Project status, and Board attention reflect resolution; a later failed Attempt requests attention again. A failure that is an Agent's question (`QuestionFailureView`) or blocker (`BlockedFailureView`) is answered this way: its Loop stops holding the Item, and the Item's newest queued Event gets its turn.
