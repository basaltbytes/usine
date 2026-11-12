# usine

usine runs loops against many repositories from one headless orchestrator. A loop defines a trigger and the agent run it starts, with any coding-agent harness. Configuration is stored in the instance database; files are an import and export format. `CONTEXT.md` is the glossary. The ADRs in `docs/adr/` record why decisions were taken.

Before you name a concept, read the glossary in `CONTEXT.md`.

## Direction

usine must work with whichever model provider and login the operator has, on machines they choose.

- **Three harnesses.** Pi reaches API keys and the subscriptions it supports, across providers. Claude Code is required for a Claude subscription, which works only inside it. Codex is the ChatGPT subscription's client. None is the default, and none is folded into another. Subscriptions and API keys are both supported.
- **Roles are declarations.** Write every role (the coordinator, the supervisor, the coding agent, and later roles) against the harness contract in `@usine/agents`. A role states the capabilities it needs; a harness descriptor states what it provides for each credential route, and refuses a role it can't serve, with a reason.
- **No provider names in generic places.** Don't name a provider or harness in a role's interface, a configuration value, an issue title for a generic feature, or a prerequisite.
- **One credential.** A feature uses the credential the attempt already has.
- **One way to call a model.** Every model call goes through the harness contract.
- **The coordinator applies rules to events.** It replaces the Pi parent session (#1150), with no parent model. Configuration selects it with `coordinator: session | events` on the instance or an agent (#1158). Until #1166 merges, the Pi parent coordinates `session` attempts.
- **Names.** The supervisor observes and operates the factory. The orchestrator is the server. The coordinator decides what an attempt does next.
- **Platform tools first.** For a worker provider, start from the goal and use the platform's own transport, snapshots, and network rules, even when an existing interface has to change.
- **Storage behind ports.** SQLite and Postgres adapters, with a contract suite per port.
- **Configuration in the database.** Files are an import and export format.

`docs/adr/` records the reasons. ADRs never block a change.

## Agent skills

### Issue tracker

Issues are in GitHub Issues on `basaltbytes/usine`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

The repo has one context: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

`CONTEXT.md` defines each term in one or two sentences. Put behavior rules in code and tests, not in the glossary. ADRs record why a decision was taken; they never block a change. When your change contradicts an ADR, make the change and rewrite the ADR in the same pull request so that it states the current decision and its reasons in at most 400 words. Don't append an amendment; git keeps the history. When the decision no longer exists, delete the ADR. Most changes need no ADR: put the reason in the pull request body. Write a new ADR only for a decision that is hard to reverse, surprising without context, and the result of a real trade-off.

`docs/architecture/index.mdx` maps what is built: packages, processes, storage, workers, and gaps. Each page states the commit it describes.

### Writing

Write all prose in the [Google developer documentation style](https://developers.google.com/style): code comments, docs, the glossary, ADRs, changesets, and PR text. For doc comments, follow [API reference code comments](https://developers.google.com/style/api-reference-comments).

A pull request that changes behavior visible to users (CLI, configuration, web UI, operator API, or workers) updates the matching guide or reference page under `apps/docs/src/content/docs/` in the same pull request. Describe the resulting behavior in the present tense.

In changesets, release web changes as `@usine/server`; never name `@usine/web` or another private package.

### Coding

Before you write or review code, load the `coding-guidelines` skill. When you touch TypeScript, also load the `effect-ts` skill: the monorepo uses Effect v4 throughout, with services, layers, typed errors, and Schema at every boundary.

Rules:

- Fix review findings in the PR under review. A logic flaw, stall risk, or architecture gap is a change request, not a follow-up.
- Make everything observable from the first commit. Name spans with `Effect.fn`, annotate them with domain IDs, and emit structured `Effect.log*` at every decision point (skips, resets, backoffs, terminal outcomes), so the logs explain why nothing happened. Handle every error in a typed channel: log before `Effect.ignore`, isolate per-item failures so other items continue, and crash only on defects.
- Keep package modules platform-free, put Node adapters behind their own subpath exports, and keep platform services in layer requirements. See `@usine/engine/local-sqlite`.
- If files share a name prefix, put them in a folder named after the prefix and drop it from the file names (`store/{store,codec,queries}.ts`).
- Keep identities with their domain records and operations (`RunId` with `Run`). Split models by responsibility.
- Name public subpaths by capability (`@usine/github/polling`). Export same-package symbols explicitly and keep implementation details private. See [ADR 0012](docs/adr/0012-published-blocks-monorepo-layout.md).
- Import definitions from their owning package. Use named imports, except for tagged-union namespaces (`RunState.Failed`).
- Give a core branded schema, its brand, and its exported type the same name (`RepositoryName`).
- Comment only what the name and signature don't say, such as a unit, an error case, or a side effect. Put design rationale in the commit, the PR body, or an ADR.
- Build the web UI from the shadcn registry on Tailwind tokens. Before you change `apps/web`, read "How to add UI" in `apps/web/README.md` and load the `react-app-structure` skill for file placement. The components in `apps/web/src/components/ui/` are our code. Some come from shadcn, but they are meant to be tweaked, changed, and improved (that's the shadcn philosophy) and are never updated from the registry, so the usual code quality, constraints, and conventions apply to them.
- Use snake_case keys in exported and imported YAML (`usine.yaml`, loop and agent frontmatter) and camelCase in domain fields. Rename keys once, at the parse boundary, with `Schema.encodeKeys`; see `Settings` in `@usine/config`.
