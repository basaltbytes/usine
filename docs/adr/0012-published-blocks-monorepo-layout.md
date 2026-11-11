# The engine is published as packages from a pnpm and Turborepo monorepo

usine is a pnpm and Turborepo monorepo, with applications in `apps/` and packages in `packages/`. The engine's parts publish to npm under `@usine` at 0.x, and Changesets versions each package on its own. `@usine/server` and `create-usine` release together, because the scaffolder installs the server version that it was built with. `apps/web` is private and ships inside `@usine/server`.

`@usine/orchestrator` is a library that exports the whole composition as an Effect layer, so another host can embed the engine; `apps/server` is a thin CLI over it. Libraries take `effect` as a peer dependency, pinned once in the workspace catalog, so a consumer's tree has one Effect runtime; applications depend on it directly. Public subpaths name capabilities, and Node adapters have their own subpaths.

Publishing from the start keeps the package seams honest and lets others assemble their own factory from the parts.

## Considered options

- **Internal packages only**: no reuse outside the repository.
- **Four coarse packages**: a consumer takes the whole engine or nothing.
- **One version for every package**: empty releases of unchanged packages.
- **The orchestrator as an application only**: an embedding host would need a library carved out later.
