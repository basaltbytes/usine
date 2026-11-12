# Contributing

Issues and pull requests are in [GitHub Issues](https://github.com/basaltbytes/usine/issues). Coding and writing conventions are in [AGENTS.md](./AGENTS.md). Add a [changeset](https://github.com/changesets/changesets) for each user-visible change; [docs/releasing.md](./docs/releasing.md) describes the release procedure.

## Development

```sh
pnpm install
pnpm build     # turbo: tsc -b per package
pnpm test      # turbo: vitest per package
pnpm check     # typecheck including tests, and check the committed OpenAPI document
pnpm lint      # oxlint
pnpm format    # oxfmt
```

The root build, check, and test commands serialize Turborepo tasks to fit attempt containers with at least 6 GiB of memory. Web Vitest uses at most two workers.

Tests import other workspace packages from their `dist`, and the `@usine/server` tests also run its own `dist/main.js`. turbo builds both before it tests. To test one package, run `pnpm turbo run test --filter <package>`; `pnpm --filter <package> test` skips the builds, so it fails or tests stale code until you run `pnpm build`.

The script tests invoke `corepack pnpm` to use the version pinned in `package.json`. Enable Corepack on the test machine; the global pnpm version does not affect these subprocesses.

Published libraries declare `effect` as a peer dependency at the version in the `catalog` of `pnpm-workspace.yaml`. A package that depends on `@effect/platform-node` also depends on `@effect/platform-node-shared` at the catalog version, because the caret range of `@effect/platform-node` can resolve to a release that needs a newer `effect`.

API contract changes require regenerating and staging `apps/docs/public/openapi.json` before `pnpm check`. See the [docs README](apps/docs/README.md#operator-http-api-reference) for generation commands.

SQLite storage fixtures use `tooling/test/sqlite.mts` to select writable `/dev/shm` on Linux when it is mounted as tmpfs. On other hosts, they use the OS temporary directory. Fixtures that execute binaries or Git hooks keep using the OS temporary directory because shared memory can be mounted with `noexec`.

Set `VITEST_MAX_WORKERS=1 pnpm test` to limit Vitest concurrency on a busy worker. Turbo forwards this variable and includes it in the test cache key. To repeat the tests without reading cached results, run `TURBO_CACHE=local:w pnpm test`.

CI runs static checks and root script tests alongside four package test groups: web, server, engine/orchestrator/durable, and the remaining packages. The `ci` check aggregates their results. Each group runs packages serially, with a 15-minute job limit and a 10-minute test limit. The web and server groups use the Playwright container matching their package version, with browsers and system dependencies preinstalled. The server group installs its CLI tools as root and runs tests as `pwuser` so permission checks run. Pull request pushes cancel earlier runs for the same branch; pushes to `main` finish independently. Turbo caches restore per group and Node version, and only `main` saves them.

The PR suite checks overview response size, task detail, and concurrent overview and desk reads. The fixed 500 ms read budget runs in a separate job on `main`. Local `pnpm test` includes both functional and latency tests. After building, run `pnpm --filter @usine/server exec vitest run --project=server` for the functional suite or `--project=latency` for the timing check.
