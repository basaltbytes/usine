# @usine/oxlint

The root `.oxlintrc.json` loads this package's local rules through `plugin.ts`.

`usine/web-import-direction` checks imports, re-exports, type queries, and dynamic imports in `apps/web/src`. Routes can import features. A feature can import its own modules and shared components, hooks, or libraries. Shared modules cannot import features or routes. Imports outside the current folder use `~/`. Colocated tests can compose features to exercise shared components in a screen.

Application modules use named exports, enforced by `import/no-default-export`. Vendored UI and AI Elements components keep their upstream export conventions.

`usine/no-native-title-tooltip`, `usine/no-outset-state-indicators`, `usine/no-raw-resize-observer`, and `usine/no-em-dash-copy` check the web UI in `apps/web/src`, next to `@shadcn/lint`. "How to add UI" in [`apps/web/README.md`](../../apps/web/README.md#how-to-add-ui) describes them. `no-outset-state-indicators` skips `components/ui/` and `components/ai-elements/`.

`usine/no-manual-memo` rejects React `useMemo`, `useCallback`, and `memo` calls, including aliased and namespace imports. `usine/no-unreasoned-effect` requires a disable comment explaining the external synchronization for each React `useEffect` and `useLayoutEffect`. `usine/require-react-disable-reason` checks their exclusions: use an explicit rule name in a next-line directive followed by `--` and a nonempty reason. The compiler coverage test in `apps/web/react-compiler.test.ts` independently checks source comments with the same parser, honoring `.oxlintrc.json` ignore patterns. It rejects blanket directives and attempts to disable the guard itself, including directives that can suppress lint diagnostics. Both rules cover registry components and resolve import bindings so unrelated or shadowed functions are unaffected.

Run `pnpm --filter @usine/oxlint test` to check these rules through the oxlint CLI.
