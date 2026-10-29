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

`usine up` runs in the foreground. To run it in the background, with its output in `.usine/usine.log`, and to manage it from the instance folder:

```sh
usine up --detach   # start in the background
usine status        # whether it runs, its PID, address, version, uptime, and open runs
usine restart       # stop after the drain, and start again in the background
usine stop          # stop after the drain
usine upgrade       # move the @usine/server pin in package.json, install, and restart
```

See the [CLI reference](https://docs.usine.dev/reference/configuration/cli/) for the flags.

## Development

```sh
pnpm install
pnpm build     # turbo: tsc -b per package
pnpm test      # turbo: vitest per package
pnpm check     # turbo: typecheck including tests
pnpm lint      # oxlint
pnpm format    # oxfmt
```

Tests import other workspace packages from their `dist`, and the `@usine/server` tests also run its own `dist/main.js`. turbo builds both before it tests. To test one package, run `pnpm turbo run test --filter <package>`; `pnpm --filter <package> test` skips the builds, so it fails or tests stale code until you run `pnpm build`.

## Releases

[Changesets](https://github.com/changesets/changesets) handles releases: add a changeset for each user-visible change. CI opens a **Version Packages** PR. Merging it stages the changed versions for npm's `latest` dist-tag; an npm maintainer approves them before they become installable. 0.x APIs change without notice.

The repository pins pnpm 11.20.0, which supports [`pnpm stage`](https://pnpm.io/11.x/cli/stage) and OIDC trusted publishing. The `release` job uses `pnpm stage publish -r --tag latest --no-git-checks`. The `next` job continues to publish snapshots directly with `pnpm -r publish --tag next --no-git-checks`, so keep **Allow npm publish** enabled on every `@usine` trusted publisher. Both jobs use `release.yml`, the workflow registered with npm.

### Approval

After the Version Packages release job succeeds, use a local npm account with publish access and 2FA enabled:

```sh
pnpm stage list
pnpm stage view <stage-id>
pnpm stage approve <stage-id> --otp <code>
```

Review the package name, version, and source commit before approving each stage ID from the release job's output. Approve workspace dependencies before their dependents. You can also review and approve versions in the **Staged Packages** tab on npmjs.com. Approve every package in the release before continuing.

Check that the new version is public and that `latest` points to it. For example, for `@usine/core`:

```sh
curl --fail --silent --show-error https://registry.npmjs.org/@usine%2fcore | jq '."dist-tags".latest'
pnpm view @usine/core@<version> version
```

Rerun only the `release` job of the original Version Packages workflow run. Use `gh run view <run-id> --json jobs` to find its database ID, then:

```sh
gh run rerun <run-id> --job <release-job-id>
gh run watch <run-id> --exit-status
```

The rerun skips versions that npm already exposes. The tag step checks every publishable workspace version against the public npm registry before running `changeset git-tag`; Changesets then pushes the tags and creates GitHub releases. A pending approval skips all tags and releases, and a registry error fails the job. Rerunning the original job preserves the source commit. GitHub also reruns dependent jobs; `next` skips snapshot versions that are already public. Do not run `changeset git-tag` directly or dispatch a new release at a newer commit to finalize an older release.

If a release fails after staging some packages, inspect its stage IDs and approve the valid artifacts before retrying that job. Use `pnpm stage reject <stage-id> --otp <code>` for artifacts that need replacement. The retry stages any versions that are still absent from the public registry; repeat approval and rerun until all versions are public and the GitHub releases exist.

If the `usine` npm org is unavailable, ADR 0012 moves every package to the `@usine-dev` scope. The unscoped `usine` name belongs to an unrelated, unmaintained package.

## License

usine is licensed under the [GNU Affero General Public License v3.0](./LICENSE). You can run it, change it, and embed the `@usine/*` packages in your own software. If you offer usine, or software that includes it, to others over a network, you have to publish the complete source of that software under the same license. Versions published before 2026-10-24 remain under the MIT license.
