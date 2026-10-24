# usine

usine runs coding agents (Claude Code, Codex, Pi) on GitHub issues and pull requests across many repos. Loops, defined as files in git, pair a trigger with an agent run. One headless orchestrator runs them and serves a web UI.

Glossary: [CONTEXT.md](./CONTEXT.md). Decision records: [docs/adr/](./docs/adr). This pnpm and turbo monorepo publishes the engine as blocks: independently versioned 0.x packages under the `@usine` npm scope.

## Layout

| Package                                          | Contents                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [`@usine/core`](./packages/core)                 | Domain model: events, runs, steps, attempts, run states, failures     |
| [`@usine/expression`](./packages/expression)     | CEL expression checking and evaluation                                |
| [`@usine/config`](./packages/config)             | Parses, validates, and edits `usine.yaml`, loop files, and agent files |
| [`@usine/github`](./packages/github)             | Polling, GraphQL payload fetchers, GitHub App auth and tokens         |
| [`@usine/engine`](./packages/engine)             | Event ledger, dedup, supersede, revoke, run scheduling, SQLite store  |
| [`@usine/agents`](./packages/agents)             | Claude Code, Codex, and Pi child backends, prompts, harness preflight |
| [`@usine/durable`](./packages/durable)           | Each attempt's Pi parent as a pi-durable task, resumed after restarts |
| [`@usine/executor`](./packages/executor)         | Attempt resources on local, exe.dev, and SSH workers                  |
| [`@usine/gateway`](./packages/gateway)           | GitHub and LLM proxies, allowlisted egress, admin API for private workers |
| [`@usine/orchestrator`](./packages/orchestrator) | The full engine as an Effect layer you can start in-process           |
| [`@usine/server`](./apps/server)                 | The `usine up` CLI, which runs the orchestrator and serves the web UI |
| `apps/web`                                       | Web UI (not published)                                                |
| [`apps/docs`](./apps/docs)                       | Astro Starlight site at [docs.usine.dev](https://docs.usine.dev)      |

Published packages take `effect`, pinned in the [workspace catalog](./pnpm-workspace.yaml), as a peer dependency, so your tree has one Effect runtime.

## Run a factory

In an instance folder with `usine.yaml`, `agents/`, and `loops/`, run:

```sh
usine up
```

It prints the local UI address. Without GitHub App credentials, the UI runs in setup mode, and polling and schedules stay idle. Set `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, or put `app_id` and `private_key` in `.usine/github-app.json` with mode `0600`.

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

[Changesets](https://github.com/changesets/changesets) handles releases: add a changeset for each user-visible change; CI opens a release PR, and merging it publishes. 0.x APIs change without notice.

If the `usine` npm org is unavailable, ADR 0012 moves every package to the `@usine-dev` scope. The unscoped `usine` name belongs to an unrelated, unmaintained package.

## License

usine is licensed under the [GNU Affero General Public License v3.0](./LICENSE). You can run it, change it, and embed the `@usine/*` packages in your own software. If you offer usine, or software that includes it, to others over a network, you have to publish the complete source of that software under the same license. Versions published before 2026-10-24 remain under the MIT license.
