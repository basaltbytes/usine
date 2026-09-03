# @usine/orchestrator

`@usine/orchestrator` connects loaded loop files to GitHub polling, the durable run engine, and configured workers for [usine](https://github.com/basaltbytes/usine).

Its platform-free root exports the complete embeddable application surface: `PollingTriggers`, `ScheduleTriggers`, `Orchestrator`, and `Operator`. `Orchestrator.run(instance)` runs both trigger streams; `Operator` provides run and Board observation, structured protocol transcript pages, label-backed Board moves, approve/retry/cancel, and database-backed Loop pause/unpause. Transcript payloads, Attempt brains/outcomes, and items needing attention remain typed data; consuming apps own their wording and presentation. `OperatorObservation` exposes the same read-only projection without constructing execution services. The latest polling and schedule failures remain visible through `Operator.overview(instance)` after their sibling work continues. Concurrent overview reads with the same durable revision share one projection computation.

`Operator.overview(instance)` groups the latest polled Items into each repository's authored lanes. Repositories without configured lanes receive proposals from the repository label catalog, including unused labels and repositories with no Items. Items that match no source appear in a read-only `Unmapped` lane, and label matches take precedence over state sources. Each card references its newest recorded Run for the same Item. A malformed Item projection is quarantined and reported in the Board and needs-you strip while valid siblings remain visible.

`Operator.moveBoardItem(instance, move)` adds the target lane labels and removes only labels owned by the lane map. GitHub labels outside that map remain unchanged even when the Item snapshot is stale or its label connection is truncated. The normal polling cycle evaluates the resulting trigger state.

`Operator.detail` accepts distinct cold, live-tail, and earlier-page requests. A cold read keeps the newest 500 rows per Attempt and returns an earlier cursor for every truncated Attempt; clients can page each cursor backward until the entire transcript is reachable without ballooning the first drawer response. A live-tail response returns at most 500 rows across the Run and advances its cursor from the last returned row.

## Polling triggers

`PollingTriggers.poll(instance)` performs one cycle; `PollingTriggers.run(instance)` repeats cycles using the instance's factory-wide `poll_interval` and waits longer when GitHub reports rate-limit pressure. Per-repository failures are isolated and reported on the cycle — one failing repository never stops its siblings.

Each cycle asks `GitHubPolling` for changed items and the complete label catalog in every managed repository. It stores the catalog, fetches one payload snapshot per changed item, updates the durable Item projection, and evaluates each stream-matching loop's CEL `if:` expression against that snapshot. A match renders every `{{ CEL expression }}` in the loop body, resolves the named agent and effective parent model, then stores that immutable execution context with the Event. The Event identity covers the loop, canonical repository, item number, and timestamp-free content hash. An unmatch revokes pending or approval-waiting work for that loop and item. Repositories without matching loops are still polled for their Board projection.

Polling cursors live in the engine's `CursorStore`. When a loop starts watching a repository or its trigger expression changes, the orchestrator discards that repository's efficiency cursor and performs a cold poll, while the permanent Event ledger absorbs repeated state.

`PollingTriggers.layer` requires `CursorStore`, `LoopControl`, `RunEngine`, `ConfigParser`, `ExpressionEngine`, and `GitHubPolling`. The engine's local SQLite layer supplies the engine services:

```ts
import { Layer } from "effect"
import { PollingTriggers } from "@usine/orchestrator"

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

The platform-free root entry exports `stepExecutorLayer`. At startup it verifies every configured worker, creates one capacity slot per `max_concurrent_attempts`, and assigns slots by Event receipt time. Runs stay pending while every slot is occupied. Each Attempt receives the configured `max_children` child-session budget. The layer rejects worker kinds that its supplied executor cannot run.

`@usine/orchestrator/local` composes the scheduler with the Node local executor and the engine's local SQLite adapter. It requires a caller-owned `CredentialProvider`; use `gitHubCredentialLayer` with `@usine/github`, or supply another provider that mints one repository credential per Attempt.

```ts
import { layer as localLayer } from "@usine/orchestrator/local"

const EngineLive = localLayer(instanceDirectory, config, {
  repositoryUrl: (repository) => `https://github.com/${repository}.git`,
})
```

Provide `CredentialProvider` to `EngineLive`, then request `RunEngine` from the resulting Effect layer. The local composition caches repositories under `<instance>/.usine/workers/<worker>/repos` and removes Attempt worktrees after completion or cancellation.

For the whole local application, `runtimeLayer(instanceDirectory, instance, options)` additionally composes GitHub polling, schedule triggers, CEL parsing, `Orchestrator`, and `Operator`. It requires only `GitHubCredentials`; the server or another host owns how those credentials are loaded. `operatorObservationLayer(instanceDirectory)` is the read-only Node composition for setup and maintenance surfaces: it reads durable Runs and Loop runtime state while trigger execution remains idle.

For an exe.dev Worker, use the `@usine/orchestrator/exe-dev` composition. It keeps the engine and SQLite runtime local while the unchanged Worker contract runs on the named VM:

```ts
import { Repository } from "@usine/core"
import { GitHubIntegration, HarnessLoginCheck, IntegrationName } from "@usine/executor/exe-dev"
import { layer as exeDevLayer } from "@usine/orchestrator/exe-dev"

const EngineLive = exeDevLayer(instanceDirectory, config, {
  githubIntegrations: [
    new GitHubIntegration({
      repository: Repository.Name.make("acme/widget"),
      name: IntegrationName.make("usine-acme-widget"),
    }),
  ],
  harnessLoginChecks: [
    new HarnessLoginCheck({
      harness: "codex",
      command: "codex",
      args: ["login", "status"],
    }),
  ],
})
```

The composition sets the GitHub integration grant to five minutes beyond `max_attempt_minutes`. Pass `credentialGrantMinutes` to use another bounded window. The scheduler also bounds every launch at `max_attempt_minutes`: a hung run host or dead link is interrupted through the normal cancel handshake and reported as a typed infrastructure failure before its credential grant lapses.

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
