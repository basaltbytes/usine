# @usine/engine

The durable run engine for [usine](https://github.com/basaltbytes/usine). It turns a synthetic Event into a Run with one named Step and a durable Attempt history.

The default adapter stores usine's Event ledger and Run projections beside Effect's workflow tables in `<instance>/.usine/runtime.sqlite`. Submitting the same dedup key joins the original Run, including after a restart.

## Runtime rules

- Approval-gated Runs wait for an approval Event before their first Attempt.
- Infrastructure failures retry automatically, with a cap of three Attempts. Agent and runaway failures wait for an operator retry.
- A newer Event supersedes a pending or waiting Run. A running Attempt finishes first, then the engine opens only the newest queued Event for that Item.
- Revoke stops pending and waiting Runs. Operator cancellation can also stop a running Attempt.
- The startup sweep rejoins open workflow executions. If the process stopped during an Attempt, the engine records that Attempt as an infrastructure failure and resumes as N+1.

## Composition

`layer` supplies local SQLite, Effect `SingleRunner`, workflow registration, and startup reconciliation. Provide a `StepExecutor` implementation at the composition root:

```ts
import { Effect, Layer } from "effect"
import { InstanceDirectory, RunEngine, StepExecutor, layer } from "@usine/engine"

const StepExecutorLive = Layer.succeed(StepExecutor)({
  execute: ({ event }) => Effect.succeed(`Handled ${event.id}`),
})

const EngineLive = layer(InstanceDirectory.make("/path/to/instance")).pipe(
  Layer.provide(StepExecutorLive),
)

const program = Effect.gen(function* () {
  const engine = yield* RunEngine
  // submit, approve, retry, cancel, revoke, inspect, or reconcile
})
```

`layerWithDatabase` accepts another SQLite-compatible database layer. That layer must provide both `RunDatabase` and the matching Effect `SqlClient`, preserving atomic transactions and keeping the run projections beside Effect's cluster tables. Cloudflare D1 is not supported by Drizzle RC.4 for this use yet because its Effect driver cannot execute the store's transactions.

The Drizzle schema is the source of truth for usine tables. After changing it, generate and review a migration with:

```sh
pnpm --filter @usine/engine db:generate --name <migration_name>
```

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.
