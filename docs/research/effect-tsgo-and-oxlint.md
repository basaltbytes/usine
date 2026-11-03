# Effect diagnostics: @effect/tsgo and the Effect Oxlint rules

Research date: 2026-11-03. Versions: `@effect/tsgo` 0.64.1, `typescript` 7.0.2, `effect` 4.0.6, `oxlint` 1.90.0, `oxlint-tsgolint` 7.0.2005. Sources: the Effect-TS/tsgo repository at tag `@effect/tsgo@0.64.1`, the Effect-TS/effect repository, npm registry metadata, and runs against this repository. Claims that were not checked by a run are marked unverified.

## Recommendation

- Replace `@effect/language-service` with `@effect/tsgo` (closes #913). Run the Effect diagnostics through the Effect-patched `tsc` in each package's `check` task, so CI, turbo caching, and the editor read one configuration: the plugin block in `tooling/tsconfig/base.json`.
- Configure every diagnostic at its target severity. 134 of the 140 diagnostics that apply to Effect v4 are at `error`; 6 are `off` for the reasons in [Target configuration](#target-configuration). Two path overrides turn off rules whose premise doesn't hold in tests and in the React app.
- Land the configuration without blocking CI through a per-package baseline (`effect-baseline.json`) that records a count per file and rule and can only shrink. `pnpm check` fails on any new violation and on any baseline that differs from the current counts. A pull request step fails when any count rose against the base branch.
- The Effect Oxlint rules are the same 146 diagnostics, built from the same Go code, exposed through a patched Oxlint binding. Don't gate on both: every violation would be reported twice. Use the Oxlint front end as the codemod for the 60 rules with safe, mechanical autofixes (`pnpm effect:fix`), which clears 5,375 of today's violations.
- Drop the custom `usine/no-instanceof-tagged-error` rule planned in #910. `instanceOfSchema` reports the same sites with type information, and its autofix rewrites them to `Schema.is`.

The prototype is on branch `worktree-agent-a5c09b2753db54b9a`. Today's gap is 9,335 violations in 736 files: about 3,240 in source and 6,100 in tests.

## What Effect-TS/tsgo is

Effect-TS/tsgo isn't a GitHub fork of typescript-go. It's a separate repository that pins upstream TypeScript-Go, tsrs, Oxlint, and oxlint-tsgolint commits, applies its own patch sets (`_patches/typescript-go`, `_patches/oxlint`, `_patches/tsgolint`, `_patches/tsrs`), and adds the Effect language service written in Go. The README calls it "a superset of the official TypeScript-Go": all compiler behaviour plus Effect diagnostics, quick fixes, refactors, and completions. [README](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/README.md), [upstream.json](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/_packages/tsgo/upstream.json)

| Fact | Value | Source |
| --- | --- | --- |
| npm packages | `@effect/tsgo` (CLI `effect-tsgo`, MIT) plus one platform package per target: `@effect/tsgo-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`, `-linux-arm`, `-win32-x64`, `-win32-arm64` | `npm view @effect/tsgo` |
| Latest release | 0.64.1, published 2026-11-02. `main` already says 0.66.0. Releases ship every few days (0.54.0 on 2026-10-19 to 0.64.1). Pre-1.0. | npm `time`, GitHub releases |
| TypeScript tracked | `7.0.2` (tag `latest`), `7.1.0-beta`, `7.1.0-dev.20261101.1` | `upstream.json` at the tag |
| Oxlint tracked | 1.88.0, 1.89.0, 1.90.0, with oxlint-tsgolint 7.0.2004 or 7.0.2005 | same |
| Our versions | TypeScript 7.0.2 and Oxlint 1.90.0 are supported. With 7.0.2 installed, `effect-tsgo tsc` runs the build of that exact version. Effect 4.0.6 is detected as v4: v4-only rules such as `lazyEffect` and `preferBarrelImport` fire. | runs |
| License | MIT, copyright Effect | `LICENSE` |
| Install size | The darwin-arm64 platform package is 199 MB: compilers for three TypeScript versions, tsrs, and patched Oxlint bindings. | `du` |

The Oxlint integration is marked experimental in `effect-tsgo patch --help`. The packaged tsrs and Oxlint builds don't support Linux musl.

## How it runs

### CLI and CI

`effect-tsgo tsc <args>` runs the Effect-patched compiler without changing `node_modules` and passes every argument through, so it drops into the existing `check` scripts. Effect diagnostics print as ordinary diagnostics with codes in the `TS377xxx` range and a trailing `effect(<rule>)`:

```text
src/auth/sqlite.ts(64,13): error TS377042: This code uses `instanceof` with an Effect Schema type. ... effect(instanceOfSchema)
```

Exit code: errors and warnings fail `tsc` by default; suggestions don't. The plugin options `ignoreEffectErrorsInTscExitCode`, `ignoreEffectWarningsInTscExitCode`, and `ignoreEffectSuggestionsInTscExitCode` (default `true`) change that. `effect-tsgo diagnostics --project <tsconfig> --format json|text|github-actions` runs a second, standalone pass with structured output. [README, LSP-based linter](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/README.md#lsp-based-linter)

`effect-tsgo patch --typescript` instead rewrites the installed `typescript` package so any `tsc` invocation is patched. It replaces files by rename and copy, and keeps a `tsc.original` backup; a patch in the worktree left the main checkout's binary unchanged (same SHA-1). Don't use it while violations remain: patched `tsc -b` also reports Effect diagnostics, and `tsc -b` on `packages/github` exited 2.

### Editors

The `setup` command configures VS Code through `effect-tsgo patch --typescript` in a `prepare` script plus `"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "./node_modules/typescript/bin"`. [setup target](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/_packages/tsgo/src/cli/setup/target.ts) Editors that take a server command can run `effect-tsgo tsc --lsp --stdio`. Unverified: neither editor path was run here. Upstream warns against running `effect-tsgo` and stock `tsgo` side by side, because diagnostics appear twice.

### Configuration

The plugin block keeps the old name, `{ "name": "@effect/language-service", ... }`, in `compilerOptions.plugins`. Its options:

- `diagnosticSeverity` maps a rule name to `off`, `suggestion`, `warning`, or `error`. An unlisted rule keeps its upstream default. A deprecated name such as `preferSchemaOverJson` produces a `TS377158` configuration warning in every project, even when set to `off`.
- `overrides` is an ordered list of `{ include, exclude, options }`. Globs resolve against the tsconfig that declares them and are rebased when another tsconfig extends it. `${configDir}` globs didn't match any file in a test run; relative globs such as `../../packages/*/test/**/*` did. [resolver.go](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/internal/pluginoptions/resolver.go), [hooks.go](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/internal/effectconfigraw/hooks.go)
- Comment directives: `// @effect-diagnostics-next-line <rule>:off` for one line, and `// @effect-diagnostics <rule>:off` for the rest of a file.
- Rule-specific options include `allowedUnstableApis`, `allowedExperimentalApis`, `barrelImportPackages`, `namespaceImportPackages`, `keyPatterns` for `deterministicKeys`, and `brandedSchemaClasses`.

### Replacing tsc

`effect-tsgo tsc` replaces `tsc` in `check` scripts. Builds keep stock `tsc -b`: emit doesn't need the plugin, and the patched build fails on violations. The stock `typescript` package stays installed because `effect-tsgo` resolves the version to run from it.

## Effect's Oxlint rules

### Where they are published

The rules ship inside `@effect/tsgo` as the native Oxlint plugin `effecttsgo`. Rule names are the kebab-case form of the diagnostic names (`instanceOfSchema` becomes `effecttsgo/instance-of-schema`). The package provides presets `recommended`, `strict`, `correctness`, `antipattern`, `effect-native`, `style`, and `maintainers`, and a schema at `@effect/tsgo/oxlint-schema.json`. All rules need Oxlint's type-aware mode and `oxlint-tsgolint`. [Oxlint setup](https://github.com/Effect-TS/tsgo/blob/%40effect/tsgo%400.64.1/docs/README.md), [rule docs](https://github.com/Effect-TS/tsgo/tree/%40effect/tsgo%400.64.1/docs/rules)

Other packages that look related don't apply:

- `@effect/oxc` in the Effect monorepo (`packages/tools/oxc`) is a JS plugin with 5 rules for Effect's own sources: `no-bigint-literals`, `no-import-from-barrel-package`, `no-js-extension-imports`, `no-opaque-instance-fields`, `no-unused-internal`. It's `private: true`, not on npm, and declares `typescript >=5 <7`. [package.json](https://github.com/Effect-TS/effect/blob/main/packages/tools/oxc/package.json)
- `oxlint-plugin-effect` (cevr/effect-oxlint) and `effect-oxlint` (mpsuesser) are community packages, not from Effect-TS.

### Loading next to the usine plugin

`effecttsgo` is native, not a `jsPlugins` entry, and only the patched binding knows it. Stock `oxlint` 1.90.0 refuses a configuration that names it: `Unknown plugin: 'effecttsgo'`. Two ways to load it:

- `effect-tsgo oxlint <args>` runs the installed `oxlint` CLI with the patched binding preloaded through `NODE_OPTIONS`. It worked next to the `usine` JS plugin in one run.
- `effect-tsgo patch --oxlint` patches the installed binding so plain `oxlint` and the oxc editor extension load it.

Putting `effecttsgo` in `.oxlintrc.json` would therefore break every unpatched `oxlint` run, including the oxc editor extension. Type-aware mode also switches on Oxlint's own type-aware `typescript/*` correctness rules, which report 829 errors today (`no-misused-spread` 739, `no-floating-promises` 35, `no-base-to-string` 18, `unbound-method` 17, others 20). Measured lint times: stock `oxlint` 1.6–3.0 s, stock `oxlint --type-aware` 11.9 s, `effect-tsgo oxlint` with the `recommended` preset 23.3 s, uncached.

`--fix-suggestions` applies the Effect autofixes; plain `--fix` applied none.

### Rule list

The 146 rules, by upstream category. Five apply to Effect v3 only and are left out of the configuration: `genericEffectServices`, `missingEffectServiceDependency`, `nonObjectEffectServiceType`, `schemaUnionOfLiterals`, `scopeInLayerEffect`.

| Category | Rules |
| --- | --- |
| Correctness | `anyUnknownInErrorContext` (any or unknown in the error or requirements channel), `classSelfMismatch` (Self type parameter differs from the class), `duplicatePackage` (several versions of an Effect package), `effectFnImplicitAny` (noImplicitAny for `Effect.fn` parameters), `errorPayloadShadowsName` (payload field `name` hides the error name), `experimentalApiUsage` / `unstableApiUsage` (APIs tagged `@stability experimental` or `unstable`), `floatingEffect` / `floatingEffectInVitest` (Effect neither yielded nor assigned), `missingEffectContext` / `missingEffectError` / `missingLayerContext` (unhandled requirements or errors), `missingReturnYieldStar` (`yield*` of a never-succeeding Effect without `return`), `missingStarInYieldEffectGen` (`yield` without `*`), `obsoleteMatchImport` / `obsoleteSchemaImport` (v3 packages in v4), `outdatedApi` (APIs removed or renamed in v4), `overriddenSchemaConstructor`, `promiseInEffectSuccess`, `schemaClassMissingBrand` (Schema class without a nominal brand type argument), `schemaClassObjectLiteral` (object literal accepted where a Schema class instance is expected), `schemaLiteralNonFinite`, `schemaOpaqueInstanceMember`, `unsafeEffectTypeAssertion` (assertion that narrows an error or requirements channel) |
| Anti-pattern | `catchUnfailableEffect`, `effectFnIife` (`Effect.fn(...)()`), `effectGenUsesAdapter`, `effectInFailure`, `effectInVoidSuccess`, `effectTryWithoutCatch`, `globalErrorInEffectCatch`, `globalErrorInEffectFailure` (global `Error` in the failure channel), `layerMergeAllWithDependencies`, `lazyEffect` (zero-argument functions or service members that return an Effect), `lazyPromiseInEffectSync`, `leakingRequirements`, `multipleEffectProvide` (chained `Effect.provide`), `preferUnsafeConstructor`, `returnEffectInGen` (returns an Effect from a generator, nesting `Effect<Effect<...>>`), `runEffectInsideEffect`, `schemaSyncInEffect`, `strictEffectProvide` (`Effect.provide` with a Layer outside entry points), `tryCatchInEffectGen`, `unknownInEffectCatch` |
| Effect-native | `abortControllerInEffect`, `asyncFunction`, `cryptoRandomUUID` / `cryptoRandomUUIDInEffect`, `extendsNativeError`, `globalConsole` / `globalConsoleInEffect`, `globalDate` / `globalDateInEffect`, `globalFetch` / `globalFetchInEffect`, `globalJson` / `globalJsonInEffect`, `globalRandom` / `globalRandomInEffect`, `globalTimers` / `globalTimersInEffect`, `instanceOfSchema`, `newPromise`, `nodeBuiltinImport`, `preferEffectArray`, `preferEffectRecord`, `preferEffectString`, `preferSchemaOverJson` (deprecated), `processEnv` / `processEnvInEffect`, `schemaSync`. The plain name flags the global outside Effect generators; the `InEffect` form flags it inside. |
| Style | 63 rewrite suggestions, for example `newSchemaClass` (`X.make` instead of `new X`), `yieldInCallArgument` (`yield*` passed directly as a call argument), `deterministicKeys` (service keys derived from the file path), `strictBooleanExpressions`, `preferBarrelImport`, `preferSchemaTaggedError` (`Schema.TaggedError` instead of `Data.TaggedError`), `catchIfTagToCatchTag`, `mapMapErrorToMapBoth`, `unnecessaryEffectGen`. The full list with one-line purposes is in the README diagnostics table. |
| Maintainers | `apiStabilityLeak` (exported API exposes a less stable type) |

70 rules are autofixable. Two autofixes are unsafe in bulk; see [Breakage and gotchas](#breakage-and-gotchas).

### Overlap with usine rules and #910

No `usine/*` rule duplicates an Effect rule. The closest pairs complement each other:

| usine rule | Effect rule | Relation |
| --- | --- | --- |
| `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion` | `unsafeEffectTypeAssertion` | usine checks assertion syntax; Effect checks, with types, whether an assertion drops an error or requirements channel. |
| `no-unknown-returns`, `no-unknown-parameters` | `anyUnknownInErrorContext`, `unknownInEffectCatch` | usine covers values; Effect covers the error and requirements channels. |
| `no-service-constructor-imports` | `strictEffectProvide`, `leakingRequirements` | All three push layer composition to the entry point, through different patterns. |

Issue #910 plans `usine/no-instanceof-tagged-error`, which would match `x instanceof Name` by import source and name suffix. `instanceOfSchema` makes it unnecessary: it reports every `instanceof` against a Schema class, with type information, and autofixes to `Schema.is(Name)(x)`, one of the forms #910 accepts. It reports 40 source sites in 24 files today (#910's count of 27 predates #911 and excludes the web app and non-error classes). It misses only `Data.TaggedError` classes (`GatewayAdminUnanswered`, 3 sites in `packages/executor/src/ssh/gateway/admin.ts`); `preferSchemaTaggedError` flags those classes, and once converted, `instanceOfSchema` covers them. Vendor classes (`CelParseError`, pi-durable's `SessionFailed`) are out of scope in #910 and aren't flagged.

## Prototype

### Wiring

The branch changes:

- `pnpm-workspace.yaml` and the root `package.json`: replace `@effect/language-service` 0.87.5 with `@effect/tsgo` 0.64.1 and add `oxlint-tsgolint` 7.0.2005.
- `tooling/tsconfig/base.json`: the target plugin block.
- `scripts/effect-diagnostics/check.mjs`: the ratchet. It runs `effect-tsgo tsc -p <tsconfig> --pretty false`, fails on any compiler or configuration error, counts Effect warnings and errors per file and rule for files inside the package, and compares the counts with the package's `effect-baseline.json`.
- `scripts/effect-diagnostics/baseline.mjs`: the rules for changing a baseline, shared by the ratchet and the CI step. `scripts/effect-diagnostics/diff.mjs`: the CI step. `baseline.test.mjs` covers renames, splits, deletions, uncovered violations, and raised counts; root `pnpm test` runs it.
- `.github/workflows/ci.yml`: on pull requests, `node scripts/effect-diagnostics/diff.mjs HEAD^1`.
- `AGENTS.md`: one rule for agents on keeping baselines.
- Each Effect package's `check` script calls the ratchet; `effect:baseline` lowers the baseline. Root `pnpm effect:fix [paths]` runs `scripts/effect-diagnostics/fix.mjs`, which applies the autofixes in `tooling/oxlint/effect-fix.json` until a pass leaves nothing fixable (overlapping fixes need a second pass), then runs `oxfmt`. Root `pnpm effect:baseline` is a turbo task that builds dependencies first, because a package's check reads its dependencies' declarations.
- 14 `effect-baseline.json` files, one per package or app.
- `turbo.json`: the ratchet scripts are `check` inputs. `knip.json`: ignore `@effect/language-service` in `tooling/tsconfig`, because knip reads the plugin name as a dependency.

`apps/docs` keeps `tsc --noEmit`: its tsconfig extends Astro's and has no Effect plugin.

`pnpm lint`, `pnpm format:check`, `pnpm knip`, `turbo run build`, and `turbo run check` pass on the branch. The ratchet was checked by hand: a new `JSON.parse` failed `check` with the diagnostic printed; a raised baseline entry failed as stale; `--update` lowered it and refused to raise counts; a type error and a missing tsconfig each failed.

### Diagnostic counts

Counts are for the target configuration, over the 15 check projects (each package's `tsconfig.check.json`, plus `packages/agents/tsconfig.conformance.json`), deduplicated across projects. Tests means files under `test/`, `protocol-conformance/`, or named `*.test.ts(x)`. Upstream default is the language-service default; the branch sets every listed rule to `error`.

Per package:

| Package | Total | Source | Tests | Files |
| --- | ---: | ---: | ---: | ---: |
| `packages/orchestrator` | 2451 | 693 | 1758 | 136 |
| `apps/server` | 1348 | 438 | 910 | 100 |
| `packages/engine` | 1204 | 350 | 854 | 91 |
| `apps/web` | 1204 | 388 | 816 | 97 |
| `packages/executor` | 700 | 264 | 436 | 95 |
| `packages/agents` | 491 | 170 | 321 | 39 |
| `packages/gateway` | 412 | 137 | 275 | 35 |
| `packages/durable` | 373 | 196 | 177 | 24 |
| `packages/core` | 351 | 174 | 177 | 33 |
| `packages/config` | 266 | 170 | 96 | 33 |
| `packages/github` | 248 | 120 | 128 | 29 |
| `packages/cloudflare` | 199 | 113 | 86 | 16 |
| `packages/expression` | 48 | 16 | 32 | 4 |
| `packages/create-usine` | 39 | 7 | 32 | 3 |
| `tooling/test` | 1 | 0 | 1 | 1 |

Per diagnostic:

| Diagnostic | Category | Upstream default | Total | Source | Tests | Files | Autofix | Largest packages |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `newSchemaClass` | Style | off | 4734 | 1550 | 3184 | 517 | yes | orchestrator 1411, web 1028, engine 557 |
| `yieldInCallArgument` | Style | off | 1212 | 176 | 1036 | 224 | unsafe | engine 314, orchestrator 300, server 214 |
| `schemaClassMissingBrand` | Correctness | suggestion | 637 | 637 | 0 | 157 | no | orchestrator 199, core 121, server 67 |
| `schemaSync` | Effect-native | off | 389 | 69 | 320 | 139 | no | orchestrator 129, server 66, core 51 |
| `asyncFunction` | Effect-native | off | 310 | 56 | 254 | 74 | no | server 173, durable 51, cloudflare 42 |
| `preferTypedSchemaDecoder` | Style | suggestion | 210 | 62 | 148 | 108 | yes | orchestrator 97, server 38, core 20 |
| `multipleEffectProvide` | Anti-pattern | warning | 185 | 2 | 183 | 57 | yes | agents 74, executor 36, engine 31 |
| `globalJson` | Effect-native | off | 175 | 35 | 140 | 87 | no | server 37, orchestrator 28, executor 22 |
| `globalJsonInEffect` | Effect-native | off | 163 | 19 | 144 | 79 | no | engine 40, executor 29, orchestrator 28 |
| `nodeBuiltinImport` | Effect-native | off | 161 | 26 | 135 | 79 | no | server 66, gateway 34, executor 13 |
| `strictBooleanExpressions` | Style | off | 156 | 146 | 10 | 38 | no | web 130, server 11, durable 5 |
| `schemaSyncInEffect` | Anti-pattern | suggestion | 140 | 10 | 130 | 53 | no | orchestrator 71, engine 27, server 20 |
| `instanceOfSchema` | Effect-native | off | 126 | 40 | 86 | 49 | yes | agents 47, executor 27, server 21 |
| `preferSucceedSomeOrNone` | Style | suggestion | 98 | 31 | 67 | 48 | yes | orchestrator 50, engine 23, server 8 |
| `deterministicKeys` | Style | off | 92 | 89 | 3 | 78 | yes | engine 21, orchestrator 20, gateway 10 |
| `newPromise` | Effect-native | off | 69 | 4 | 65 | 29 | no | server 20, agents 12, cloudflare 12 |
| `schemaNumber` | Style | suggestion | 55 | 42 | 13 | 34 | yes | server 16, agents 11, web 8 |
| `strictEffectProvide` | Anti-pattern | off | 33 | 33 | 0 | 12 | no | server 23, engine 5, agents 2 |
| `globalDate` | Effect-native | off | 32 | 8 | 24 | 14 | no | github 14, server 6, orchestrator 5 |
| `processEnv` | Effect-native | off | 29 | 1 | 28 | 20 | no | gateway 7, server 5, durable 4 |
| `lazyEffect` | Anti-pattern | suggestion | 23 | 21 | 2 | 12 | no | engine 14, github 5, gateway 2 |
| `preferBarrelImport` | Style | off | 21 | 17 | 4 | 17 | no | engine 7, executor 5, server 4 |
| `redundantSchemaTagIdentifier` | Style | suggestion | 18 | 18 | 0 | 10 | unsafe | core 7, server 7, orchestrator 2 |
| `unnecessaryPipeChain` | Style | suggestion | 18 | 4 | 14 | 15 | yes | orchestrator 13, executor 2, engine 1 |
| `globalFetch` | Effect-native | off | 17 | 3 | 14 | 6 | no | server 6, durable 5, cloudflare 3 |
| `mapMapErrorToMapBoth` | Style | off | 16 | 15 | 1 | 15 | yes | server 5, config 4, orchestrator 3 |
| `cryptoRandomUUIDInEffect` | Effect-native | off | 15 | 4 | 11 | 9 | no | orchestrator 10, server 3, agents 1 |
| `schemaStructWithTag` | Style | suggestion | 15 | 14 | 1 | 6 | yes | orchestrator 5, engine 4, core 3 |
| `mapSomeToAsSome` | Style | suggestion | 14 | 14 | 0 | 14 | yes | server 4, executor 3, agents 2 |
| `globalTimers` | Effect-native | off | 13 | 2 | 11 | 9 | no | cloudflare 5, executor 3, agents 2 |
| `anyUnknownInErrorContext` | Correctness | off | 13 | 5 | 8 | 7 | no | server 9, durable 2, engine 1 |
| `effectTryWithoutCatch` | Anti-pattern | off | 11 | 2 | 9 | 5 | no | orchestrator 6, cloudflare 2, github 2 |
| `globalDateInEffect` | Effect-native | off | 10 | 3 | 7 | 8 | no | durable 2, executor 2, github 2 |
| `catchConditionalRefailToCatchIf` | Style | suggestion | 10 | 10 | 0 | 5 | no | server 7, engine 1, github 1 |
| `returnEffectInGen` | Anti-pattern | suggestion | 9 | 9 | 0 | 5 | unsafe | orchestrator 4, executor 2, server 2 |
| `unnecessaryArrowBlock` | Style | off | 9 | 9 | 0 | 7 | yes | web 6, orchestrator 2, engine 1 |
| `globalFetchInEffect` | Effect-native | off | 9 | 0 | 9 | 6 | no | orchestrator 3, engine 2, github 2 |
| `processEnvInEffect` | Effect-native | off | 8 | 2 | 6 | 5 | no | agents 2, durable 2, gateway 2 |
| `missedPipeableOpportunity` | Style | off | 8 | 2 | 6 | 4 | yes | web 5, durable 1, orchestrator 1 |
| `errorPayloadShadowsName` | Correctness | suggestion | 7 | 7 | 0 | 3 | no | cloudflare 6, server 1 |
| `preferSchemaTaggedError` | Style | off | 7 | 6 | 1 | 5 | no | executor 3, gateway 3, core 1 |
| `globalErrorInEffectFailure` | Anti-pattern | warning | 7 | 1 | 6 | 5 | no | executor 4, gateway 2, engine 1 |
| `runEffectInsideEffect` | Anti-pattern | suggestion | 7 | 0 | 7 | 4 | yes | engine 5, orchestrator 1, server 1 |
| `optionMatchToFromOption` | Style | suggestion | 6 | 5 | 1 | 5 | yes | server 3, executor 2, orchestrator 1 |
| `unknownInEffectCatch` | Anti-pattern | warning | 5 | 5 | 0 | 4 | no | durable 2, server 2, orchestrator 1 |
| `effectFnIife` | Anti-pattern | warning | 4 | 4 | 0 | 3 | yes | orchestrator 2, agents 1, server 1 |
| `provideLayerSucceedToProvideService` | Style | suggestion | 4 | 0 | 4 | 2 | yes | orchestrator 3, agents 1 |
| `schemaClassObjectLiteral` | Correctness | warning | 4 | 4 | 0 | 3 | no | engine 3, orchestrator 1 |
| `flatMapConditionalToFilterOrFail` | Style | suggestion | 2 | 2 | 0 | 2 | yes | agents 1, orchestrator 1 |
| `abortControllerInEffect` | Effect-native | suggestion | 2 | 0 | 2 | 1 | no | agents 2 |
| `nestedEffectGenYield` | Style | off | 2 | 2 | 0 | 2 | no | executor 2 |
| `provideMergeAllToArray` | Style | off | 2 | 2 | 0 | 2 | yes | gateway 1, server 1 |
| `missingReturnYieldStar` | Correctness | error | 2 | 2 | 0 | 2 | yes | orchestrator 2 |
| `unnecessaryEffectGen` | Style | suggestion | 2 | 0 | 2 | 2 | yes | orchestrator 1, server 1 |
| `allOfMapToForEach` | Style | suggestion | 1 | 0 | 1 | 1 | yes | config 1 |
| `globalConsoleInEffect` | Effect-native | off | 1 | 0 | 1 | 1 | no | engine 1 |
| `raceFirstWithSleepToTimeout` | Style | suggestion | 1 | 1 | 0 | 1 | no | executor 1 |
| `cryptoRandomUUID` | Effect-native | off | 1 | 1 | 0 | 1 | no | gateway 1 |
| `multipleCatchTag` | Style | suggestion | 1 | 1 | 0 | 1 | no | gateway 1 |
| `redundantMapError` | Style | suggestion | 1 | 1 | 0 | 1 | no | orchestrator 1 |
| `effectSucceedWithUndefined` | Style | suggestion | 1 | 0 | 1 | 1 | yes | orchestrator 1 |
| `flatMapToMap` | Style | suggestion | 1 | 1 | 0 | 1 | yes | server 1 |
| `flatMapIdentityToFlatten` | Style | suggestion | 1 | 1 | 0 | 1 | yes | server 1 |

`tooling/test/sqlite.mts` has one `nodeBuiltinImport`. It belongs to no package, so no baseline gates it.

Autofix "yes" means the upstream fix is safe in bulk. `tooling/oxlint/effect-fix.json` holds those rules except the ones left to a reviewed change: `instanceOfSchema`, `deterministicKeys`, `missingReturnYieldStar`, `effectFnIife`, and `schemaStructWithTag`. Its 60 rules account for 5,375 of the 9,335 violations. On `packages/github`, `pnpm effect:fix` converged in two passes and lowered the package from 248 to 139 violations; after `oxfmt`, the package type-checked and its 141 tests passed.

If the three `preferEffect*` rules were on, they would add 5,685 violations, none autofixable: `preferEffectArray` 3,917, `preferEffectString` 1,620, `preferEffectRecord` 148 (counted before the web override).

### Examples

| Diagnostic | Examples |
| --- | --- |
| `newSchemaClass` | `apps/server/src/auth/sqlite.ts:84` `new Member({ ...member, login })`; `packages/github/src/polling/polling.ts:455` `new PollCursor(...)` |
| `yieldInCallArgument` | `packages/agents/src/pi/codex/remote.ts:104` `Queue.offer(stdout, yield* Effect.fromResult(...))`; `packages/cloudflare/src/sandbox/sandbox.ts:263` `summarize(yield* stored(name))` |
| `schemaClassMissingBrand` | `packages/agents/src/child-host/child-host.ts:5` `Schema.TaggedClass<LocalProcess>(...)`; `packages/agents/src/runtime.ts:30` `Schema.Class<ChildRequest>(...)` |
| `schemaSync`, `schemaSyncInEffect` | `packages/agents/src/pi/claude/sdk.ts:75` module-level `Schema.decodeUnknownSync(...)`; `packages/agents/src/pi/codex/account.ts:21` `decodeUnknownSync` inside a generator |
| `asyncFunction` | `packages/agents/src/pi/claude/claude.ts:497` Claude SDK `HookCallback`; `packages/agents/test/child-host.test.ts:71` `it("...", async () => ...)` |
| `multipleEffectProvide` | `packages/agents/src/preflight/preflight.ts:202`; `packages/github/test/request-retry.test.ts:81` |
| `globalJson`, `globalJsonInEffect` | `packages/agents/src/pi/codex/app-server.ts:166` `JSON.stringify(message)`; `packages/agents/src/pi/codex/codec.ts:33` `JSON.parse(JSON.stringify(value))` |
| `nodeBuiltinImport` | `packages/agents/src/pi/claude/claude.ts:6` `node:child_process`; `packages/gateway/src/node/attachments.ts:1` `node:crypto` |
| `strictBooleanExpressions` | `packages/agents/src/pi/turns.ts:61` `lastAssistant.errorMessage` used as a condition; 130 of 156 are in `apps/web` |
| `instanceOfSchema` | `apps/server/src/auth/sqlite.ts:64` `error instanceof AuthError`; `packages/executor/src/ssh/gateway/admin.ts:74` `failure instanceof GatewayForwardClosed`; `apps/web/src/features/configuration/components/editor/form.tsx:73` |
| `deterministicKeys` | `packages/agents/src/pi/claude/sdk.ts:73`: key `@usine/agents/pi/ClaudeSdk`, expected `@usine/agents/pi/claude/sdk/ClaudeSdk` |
| `lazyEffect` | `packages/engine/src/run-reader/run-reader.ts:177` service member `revision` is `() => Effect`; `packages/github/src/github-app.ts:117` five members |
| `strictEffectProvide` | 33 in source, 23 of them in `apps/server` |
| `schemaClassObjectLiteral` | `packages/engine/src/engine/engine.ts:137` and `packages/engine/src/engine/run-driver.ts:522` pass an object literal where an `UnconfirmedStop` instance is expected |
| `missingReturnYieldStar` | `packages/orchestrator/src/scheduler/preflight.ts:317` and `provisioning.ts:119`: `yield* Effect.txRetry` without `return` |
| `errorPayloadShadowsName` | `packages/cloudflare/src/api/api.ts:158` error payload `{ name: SandboxName }` |
| `unknownInEffectCatch`, `anyUnknownInErrorContext` | `packages/durable/src/harness.ts:409` `Effect.tryPromise` whose `catch` returns `unknown`; `apps/server/src/detach.ts:65` |
| `globalErrorInEffectFailure` | `packages/executor/src/ssh/gateway/forward.ts:100` `Effect.fail(new Error("the listener reported no port"))` |
| `effectFnIife` | `packages/orchestrator/src/webhooks.ts:34` `Effect.fn("WebhookHealth.reset")(function* () {...})()` |

### Likely false positives

- `returnEffectInGen`: all 9 source sites look intentional. They return an Effect as a value: a release action (`packages/agents/src/pi/claude/claude.ts:308`), a cached Effect (`packages/executor/src/remote/reclaim.ts:17`), and the prepare-then-apply step of a reload (`packages/orchestrator/src/current-instance/current-instance.ts:227`). Keep the rule, which catches real nested-Effect bugs, and suppress these with `@effect-diagnostics-next-line`. Its autofix would change behaviour, so it's excluded from `effect:fix`.
- `asyncFunction`, `newPromise`: vendor interfaces that require a Promise, such as Claude SDK hooks and the SDK fakes in tests. Suppress per line.
- `nodeBuiltinImport`: Node adapter modules such as `packages/gateway/src/node/attachments.ts`, which uses `createCipheriv`. Unverified whether `effect` 4.0.6 offers a cipher API; if not, suppress per file.
- `lazyEffect` conflicts with the `effect-ts` skill, whose service examples declare `readonly all: () => Effect.Effect<...>`. The rule is consistent with Effect's own guidance; update the skill rather than the rule.
- `deterministicKeys`: the autofix renames `Context.Service` keys. Unverified whether any key is persisted or compared across processes; check before applying.
- `missingReturnYieldStar` on `Effect.txRetry` is correct: `txRetry` never succeeds.

### Typecheck time

Times on an Apple Silicon laptop, uncached, same machine load, two runs each.

| Run | Stock `tsc` | `effect-tsgo` |
| --- | ---: | ---: |
| 15 check projects, one after another | 10.6–11.1 s | 14.5–14.9 s with the target configuration (+35%) |
| `turbo run check --force`, 27 tasks | 10.4–12.0 s | 12.2–15.9 s through the ratchet |
| `turbo run check`, cached | — | 0.4 s, 27 of 27 cached |
| `oxlint` (whole repository) | 1.6–3.0 s | 23.3 s with `effect-tsgo oxlint` and the `recommended` preset |

### Breakage and gotchas

- Turbo caching works. Changing `tooling/tsconfig/base.json` invalidated all 27 `check` tasks. `@effect/tsgo` is a root dependency, which turbo hashes into every task (`globalCacheInputs.hashOfExternalDependencies`).
- Project references and `pnpm build` are unchanged: builds use stock `tsc -b`.
- Patched `tsc -b` fails builds while violations exist, so `effect-tsgo patch` stays out of `prepare` until the cleanup ends.
- `apps/server` tests import `packages/engine/test/support.ts`, so the server project type-checks engine sources and reports engine diagnostics a second time. The ratchet only counts files inside the package under check.
- `redundantSchemaTagIdentifier`'s autofix leaves a lone comma when the arguments span several lines (`apps/server/src/configuration/command.ts:38`, `TS1135`). `yieldInCallArgument`'s autofix, applied in bulk, declared `value_1` twice in one scope and passed an array where a string was expected (`packages/github/test/github-app.test.ts:146`). Both are excluded from `effect:fix`. Not reported upstream.
- The CI install grows by one platform package: 199 MB on darwin-arm64; linux-x64 unverified.
- `effect-tsgo oxlint` reported `unstable-api-usage` warnings that the Oxlint configuration didn't enable. It appears to fall back on the tsconfig plugin defaults. Unverified.

## Target configuration

The branch's `tooling/tsconfig/base.json` sets every Effect v4 diagnostic. `error` and `warning` both fail `tsc` with the exit-code options at `false`; the configuration uses `error` throughout, so one severity means "enforced".

Off, with the reason:

| Diagnostic | Reason |
| --- | --- |
| `apiStabilityLeak` | Doesn't apply. It guards the `@stability` contract of a published library. usine has no stability tags, so every export that uses an `effect/http` type would report. |
| `missingPipeableSignature` | Doesn't apply. It asks for dual data-first and data-last signatures, a convention for library modules, on every exported function. |
| `preferNamespaceImport` | Mutually exclusive with `preferBarrelImport`. The repository imports from the `effect` barrel, which `preferBarrelImport` enforces. |
| `preferEffectArray`, `preferEffectRecord`, `preferEffectString` | No defect class removed. They ask to replace every native array, string, and `Object` call (`xs.map`, `s.trim()`) with the `effect` module function. The upstream docs mark the suggestions as having semantic caveats (`find` becomes `findFirst` returning `Option`, different callback parameters). They aren't autofixable, and Effect ships them off. Off for now, to revisit: turning them on adds 5,685 manual edits. |

`preferSchemaOverJson` isn't listed: it's deprecated, and listing it raises a configuration warning. `globalJson` and `globalJsonInEffect` replace it.

Rule options:

- `allowedUnstableApis`: the modules the code already depends on, which `effect` 4.0.6 tags `@stability unstable`: `effect/http`, `effect/http-api`, `effect/sql`, `effect/process`, `effect/cli`, `effect/FileSystem`, `effect/Path`, `effect/PlatformError`, `effect/Crypto`, `effect/ByteSize`, `effect/net`, `effect/observability`, `effect/reactivity`, `@effect/platform-node`, `@effect/sql-sqlite-node`, and `@effect/vitest`. Without the list, `unstableApiUsage` reports 3,161 uses of modules the architecture chose on purpose. With it, the rule still fails the first use of any other unstable module.
- `barrelImportPackages: ["effect"]` for `preferBarrelImport`.
- `keyPatterns` stays at the default, which derives keys from the file path. `package-identifier` is the alternative if the current `@usine/<package>/<Name>` style should stay.

Overrides:

| Files | Off | Reason |
| --- | --- | --- |
| `packages/*/test/**`, `apps/*/test/**`, `apps/*/src/**/*.test.ts(x)`, `packages/*/protocol-conformance/**` | `strictEffectProvide` | Each test is an entry point that provides its own layers. |
| `apps/web/src/**`, `apps/web/*.config.ts` | `asyncFunction`, `cryptoRandomUUID`, `globalConsole`, `globalDate`, `globalFetch`, `globalJson`, `globalRandom`, `globalTimers`, `newPromise`, `processEnv`, `schemaSync` | The web app is React code. It uses `Option`, `Schema`, and `Match` as data libraries but doesn't run its control flow in Effect, so "use the Effect equivalent outside a generator" doesn't apply. The `InEffect` variants stay on, and so does every rule about Effect values. |

## Landing without blocking CI

Recommended: the per-package baseline on the branch.

1. Land the configuration at target severity with every package's current counts in `effect-baseline.json`. CI passes on day one.
2. `pnpm check` (already in `ci.yml`) runs the ratchet in every package's `check` task. It fails unless the baseline equals the current counts. A new violation fails it; so does a fixed one, until the PR commits the lowered file from `pnpm effect:baseline`.
3. `pnpm effect:baseline` rewrites a package's baseline from its current counts under these rules:
   - A file the baseline lists keeps at most its listed count.
   - Per rule, the count that leaves listed files (by a fix, a deletion, a rename, or code moving out) can follow into files the baseline doesn't list. So a rename, a split, or a move within the package keeps its allowance, and the rule's total for the package never rises.
   - Anything those rules don't cover stays a violation: the command prints it and exits 1.
   - Moving code into a file the baseline already lists, or into another package, doesn't carry the allowance; fix the moved violations.
   - The allowance released by a fix can cover an equal number of violations of the same rule in a new file of the same package, in the same change. The package total still can't rise.
4. On pull requests, CI runs `node scripts/effect-diagnostics/diff.mjs HEAD^1`. The pull request checkout is the test merge commit, whose first parent is the base branch tip. The step fails when any baseline has a file count above its count at the base, a rule total above its total at the base, or a baseline the base doesn't have. A hand edit that raises a count fails here even though `pnpm check` accepts it. The base branch tip is used rather than the merge base: it is the stricter comparison, because it includes every count main lowered since the branch point.
5. Each cleanup PR fixes violations and commits the smaller baseline. A package whose baseline empties loses the file; switch its `check` back to `effect-tsgo tsc -p tsconfig.check.json`.
6. When every baseline is gone, delete `scripts/effect-diagnostics/` and the CI step, and add `"prepare": "effect-tsgo patch --typescript"` so editors and builds run the patched compiler.

A rebase that conflicts on an `effect-baseline.json` resolves by taking either side and rerunning `pnpm effect:baseline`.

Tested by hand on the real packages: a rename of `packages/github/test/request-retry.test.ts`, a split of `Variable` out of `packages/expression/src/environment.ts`, and a file deletion each passed after `pnpm effect:baseline` and passed `diff.mjs`. A copied file with new violations stayed uncovered, and a hand-added entry for it passed `pnpm check` but failed `diff.mjs`.

Rejected:

- Per-package warn then error. Warnings are visible but merge freely, so new violations land.
- Per-directory overrides removed as each area is cleaned. They switch a rule off for a whole area, so new violations land there.
- Inline suppressions. 9,335 comments, and nothing stops a new one.
- Gating through `effect-tsgo oxlint`. It works, but needs every `oxlint` run, including the editor extension, routed through the patched binding; it brings 829 Oxlint type-aware errors; it costs 23 s uncached on every lint; and Oxlint has no baseline either. The configuration would also live in two places, because the editor reads the tsconfig plugin block.

During the transition, editors don't show Effect diagnostics unless a developer runs `pnpm exec effect-tsgo patch --typescript` locally, which the next install undoes, or configures an LSP command. Agents see them in `pnpm check` output.

## Cleanup

The cleanup runs as five changes, grouped by kind of change across the repository. Counts are from the committed baselines.

| Change | Rules | Count |
| --- | --- | --- |
| Autofix sweep | Every rule in `tooling/oxlint/effect-fix.json`. Reproduce with `pnpm effect:fix && pnpm effect:baseline`. Largest: `newSchemaClass` 4,734, `preferTypedSchemaDecoder` 211, `multipleEffectProvide` 185, `preferSucceedSomeOrNone` 98, `schemaNumber` 55. | 5,375 in 568 files |
| Correctness | `instanceOfSchema` 126, `strictEffectProvide` 33, `lazyEffect` 23, `anyUnknownInErrorContext` 13, `effectTryWithoutCatch` 11, `errorPayloadShadowsName` 7, `preferSchemaTaggedError` 7 (including the 3 `Data.TaggedError` checks in `packages/executor/src/ssh/gateway/admin.ts`), `globalErrorInEffectFailure` 7, `unknownInEffectCatch` 5, `effectFnIife` 4, `schemaClassObjectLiteral` 4, `missingReturnYieldStar` 2 | 242 in 98 files |
| `yieldInCallArgument` | One rule; its bulk autofix is unsafe. | 1,212 in 224 files |
| Schema | `schemaClassMissingBrand` 637, `schemaSync` 389, `schemaSyncInEffect` 140, `redundantSchemaTagIdentifier` 18, `schemaStructWithTag` 15 | 1,199 in 295 files |
| Everything left | Native globals (`globalJson` 175, `globalJsonInEffect` 163, `nodeBuiltinImport` 160, `globalDate*` 42, `processEnv*` 37, `globalFetch*` 26, `cryptoRandomUUID*` 16, `globalTimers` 13), `asyncFunction` 310, `newPromise` 69, `strictBooleanExpressions` 156, `deterministicKeys` 92 (check that no key is persisted first), `preferBarrelImport` 21, `returnEffectInGen` 9 (per-line suppressions), and the small style rules. It ends by removing the ratchet and switching every `check` back to `effect-tsgo tsc`. | 1,307 in 325 files |

`preferEffectArray`, `preferEffectRecord`, and `preferEffectString` stay off for now, to revisit.

## Unverified

- Editor integration: VS Code through `patch --typescript` and `js/ts.experimental.useTsgo`, and `effect-tsgo tsc --lsp --stdio` in other editors. Not run.
- Size of the linux-x64 platform package, and `effect-tsgo` on the CI runner.
- Whether `${configDir}` in plugin `overrides` is unsupported or a bug. Observed: no match.
- Why `effect-tsgo oxlint` reports rules missing from the Oxlint configuration.
- Whether `effect` 4.0.6 has a cipher API that would satisfy `nodeBuiltinImport` in `packages/gateway/src/node/attachments.ts`.
- Whether any `Context.Service` key is persisted, which `deterministicKeys`' autofix would change.

## Sources

- [Effect-TS/tsgo at `@effect/tsgo@0.64.1`](https://github.com/Effect-TS/tsgo/tree/%40effect/tsgo%400.64.1): `README.md`, `docs/README.md` (Oxlint setup), `docs/rules/*.md` (category, default severity, fixability, Oxlint name per rule), `_packages/tsgo/upstream.json`, `etscore/options.go`, `internal/pluginoptions/resolver.go`, `internal/effectconfigraw/hooks.go`, `_packages/tsgo/src/patcher/index.ts`, `_packages/tsgo/src/cli/setup/target.ts`, `LICENSE`
- npm: `npm view @effect/tsgo`, `npm view oxlint-tsgolint`, `npm view oxlint-plugin-effect`, `npm view effect-oxlint`
- [Effect-TS/effect `packages/tools/oxc`](https://github.com/Effect-TS/effect/tree/main/packages/tools/oxc) and the root `.oxlintrc.json`
- `effect` 4.0.6 sources in `node_modules/effect/src` for the `@stability unstable` tags
- Runs on branch `worktree-agent-a5c09b2753db54b9a`: `effect-tsgo tsc`, `effect-tsgo oxlint`, `oxlint --type-aware`, `turbo run check`, `turbo run build`
