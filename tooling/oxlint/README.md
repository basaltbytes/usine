# @usine/oxlint

The root `.oxlintrc.json` loads this package's local rules through `plugin.ts`.

`usine/web-import-direction` checks imports, re-exports, type queries, and dynamic imports in `apps/web/src`. Routes can import features. A feature can import its own modules and shared components, hooks, or libraries. Shared modules cannot import features or routes. Imports outside the current folder use `~/`. Colocated tests can compose features to exercise shared components in a screen.

Application modules use named exports, enforced by `import/no-default-export`. Vendored UI and AI Elements components keep their upstream export conventions.

Run `pnpm --filter @usine/oxlint test` to check these rules through the oxlint CLI.
