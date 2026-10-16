# usine

An agent-agnostic software factory: an engine on which loops — trigger → agent-run automations authored as files in git — run against many repos from one headless orchestrator. Planning is complete (2026-08-21): the spec is `CONTEXT.md` + ADRs 0001–0019 in `docs/adr/`, indexed by the closed wayfinder map [#1](https://github.com/basaltbytes/usine/issues/1).

Read `CONTEXT.md` for the domain glossary before naming concepts.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `basaltbytes/usine` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

`apps/docs/src/content/docs/architecture/index.md` is the map of what is built: packages, processes, storage, Workers, and gaps, each page dated to the commit it describes.

### Coding

Before writing or reviewing code, load the `coding-guidelines` skill — the Basaltbytes charter every line of usine follows.

The monorepo is Effect v4 end to end — services, layers, typed errors, Schema at every boundary. Load the `effect-ts` skill alongside it whenever you touch TypeScript here.

Standing rules:

- Fix review findings in the PR under review: a logic flaw, stall risk, or architecture gap is a change request, never a note deferred to later — early packages set the precedent later agents copy.
- Everything shipped is observable and debuggable from day one: name spans with `Effect.fn`, annotate them with the domain ids, and emit structured `Effect.log*` at every decision point (skips, resets, backoffs, terminal outcomes) so absence of action is explainable from logs alone. Handle errors exhaustively in typed channels: never swallow one (log before `Effect.ignore`), isolate per-item failures so siblings continue, and reserve crashes for defects.
- Cloudflare Workers/D1 is the first cloud target: package modules stay platform-free, Node adapters live behind their own subpath exports, and platform services stay in layer requirements (`@usine/engine/local-sqlite` and ADR 0020 are the precedent).
- Files sharing a name prefix become a folder at creation, prefix dropped (`store/{store,codec,queries}.ts`).
- Keep identities with their domain records and operations (`RunId` with `Run`); split models by responsibility.
- Name public subpaths by capability (`@usine/github/polling`). Explicitly select same-package exports and keep implementation details private. See [ADR 0012](docs/adr/0012-published-blocks-monorepo-layout.md).
- Import definitions directly from their owning package; use named imports except for tagged-union namespaces (`RunState.Failed`).
- Give core branded schemas, their brands, and their exported types the same domain name (`RepositoryName`).
- Document exported elements in domain terms: what they represent, what arguments mean, and what callers can expect beyond the TypeScript signature. Keep implementation reasoning beside the code it explains, and link an ADR when it explains a rule.
- Web UI is built from the shadcn registry on Tailwind tokens: read the "How to add UI" section of `apps/web/README.md` before touching `apps/web`.
- Authored YAML surfaces (`usine.yaml`, loop/agent frontmatter) use snake_case keys; domain fields are camelCase. The rename happens once, at the parse boundary, via `Schema.encodeKeys` — file casing never leaks into domain types (`@usine/config`'s `Settings` is the precedent).
