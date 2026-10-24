# The engine is published as blocks from a pnpm and turbo monorepo

usine is a monorepo in the manywalls/atoly shape (pnpm workspaces, turbo, `apps/` and `packages/`, a shared tsconfig package, changesets, knip, renovate). Its engine blocks are **published npm packages from day one**, at 0.x, under `@usine`: claim the npm org first, with `@usine-dev` (matching the domain) as fallback, since a dead package has the bare `usine` name. Nine packages publish, split along the map's seams:

- `core`: the domain model (event, run, step, attempt), typed errors, ids, and the versioned envelope schema
- `expression`: CEL check and eval seam
- `loop-file`: loop and agent schemas, frontmatter validation, the targeted YAML-AST writer, and the instance repo loader
- `github`: change detection, per-stream GraphQL slice fetchers, App auth, and token minting
- `engine`: event ledger, dedup, supersede, revoke, scheduling, durable-execution seam, SQLite store
- `agents`: Pi parent adapter, subagents extension, roster, brain specs
- `executor`: the scoped worker contract and local and exe.dev executors
- `orchestrator`: embeddable composition
- `run-host`: the worker-side one-shot CLI, published since workers install it and preflight checks its version

`orchestrator` is a **library** that exports the full Effect-layer composition and starts in-process; `apps/server` is a thin CLI running it headless and serving the internal `apps/web`. Packages version **independently** with changesets; orchestrator and run-host compatibility follows the envelope schema version ([ADR 0006](./0006-executor-contract-run-host-attempt-channel.md)). `effect` and the `@effect/*` packages each block uses are **peerDependencies**, exact-pinned once at the root. v1 commits to publish discipline (exports maps, no cross-package deep imports, a README each), not to API stability, docs, or support: 0.x is honest while APIs change.

## Considered options

- **Internal-only packages**: no publish machinery; contradicts the assemble-your-own-factory goal when changesets makes publishing nearly free.
- **Publishable shape, publish later**: the same discipline, npm deferred until APIs settle; "later" never comes, and the scope stays unclaimed.
- **Coarser split (4 packages)**: less version surface, but third parties take the whole engine or nothing, hiding the map's seams.
- **Finer split** (the YAML writer, the Pi subagents extension, GitHub App auth as packages): deferred until an outside consumer appears. Each stays a module, extractable later.
- **App-only orchestrator**: simpler now, but a desktop all-in-one would then need a library carved from an app under pressure.
- **Lockstep versioning** ("usine 0.4" everywhere): duplicates the envelope version's guarantee, at the cost of empty bumps.

## Consequences

- **Revised 2026-08-21** (operator direction, implementing [#24](https://github.com/basaltbytes/usine/issues/24)): `loop-file` is renamed **`config`** for what it does (parse, validate, and rewrite `usine.yaml`, `loops/*.md`, `agents/*.md`), not one file kind. Contents and split are unchanged.
- The post-v1 desktop goal stays additive: a shell wraps the served web UI, or an all-in-one app embeds `@usine/orchestrator`, with no new seam.
- **How `apps/server` is distributed** (npx, binary, container) is the distribution decision's. **Settled by [ADR 0019](./0019-npm-instance-pinned-first-run-onboarding.md)**: `@usine/server` (bin `usine`, web build bundled), exact-pinned per instance by `create-usine`.
- Claiming the npm `usine` org comes first; if it's taken, everything uses `@usine-dev`.
- `core` has the envelope schema, so `run-host` needs no orchestrator-side package.
- Consumers supply a compatible `effect`: peer dependencies trade install convenience for one runtime per tree.
- **Revised 2026-09-05**: public subpaths name capabilities, not source layout (`/polling` maps to `polling/polling.ts`; `/operator` provides operator contracts and implementation). Entry modules pick same-package exports explicitly, so helpers don't become public by accident; workflow commands and content-hash bookkeeping stay internal. Consumers import domain definitions from the defining package, not aliases. Core identities are defined beside their records and operations, with domain folders (`run/`, `step/`, `attempt/`, `agent/`). Node adapters keep separate entry points, including composable Pi parent and harness child layers and the assembled runtime.
- **Amended 2026-09-01** (implementing [#31](https://github.com/basaltbytes/usine/issues/31)): the peer rule covers published **libraries**. `@usine/server` is an application (bin `usine`, installed per instance by `create-usine`), so `effect` and `@effect/platform-node` are ordinary dependencies: an app runs from a plain install.
- **Amended 2026-10-11** ([#176](https://github.com/basaltbytes/usine/issues/176)): `run-host` is deleted, and `durable` (the Pi parent as a pi-durable task) publishes instead. Workers only run children, so they get no usine package, and preflight checks no usine version there. `agents` keeps child backends, prompts, and preflight; its Pi parent layer and assembled runtime went with the run host, their only caller. `core` keeps the envelope schema, written by the durable relay and read by the transcript store.
- **Amended 2026-10-18** ([#310](https://github.com/basaltbytes/usine/issues/310), [#233](https://github.com/basaltbytes/usine/issues/233)): `gateway` publishes too. The executor imports `@usine/gateway/admin`, so the published executor needs it, and gateway hosts install from npm, not checkout tarballs. It has no secrets; the gateway reads them from the environment. Every published package that depends on `@effect/platform-node` also depends on `@effect/platform-node-shared` at the catalog version, since `@effect/platform-node`'s caret range would resolve to a release that needs a newer `effect` than the catalog pins.
