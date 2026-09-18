# @usine/orchestrator

`@usine/orchestrator` connects loaded loop files to GitHub polling, the durable run engine, and configured workers for [usine](https://github.com/basaltbytes/usine).

Its platform-free entry points provide `PollingTriggers` at `/polling-triggers`, `ScheduleTriggers` at `/schedule-triggers`, `Orchestrator` at `/orchestrator`, and `Operator` with its request and response types at `/operator`. `Orchestrator.run(instance)` runs both trigger streams; `Operator` provides run and Board observation, structured protocol transcript pages, label-backed Board moves, approve/retry/cancel, and database-backed Loop pause/unpause. Transcript payloads, Attempt brains/outcomes, and items needing attention remain typed data. Captured executor defects appear as `DefectFailure` with a safe message; original causes stay out of operator responses. Consuming apps own their wording and presentation. `OperatorObservation` exposes the same read-only projection without constructing execution services. The latest polling and schedule failures remain visible through `Operator.overview(instance)` after their sibling work continues. Concurrent overview reads with the same durable revision share one projection computation.

`Operator.overview(instance)` joins the latest 500 polled Items into Task cards in each repository's authored lanes. Explicit same-repository issue closing links and saved Run PR results join an issue to a PR. Repositories without configured lanes receive proposals from the repository label catalog, including unused labels and repositories with no Items. Items that match no source appear in a read-only `Unmapped` lane, and label matches take precedence over state sources. Each card retains every saved Run on its member Items, oldest first. The newest open Run determines the current Item; between Runs an open PR, then the latest settled PR, takes over from the issue. Its labels and state determine the lane, so removing the issue's trigger label does not strand a task whose PR is under review. See ADR 0024. A malformed Item projection is quarantined and reported in the Board and needs-you strip while valid siblings remain visible. Failed declared-label creation also appears as a repository preflight finding without blocking trigger work.

`Operator.moveBoardItem(instance, move)` accepts authored label-backed lanes, adds the target lane labels, and removes only labels owned by the authored map. Proposed lanes are read-only; direct move requests return `BoardLaneReadOnlyError`. GitHub labels outside the authored map remain unchanged even when the Item snapshot is stale or its label connection is truncated. Configure `repos[].lanes` in `usine.yaml` and restart the orchestrator to enable moves; see the [lane configuration example](../config/README.md). Every attempted GitHub label write queues an Item Hint, including an uncertain or partially applied failure: the running poller fetches the current GitHub snapshot, projects its Board position, and evaluates its Loops immediately unless GitHub has requested backoff.

`Operator.detail` accepts distinct cold, live-tail, and earlier-page requests. A cold read keeps the newest 500 rows per Attempt and returns an earlier cursor for every truncated Attempt; clients can page each cursor backward until the entire transcript is reachable without ballooning the first drawer response. A live-tail response returns at most 500 rows across the Run and advances its cursor from the last returned row.

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

`PollingTriggers.poll(instance)` performs one cycle; `PollingTriggers.run(instance)` repeats cycles using the instance's factory-wide `poll_interval` and waits longer when GitHub reports rate-limit pressure. Per-repository failures are isolated and reported on the cycle — one failing repository never stops its siblings. `PollingTriggers.hint(repository, item)` queues a bounded, coalesced self-write nudge. The running poller serializes Hint snapshots with regular cycles and uses the same projection and Event dedup path. Hints leave REST cursors, the normal conditional-poll cadence, and the last complete cycle’s findings intact; dropped or failed Hints are repaired by the polling backstop. GitHub request backoff, including deadlines reported by a failed writer, also delays Hint fetches. The original write outcome still reaches its caller.

Each cycle first refreshes the complete label catalog in every managed repository and reconciles the factory-wide declarations from `usine.yaml`. Usine creates missing labels before change detection or Item evaluation. It leaves existing labels untouched and logs color or description drift. Creation failures become preflight findings, and the cycle continues into triggers. The updated catalog remains the Board's source for lane colors.

After label preflight, the cycle asks `GitHubPolling` for changed items, fetches one payload snapshot per changed item, updates the durable Item projection, and evaluates each stream-matching loop's CEL `if:` expression against that snapshot. A match renders every `{{ CEL expression }}` in the loop body, resolves the named agent and effective parent model, then stores that immutable execution context with the Event. The Event identity covers the loop, canonical repository, item number, and timestamp-free content hash. An unmatch revokes pending or approval-waiting work for that loop and item. Repositories without matching loops are still polled for their Board projection.

Polling cursors live in the engine's `CursorStore`. When a loop starts watching a repository or its trigger expression changes, the orchestrator discards that repository's efficiency cursor and performs a cold poll, while the permanent Event ledger absorbs repeated state.

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

The Event key covers the loop, canonical repository, and scheduled time. An in-memory fired-tick memory skips already-submitted boundaries, so calling `tick` repeatedly costs nothing, and waking after downtime (or a restart, which clears that memory) emits only the latest missed Tick. A cron whose boundaries cannot be computed at an instant — effect's Cron can fail inside a DST spring-forward gap — fails only that schedule for that cycle and is reported on the returned `ScheduleCycle`. The repository is the schedule stream's Item, so a later Tick follows the same supersede rules as issue and pull-request state. Schedule Runs go through the unchanged `RunEngine`, approval gate, worker scheduler, executor, and agent layer. Because they have no GitHub issue or pull request to comment on, their blocking moments remain UI-only.

`ScheduleTriggers.run(instance)` evaluates once at startup for catch-up, then sleeps until the earliest next Tick. Its layer requires `RunEngine`, `ConfigParser`, and `ExpressionEngine`.

## Worker scheduling

`@usine/orchestrator/scheduler` exports the platform-free `stepExecutorLayer`. `stepExecutorLayer(config, brains)` accepts the roster’s `BrainSpec` values. At startup it verifies every configured worker against that roster, creates one capacity slot per `max_concurrent_attempts`, and assigns slots by Event receipt time. Runs stay pending while every slot is occupied. Each Attempt receives the configured `max_children` child-session budget. The layer rejects worker kinds that its supplied executor cannot run. Worker capability failures during preparation become non-retryable `AgentFailure` outcomes, like unavailable model credentials.

`@usine/orchestrator/local` composes the scheduler with the Node local executor and the engine's local SQLite adapter. It requires a caller-owned `CredentialProvider`; use `gitHubCredentialLayer` with `@usine/github`, or supply another provider that mints one repository credential per Attempt.

```ts
import { layer as localLayer } from "@usine/orchestrator/local"

const EngineLive = localLayer(instanceDirectory, config, brains, {
  repositoryUrl: (repository) => `https://github.com/${repository}.git`,
})
```

Provide `CredentialProvider` to `EngineLive`, then request `RunEngine` from the resulting Effect layer. The local composition caches repositories under `<instance>/.usine/workers/<worker>/repos` and removes Attempt worktrees after completion or cancellation.

For the whole local application, `runtimeLayer(instanceDirectory, instance, options)` additionally composes GitHub polling, schedule triggers, CEL parsing, `Orchestrator`, and `Operator`. It derives worker preflight requirements from `instance.agents` and requires only `GitHubCredentials`; the server or another host owns how those credentials are loaded. `operatorObservationLayer(instanceDirectory)` is the read-only Node composition for setup and maintenance surfaces: it reads durable Runs and Loop runtime state while trigger execution remains idle.

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

The composition sets the GitHub integration grant to five minutes beyond `max_attempt_minutes` when that setting exists, and to the executor's default window otherwise. Pass `credentialGrantMinutes` to use another bounded window. When `max_attempt_minutes` is set, the scheduler bounds every launch at it: a hung run host or dead link is interrupted through the normal cancel handshake and reported as a typed infrastructure failure before its credential grant lapses.

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

The agent contract test also starts the local worker and production run host. The Pi parent delegates to Claude Code, which reads the issue with `gh` and posts one signed comment as the App bot. Build the workspace first, provide working Pi and Claude credentials in the worker user's home directory, then run:

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

The orchestrator requires run-host Attempt channel protocol v6 for saved harness session metadata. Upgrade both together; worker preflight rejects a version mismatch. Stored v3–v5 transcripts remain readable.

`Operator.resolveFailure(runId, attemptId)` clears attention for the current failed Attempt. The operator API exposes it as `POST /api/runs/:runId/resolve-failure` with `{ "attemptId": "..." }`. Resolved failures remain in Run history with retry available. Needs you, Project status, and Board attention reflect resolution; a later failed Attempt requests attention again.
