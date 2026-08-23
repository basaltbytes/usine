# usine

An agent-agnostic software factory: an engine where loops — trigger → agent-run automations authored as files in git — run against many repos from one headless orchestrator with a web UI.

The spec lives in [CONTEXT.md](./CONTEXT.md) (domain glossary) and [docs/adr/](./docs/adr) (decision records). This repository is a pnpm + turbo monorepo; the engine ships as independently versioned 0.x packages under the `@usine` npm scope, carved along the seams the spec drew.

## Layout

| Package                                          | What it is                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`@usine/core`](./packages/core)                 | Domain model: Event → Run → Step → Attempt, branded ids, the run state machine, the attempt-failure taxonomy                    |
| [`@usine/expression`](./packages/expression)     | CEL expression seam: check and evaluate selection expressions                                                                   |
| [`@usine/config`](./packages/config)             | Config file machinery: parse, validate, and surgically rewrite the instance repo's files (usine.yaml, loop files, agent files)  |
| [`@usine/github`](./packages/github)             | Polling change detection, per-stream GraphQL slice fetchers, GitHub App auth and token minting                                  |
| [`@usine/engine`](./packages/engine)             | Event ledger, dedup/supersede/revoke, run scheduling, durable-execution seam, SQLite store                                      |
| [`@usine/agents`](./packages/agents)             | Pi parent adapter, subagents extension, team roster and brain specs                                                             |
| [`@usine/executor`](./packages/executor)         | The five-operation worker contract, with local and exe.dev executors                                                            |
| [`@usine/orchestrator`](./packages/orchestrator) | The embeddable composition: the full engine as an Effect layer, startable in-process                                            |
| [`@usine/run-host`](./packages/run-host)         | The worker-side one-shot process that hosts a single attempt's agent session                                                    |
| `apps/server`                                    | Thin CLI that runs the orchestrator headless and serves the web UI (private for now; publishes as `@usine/server` per ADR 0019) |
| `apps/web`                                       | The web UI (never published)                                                                                                    |

`effect` is exact-pinned once, in the [workspace catalog](./pnpm-workspace.yaml), and declared as a peer dependency in every published block: consumers supply `effect` themselves, so there is one Effect runtime per tree.

## Development

```sh
pnpm install
pnpm build     # turbo: tsc -b per package
pnpm test      # turbo: vitest per package
pnpm check     # turbo: typecheck including tests
pnpm lint      # oxlint
pnpm format    # oxfmt
```

## Releases

Versioning and publishing run through [changesets](https://github.com/changesets/changesets): every user-visible change adds a changeset, CI opens a release PR, and merging it publishes the bumped packages. Everything is 0.x — APIs change without notice while the engine grows.

The packages publish under the npm `usine` org. If that org turns out to be taken, the recorded fallback is the `@usine-dev` scope (matching the domain), applied everywhere — the bare `usine` package name is squatted by an unrelated dead package (ADR 0012).
