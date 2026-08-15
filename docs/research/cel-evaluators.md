# CEL evaluators in TypeScript

Resolves [#17](https://github.com/basaltbytes/usine/issues/17). Research date: 2026-08-15. Sources are the candidates' GitHub repos and source code, npm registry metadata, the official [CEL spec](https://github.com/google/cel-spec), and hands-on verification of the two lead candidates against usine's actual requirements (scripts described in [Empirical verification](#empirical-verification)). No blog posts.

The question: which CEL evaluator should usine exact-pin behind its expression seam? The loop-file resolution ([#8](https://github.com/basaltbytes/usine/issues/8)) fixed CEL for `if:` filters and `{{ }}` interpolation over per-stream payload slices (JSON-ish GraphQL slices of GitHub's object graph), and promised that bad expressions **and unknown payload paths** fail at file-validation time, before any agent runs. Criteria in order: (a) correctness for macros over lists (`exists`, `filter`, `size` — GitHub payloads are list-heavy); (b) parse-time validation — a declared environment / check phase in the sense of the spec's [Gradual Type Checking](https://github.com/google/cel-spec/blob/master/doc/langdef.md#gradual-type-checking) section; (c) a clean parse/evaluate split behind a seam; (d) license and exact-pinnability. Performance is a non-criterion at usine's scale.

---

## The field

Found via npm search (`cel expression language`) and GitHub search, 2026-08-15. Downloads are last-month figures from `api.npmjs.org/downloads`.

| Package | Latest | Released | Downloads/mo | License | Deps | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js) | 8.0.0 | 2026-07-07 | 1,502,913 | MIT | **zero** | active (pushed 2026-08-06) |
| [`@bufbuild/cel`](https://github.com/bufbuild/cel-es) | 0.6.0 | 2026-06-01 | 1,754,938 | Apache-2.0 | `@bufbuild/re2`, `@bufbuild/cel-spec`; peer `@bufbuild/protobuf` | active (pushed 2026-08-12), self-declared beta |
| [`cel-js`](https://github.com/ChromeGG/cel-js) (ChromeGG) | 0.8.2 | 2025-07-11 | 437,878 | MIT | `chevrotain`, `ramda` | **repo archived** 2026-04 |
| [`@bearclaw/cel`](https://github.com/jafaircl/bearclaw) | 0.1.0-alpha.12 | 2025-06-02 | — | MIT (repo) | `antlr4`, `@bufbuild/protobuf`, 4 more | alpha, no pushes since 2025-06-02 |
| `@libdbm/libcel-ts`, `wasm-cel`, `@gresb/cel-javascript` | — | — | 920 / 2,801 / 709 | — | — | niche, low adoption |

Two candidates are serious: `@marcbachmann/cel-js` and `@bufbuild/cel`. The rest eliminate themselves (below).

---

## 1. `@marcbachmann/cel-js` — the recommendation

Repo: [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js). MIT, zero runtime dependencies, 222 KB unpacked ([npm registry](https://www.npmjs.com/package/@marcbachmann/cel-js)). 183 stars; 87 releases since 2025-06-13; renovate-driven; pushed 2026-08-06.

### Conformance and macros

The README claims "Most of the CEL Spec — including macros, custom functions and types, optional chaining, input variables, and all operators" ([README](https://github.com/marcbachmann/cel-js/blob/main/README.md)). Supported macros: `has()`, `all()`, `exists()`, `exists_one()`, `map()`, `filter()`, plus `cel.bind()` and custom macro registration — the full predefined set from the spec's [Macros section](https://github.com/google/cel-spec/blob/master/doc/langdef.md#macros). Timestamp methods (with timezone parameters), string/list/bytes methods, and type conversions are covered ("Timestamp Methods", "Built-in Functions" README sections).

**It does not run the official cel-spec conformance suite.** Tests are a substantial handwritten set (37 `test/*.test.js` files covering macros, type-checker, optional types, overloads, limits, protobufjs interop — [repo tree](https://github.com/marcbachmann/cel-js/tree/main/test)), but nothing wires in [google/cel-spec](https://github.com/google/cel-spec) test data. Grep for "conformance" in the repo comes back empty. This is the library's main weakness against `@bufbuild/cel`.

### Parse-time validation — the decisive feature

The `Environment` API declares variables, types (with fields), constants, functions and operators; `env.check(expr)` type-checks **without evaluating** and returns `{valid, type}` or `{valid: false, error}` ([README "Type Checking"](https://github.com/marcbachmann/cel-js/blob/main/README.md#type-checking), implementation in [lib/type-checker.js](https://github.com/marcbachmann/cel-js/blob/main/lib/type-checker.js)). Undeclared variables are check-time errors by default (`unlistedVariablesAreDyn: false`); the library's own test suite pins this: `test/type-checker.test.js` asserts `Unknown variable: unknownVar` and `found no matching overload for 'unknownFunc'` ([test/type-checker.test.js](https://github.com/marcbachmann/cel-js/blob/main/test/type-checker.test.js), lines 17–22, 402–404).

Verified hands-on (v8.0.0, details in [Empirical verification](#empirical-verification)): with a GitHub-ish slice declared as `registerType('Item', {fields: {number: 'int', state: 'string', labels: 'list<Label>', …}})`, `env.check()` catches:

- unknown top-level variable — `itme.state` → `TypeError: Unknown variable: itme`;
- **unknown field on a declared type** — `item.reviewz_requested` → `TypeError: No such key: reviewz_requested`;
- **unknown field inside a macro body** — `item.labels.exists(l, l.nmae == "ready")` → `TypeError: No such key: nmae`;
- type mismatches — `item.number == "5"` → `no such overload: int == string`;
- syntax errors — `ParseError: Unexpected token: EOF`.

Every error carries a source-position caret rendering, which feeds the loop-quarantine UI (#8: invalid expressions quarantine the loop with a visible error state) directly. This is exactly the promise #8 made: declare each stream's payload-slice shape once as an environment, and both bad expressions and unknown payload paths fail at file-validation time.

### API shape and runtime characteristics

- `parse(expr)` → reusable callable (throws `ParseError`); `env.evaluate(expr, ctx)` for one-shot; `env.check(expr)` for validation-only. Clean parse/check/evaluate split behind one `Environment` object — a natural seam surface.
- Three error classes: `ParseError`, `EvaluationError`, `TypeError` ([README "Error Handling"](https://github.com/marcbachmann/cel-js/blob/main/README.md#error-handling)). Runtime errors throw (verified: `item.nope.deeper` on an empty object → `EvaluationError: No such key: nope`).
- Parse-time structural limits (`maxAstNodes`, `maxDepth`, `maxListElements`, …) — useful guardrails for operator-authored expressions ([README "Environment Options"](https://github.com/marcbachmann/cel-js/blob/main/README.md#environment-options)).
- Environment cloning for cheap per-stream environments; environments are documented as expensive to build, which fits usine's long-running orchestrator (build once per stream at startup/file-load).
- CEL `int` is `bigint` in JS (spec-correct 64-bit semantics); verified `string(item.number)` → `"42"`, so `{{ }}` interpolation needs either explicit `string()` in expressions or a `String(result)` normalization at the seam. Declared types accept **plain JSON objects** at evaluation time (verified — no class instances required), so GraphQL payload slices bind directly.
- ESM, full TypeScript definitions shipped (`lib/*.d.ts`).

### Risks

- **Bus factor**: 213 of ~253 commits are the maintainer's ([contributors](https://github.com/marcbachmann/cel-js/graphs/contributors)). Mitigated by the seam + exact pin, and by `@bufbuild/cel` existing as a live fallback behind the same seam.
- **No official conformance run**: semantic edge cases may drift from cel-go. Mitigation: the seam's contract tests should pin the exact semantics usine relies on (macros over lists, `has()`, string ops, timestamp comparisons), so a fallback swap is a test-suite run away.
- **Fast major cadence** (v3→v8 in 13 months): irrelevant under usine's exact-pin policy; upgrades are deliberate events.

---

## 2. `@bufbuild/cel` (cel-es) — strong runner-up, wrong shape for the promise

Repo: [bufbuild/cel-es](https://github.com/bufbuild/cel-es). Apache-2.0, maintained by Buf (multiple corporate maintainers — timostamm, srikrsna-buf, Alfus), pushed 2026-08-12. Self-declared: "This project is in beta" ([README](https://github.com/bufbuild/cel-es/blob/main/README.md)). Highest downloads of the field (1.75M/mo, largely as the engine under Buf's protovalidate-es).

**Conformance is its headline strength.** It is the only JS implementation that runs the official cel-spec test data: `@bufbuild/cel-spec` packages "CEL definitions and test data from github.com/google/cel-spec", and [packages/cel/src/conformance.test.ts](https://github.com/bufbuild/cel-es/blob/main/packages/cel/src/conformance.test.ts) runs the suite with an explicit, commented skip list — quoted fields, proto2 extensions, several extension namespaces (`bindings_ext`, `block_ext`, `encoders_ext`), strong proto enum semantics, and notably: *"We don't have full support for type-checking"* (the `type_deductions` sections are skipped). Macros over lists pass the suite.

**But the check phase is not in the public API.** [packages/cel/src/index.ts](https://github.com/bufbuild/cel-es/blob/main/packages/cel/src/index.ts) exports `run`, `plan`, `parse`, `celEnv`, `celFunc`/`celMethod` and value/type helpers — a `checker.ts` exists internally but is unexported and, per the skip list above, incomplete. Verified hands-on (v0.6.0): `plan(env, parse('itme.state == "OPEN"'))` **accepts an unknown variable without complaint**; the error surfaces only at evaluation, as a returned `CelError` value (`unresolved attribute`, `field not found: reviewz`) — CEL-spec-correct *runtime* error semantics ([langdef "Runtime Errors"](https://github.com/google/cel-spec/blob/master/doc/langdef.md#runtime-errors)), but no static detection. Delivering usine's file-validation promise on top would mean walking its protobuf-message AST (`ParsedExpr` from `@bufbuild/cel-spec`) and re-implementing declared-shape checking ourselves — the exact work `@marcbachmann/cel-js` already does.

Other friction, all verifiable in the [packages/cel README types table](https://github.com/bufbuild/cel-es/blob/main/packages/cel/README.md) and hands-on: the value model is protobuf-centric (`CelUint`, `ReflectMessage`, results like `filter` returning internal `CelList` wrappers that need unwrapping before interpolation); errors are returned as values rather than thrown (fine, different seam contract); dependency weight is `@bufbuild/cel-spec` (5.9 MB unpacked, a *runtime* dep — the generated proto types live there) + `@bufbuild/re2` (399 KB) + peer `@bufbuild/protobuf`, vs. marcbachmann's zero-dep 222 KB. None of this is disqualifying — it is simply a protovalidate-shaped library, not a JSON-payload-validation-shaped one.

**Role in usine: the designated fallback.** Same-order adoption, corporate backing, official conformance run. If the marcbachmann pin ever sours, the seam re-targets here and unknown-path checking becomes usine-side AST work.

---

## 3. `cel-js` (ChromeGG) — eliminated: archived

Repo: [ChromeGG/cel-js](https://github.com/ChromeGG/cel-js), the package the ticket named first. **Archived** (GitHub API `archived: true`, last push 2026-04-26). Its README says it all: a maintainer-wanted notice, then — *"There is also [a great implementation of cel-js](https://github.com/marcbachmann/cel-js) made by @marcbachmann. It has full syntax support and better performance. You may consider it too"* ([README](https://github.com/ChromeGG/cel-js/blob/main/README.md)). Feature table confirms gaps that matter: no raw/triple-quote/byte strings, no bytes literals, and no type checking at all — `parse()` returns a CST for syntax validation only. Macros were supported. MIT, deps on `chevrotain` + `ramda`. The predecessor, not the pick; its own author points at the successor.

## 4. `@bearclaw/cel` — eliminated: stalled alpha

Repo: [jafaircl/bearclaw](https://github.com/jafaircl/bearclaw), package `@bearclaw/cel`. Architecturally the most spec-faithful design in the field — "intends to be a one to one port of cel-go" with a real parse → check → evaluate pipeline and partial-state evaluation ([packages/cel README](https://github.com/jafaircl/bearclaw/blob/main/packages/cel/README.md)). But: "This is a very early Alpha release. While the API surface should not change significantly, some functionality may be missing or incomplete" (same README), last publish and last repo push 2025-06-02, 4 stars, and a heavy dependency chain (`antlr4`, `@bufbuild/protobuf`, four more). Notably its author (jafaircl) now contributes to bufbuild/cel-es — the energy moved there. Not pinnable.

## 5. Also-rans

- `@libdbm/libcel-ts` (1.0.2, 2026-07-08, 920 dl/mo) — new, negligible adoption, no track record.
- `wasm-cel` (0.5.2, 2.8K dl/mo) — Rust CEL compiled to WASM; a WASM boundary inside the orchestrator for zero conformance evidence is complexity without payoff.
- `@gresb/cel-javascript` (0.1.1, 709 dl/mo) — ANTLR-based, single-org, effectively unadopted.

---

## Empirical verification

Both leads were installed exact-pinned (`@marcbachmann/cel-js@8.0.0`, `@bufbuild/cel@0.6.0`) and exercised against a GitHub-payload-shaped slice (`item` with `number`, `state`, `review_requested`, `labels: list<Label>`, `reviews: list<Review>`) on 2026-08-15, Node 24. Results quoted in the sections above; headline matrix:

| Probe | `@marcbachmann/cel-js` 8.0.0 | `@bufbuild/cel` 0.6.0 |
| --- | --- | --- |
| `labels.exists(l, l.name == "ready")` over plain JSON | true (check + eval) | true |
| `size`/`filter`/`has` over lists | pass | pass (filter returns internal `CelList`) |
| Unknown variable, pre-evaluation | **caught by `env.check()`** | not caught by `plan()`; `CelError` at eval |
| Unknown field on declared shape, pre-evaluation | **caught, incl. inside macro bodies** | no declared-shape checking exposed |
| Type error (`int == string`), pre-evaluation | caught | n/a (no public check) |
| Syntax error | `ParseError` with caret | `ParseSyntaxError` with position |
| Official cel-spec conformance suite in CI | no | **yes** (documented skip list) |

---

## Verdict

**Pin `@marcbachmann/cel-js` (exact, 8.0.0 at time of writing) behind the usine expression seam.** It is the only maintained TS/JS evaluator with a public check phase, and that check phase demonstrably delivers #8's promise verbatim: declare each stream's payload slice as an `Environment` type, and unknown variables, unknown payload paths (even inside `exists`/`filter` bodies), type mismatches and syntax errors all fail at file-validation time with position-annotated errors ready for the quarantine UI. Macros over lists — usine's dominant workload — pass. MIT, zero dependencies, 222 KB, active.

The seam contract should expose exactly three operations — `check(expr, streamEnv)`, `parse(expr, streamEnv) → thunk`, `evaluate(thunk, payload)` — normalize `bigint`→string at the interpolation boundary, and carry contract tests pinning the semantics usine relies on. `@bufbuild/cel` is the designated fallback behind the same seam: better conformance pedigree, worse fit for the validation promise (no public check phase; unknown-path detection would become usine-side AST work).

**Build-our-own is not warranted.** The scoping answer the ticket asked for: a CEL-subset parser (operators, literals, member access, the 6 macros) plus evaluator plus a declared-environment checker is roughly the three components marcbachmann's `lib/` already implements (parser.js ~900 lines, type-checker.js, evaluator.js — zero-dep, MIT). We would be rewriting a library that exists, is active, and is swappable behind our own seam — with none of its 13 months of edge-case hardening. The seam, not ownership of the parser, is what protects usine.
