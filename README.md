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
| [`@usine/agents`](./packages/agents)             | Claude Code, Codex, and Pi child backends, Attempt prompts, and harness preflight                                               |
| [`@usine/durable`](./packages/durable)           | Each Attempt's Pi parent as a pi-durable task in the orchestrator, resumed after a restart                                      |
| [`@usine/executor`](./packages/executor)         | Scoped Attempt resources, with local and exe.dev executors                                                            |
| [`@usine/orchestrator`](./packages/orchestrator) | The embeddable composition: the full engine as an Effect layer, startable in-process                                            |
| [`@usine/server`](./apps/server)                 | Thin `usine up` CLI that runs the orchestrator in the foreground and serves the local web UI                                   |
| `apps/web`                                       | The web UI (never published)                                                                                                    |

`effect` is exact-pinned once, in the [workspace catalog](./pnpm-workspace.yaml), and declared as a peer dependency by the published libraries: consumers supply `effect` themselves, so there is one Effect runtime per tree.

## Run a factory

From an instance folder containing `usine.yaml`, `agents/`, and `loops/`:

```sh
usine up
```

The foreground process prints the local UI address. If GitHub App credentials are not available, the UI stays up in setup mode while polling and scheduling remain idle. Supply `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, or put the equivalent `app_id` and `private_key` fields in a mode-0600 `.usine/github-app.json` file.

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
