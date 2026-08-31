# @usine/orchestrator

`@usine/orchestrator` connects loaded loop files to GitHub polling, the durable run engine, and configured workers for [usine](https://github.com/basaltbytes/usine).

## Polling triggers

`PollingTriggers.poll(instance)` performs one cycle; `PollingTriggers.run(instance)` repeats cycles using the instance's factory-wide `poll_interval` and waits longer when GitHub reports rate-limit pressure. Per-repository failures are isolated and reported on the cycle — one failing repository never stops its siblings.

Each cycle prunes repositories through loop selectors, asks `GitHubPolling` for changed items, fetches one payload snapshot per item, and evaluates each stream-matching loop's CEL `if:` expression against that snapshot. A match stores the snapshot in an Event whose durable identity covers the loop, canonical repository, item number, and timestamp-free content hash. An unmatch revokes pending or approval-waiting work for that loop and item.

Polling cursors live in the engine's `CursorStore`. When a loop starts watching a repository or its trigger expression changes, the orchestrator discards that repository's efficiency cursor and performs a cold poll, while the permanent Event ledger absorbs repeated state.

`PollingTriggers.layer` requires `CursorStore`, `RunEngine`, `ExpressionEngine`, and `GitHubPolling`. The engine's local SQLite layer supplies both engine services:

```ts
import { Layer } from "effect"
import { PollingTriggers } from "@usine/orchestrator"

const dependencies = Layer.mergeAll(engineLayer, expressionLayer, githubPollingLayer)

export const triggersLayer = PollingTriggers.layer.pipe(
  Layer.provide(dependencies),
)
```

Call `poll` when another scheduler owns timing. Use `run` for the built-in endless polling loop.

## Schedule triggers

`ScheduleTriggers.tick(instance)` evaluates the most recent due Tick for every `on: schedule` loop and fans it out to the repositories selected by that loop. Each selected repository receives one Event whose payload is `item.tick = { scheduledAt, cron, tz }`; `scheduledAt` is the time the Tick was due, while the Event's `receivedAt` records when the orchestrator observed it.

The Event key covers the loop, canonical repository, and scheduled time. Calling `tick` repeatedly is therefore harmless, and waking after downtime emits only the latest missed Tick. The repository is the schedule stream's Item, so a later Tick follows the same supersede rules as issue and pull-request state. Schedule Runs go through the unchanged `RunEngine`, approval gate, worker scheduler, executor, and agent layer. Because they have no GitHub issue or pull request to comment on, their blocking moments remain UI-only.

`ScheduleTriggers.run(instance)` evaluates once at startup for catch-up, then sleeps until the earliest next Tick. Its layer requires `RunEngine` and `ExpressionEngine`.

## Worker scheduling

The platform-free root entry exports `stepExecutorLayer`. At startup it verifies every configured worker, creates one capacity slot per `max_concurrent_attempts`, and assigns slots by Event receipt time. Runs stay pending while every slot is occupied. The layer rejects worker kinds that its supplied executor cannot run.

`@usine/orchestrator/local` composes the scheduler with the Node local executor and the engine's local SQLite adapter. It requires a caller-owned `CredentialProvider`; use `gitHubCredentialLayer` with `@usine/github`, or supply another provider that mints one repository credential per Attempt.

```ts
import { layer as localLayer } from "@usine/orchestrator/local"

const EngineLive = localLayer(instanceDirectory, config, {
  repositoryUrl: (repository) => `https://github.com/${repository}.git`,
})
```

Provide `CredentialProvider` to `EngineLive`, then request `RunEngine` from the resulting Effect layer. The local composition caches repositories under `<instance>/.usine/workers/<worker>/repos` and removes Attempt worktrees after completion or cancellation.

## Live GitHub check

The opt-in integration test needs a disposable issue in a repository covered by the configured GitHub App. It creates a uniquely named repository label, applies it to the issue, checks the resulting Event and restart deduplication, then deletes the label.

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
pnpm --filter @usine/orchestrator test:integration
```

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.
