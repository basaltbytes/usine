# usine

usine runs loops against many repositories from one headless orchestrator. A loop is a file in git that defines a trigger and the agent run it starts, with any coding-agent harness. The spec is `CONTEXT.md` and the ADRs in `docs/adr/`, indexed by the wayfinder map [#1](https://github.com/basaltbytes/usine/issues/1).

Before you name a concept, read the glossary in `CONTEXT.md`.

## Agent skills

### Issue tracker

Issues are in GitHub Issues on `basaltbytes/usine`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

The repo has one context: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

`CONTEXT.md` defines each term in one or two sentences. Put behavior rules in ADRs and code, not in the glossary.

`apps/docs/src/content/docs/architecture/index.mdx` maps what is built: packages, processes, storage, workers, and gaps. Each page states the commit it describes.

### Writing

Write all prose in the [Google developer documentation style](https://developers.google.com/style): code comments, docs, the glossary, ADRs, changesets, and PR text. For doc comments, follow [API reference code comments](https://developers.google.com/style/api-reference-comments).

### Coding

Before you write or review code, load the `coding-guidelines` skill. When you touch TypeScript, also load the `effect-ts` skill: the monorepo uses Effect v4 throughout, with services, layers, typed errors, and Schema at every boundary.

Rules:

- Fix review findings in the PR under review. A logic flaw, stall risk, or architecture gap is a change request, not a follow-up.
- Make everything observable from the first commit. Name spans with `Effect.fn`, annotate them with domain IDs, and emit structured `Effect.log*` at every decision point (skips, resets, backoffs, terminal outcomes), so the logs explain why nothing happened. Handle every error in a typed channel: log before `Effect.ignore`, isolate per-item failures so other items continue, and crash only on defects.
- Cloudflare Workers and D1 are the first cloud target. Keep package modules platform-free, put Node adapters behind their own subpath exports, and keep platform services in layer requirements. See `@usine/engine/local-sqlite` and ADR 0020.
- If files share a name prefix, put them in a folder named after the prefix and drop it from the file names (`store/{store,codec,queries}.ts`).
- Keep identities with their domain records and operations (`RunId` with `Run`). Split models by responsibility.
- Name public subpaths by capability (`@usine/github/polling`). Export same-package symbols explicitly and keep implementation details private. See [ADR 0012](docs/adr/0012-published-blocks-monorepo-layout.md).
- Import definitions from their owning package. Use named imports, except for tagged-union namespaces (`RunState.Failed`).
- Give a core branded schema, its brand, and its exported type the same name (`RepositoryName`).
- Comment only what the name and signature don't say, such as a unit, an error case, or a side effect. Put design rationale in the commit, the PR body, or an ADR.
- Build the web UI from the shadcn registry on Tailwind tokens. Before you change `apps/web`, read "How to add UI" in `apps/web/README.md` and load the `react-app-structure` skill for file placement.
- Use snake_case keys in authored YAML (`usine.yaml`, loop and agent frontmatter) and camelCase in domain fields. Rename keys once, at the parse boundary, with `Schema.encodeKeys`; see `Settings` in `@usine/config`.
