# usine

An agent-agnostic software factory: an engine on which loops — trigger → agent-run automations authored as files in git — run against many repos from one headless orchestrator. Planning is complete (2026-08-21): the spec is `CONTEXT.md` + ADRs 0001–0019 in `docs/adr/`, indexed by the closed wayfinder map [#1](https://github.com/basaltbytes/usine/issues/1).

Read `CONTEXT.md` for the domain glossary before naming concepts.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `basaltbytes/usine` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Coding

Before writing or reviewing code, load the `coding-guidelines` skill — the Basaltbytes charter every line of usine follows.

The monorepo is Effect v4 end to end — services, layers, typed errors, Schema at every boundary. Load the `effect-ts` skill alongside it whenever you touch TypeScript here.

Standing rules:

- Fix review findings in the PR under review: a logic flaw, stall risk, or architecture gap is a change request, never a note deferred to later — early packages set the precedent later agents copy.
- Cloudflare Workers/D1 is the first cloud target: package root entries stay platform-free, Node adapters live behind subpath exports, and platform services stay in layer requirements (`@usine/engine/local-sqlite` and ADR 0020 are the precedent).
- Files sharing a name prefix become a folder at creation, prefix dropped (`store/{store,codec,queries}.ts`).
- Authored YAML surfaces (`usine.yaml`, loop/agent frontmatter) use snake_case keys; domain fields are camelCase. The rename happens once, at the parse boundary, via `Schema.encodeKeys` — file casing never leaks into domain types (`@usine/config`'s `Settings` is the precedent).
