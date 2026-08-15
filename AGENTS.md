# usine

An agent-agnostic software factory: an engine on which loops — trigger → agent-run automations authored as files in git — run against many repos from one headless orchestrator. Planning phase: the active wayfinder map is [#1](https://github.com/basaltbytes/usine/issues/1).

Read `CONTEXT.md` for the domain glossary before naming concepts.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `basaltbytes/usine` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
