# @usine/orchestrator

`@usine/orchestrator` connects loaded loop files to GitHub polling and the durable run engine. `PollingTriggers.poll(instance)` performs one cycle; `PollingTriggers.run(instance)` repeats cycles using the instance's factory-wide `poll_interval` and waits longer when GitHub reports rate-limit pressure.

Each cycle prunes repositories through loop selectors, asks `GitHubPolling` for changed items, fetches one payload snapshot per item, and evaluates each stream-matching loop's CEL `if:` expression against that snapshot. A match stores the snapshot in an Event whose durable identity covers the loop, canonical repository, item number, and timestamp-free content hash. An unmatch revokes pending or approval-waiting work for that loop and item.

Polling cursors live in the engine's `CursorStore`. When a loop starts watching a repository or its trigger expression changes, the orchestrator discards that repository's efficiency cursor and performs a cold poll, while the permanent Event ledger absorbs repeated state.

## Compose the layer

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

## Live GitHub check

The opt-in integration test needs a disposable issue in a repository covered by the configured GitHub App. It creates a uniquely named repository label, applies it to the issue, checks the resulting Event and restart deduplication, then deletes the label.

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
pnpm --filter @usine/orchestrator test:integration
```

Everything here is 0.x, so APIs can change between minor releases.
