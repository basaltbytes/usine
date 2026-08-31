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

The composition sets the GitHub integration grant to five minutes beyond `max_attempt_minutes`. Pass `credentialGrantMinutes` to use another bounded window.

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

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.
