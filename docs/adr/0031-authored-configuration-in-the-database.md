# Authored configuration in the database, with revisions

Loops, agents, workers, lane maps, the registry, and settings move from files in the instance repo to tables in the runtime store, which becomes their only source of truth. Decided on 2026-10-28 ([#633](https://github.com/basaltbytes/usine/issues/633)). This replaces the file parts of [ADR 0001](./0001-loops-live-in-the-instance-repo.md), [ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md), and [ADR 0016](./0016-config-editing-forms-first-preview-before-arming.md).

ADR 0001 kept usine files out of the managed repos, so the configuration ended up in a separate repository, the instance repo. The operator's verdict after two months of use: that repository is a remote database with a worse interface. It has no schema check at write time, no transactions, no per-member permissions, and no live reads; loop files load at startup, and a `usine.yaml` change needs a reload or a restart. Without a remote (ADR 0009), its history exists on one disk, and the UI doesn't show it. On 2026-10-27 the dogfood instance's agents moved from Claude to Codex through an uncommitted file edit, with no author, time, or reason recorded. The form editors of ADR 0016 were never built, so the UI can only pause and unpause loops. Two needs make files unworkable:

- **Members and remote clients** ([ADR 0030](./0030-operator-api-authentication-and-access-control.md)). A configuration change must pass the API's authorization and record the member who made it. A file edited over SSH bypasses both, and an iOS app or a UI on another origin can change configuration only through the API.
- **Projects with several repositories.** A project has repositories, lanes, and loops, which are rows and links, not a YAML registry.

The decision:

- **The database is the only source of truth** for authored configuration, in the runtime store ([ADR 0010](./0010-single-sqlite-runtime-store.md)) through Drizzle, which keeps Postgres and D1 possible ([ADR 0020](./0020-drizzle-portable-sqlite-projection.md)).
- **Every change is a revision**: the member, the time, the entity, its value before and after, and an optional message. Reverting a change creates a new revision. The UI shows each entity's history and diff. Schema and CEL checks run before a revision is saved, so the stored configuration is always valid.
- **Revisions apply live**, with no reload or restart. A loop that a revision creates starts paused, as ADR 0016 required for loops created in the UI.
- **A loop belongs to a project**, a named group of managed repos, and runs on every repository in it unless its selector narrows it to some. The board shows the project's tasks from all its repositories in one set of lanes.
- **Files are an import and export format only.** `usine config export` and `usine config import` use today's Markdown and frontmatter format, for templates, backups, and bulk edits. `usine config edit <entity>` opens `$EDITOR` and saves the result as a revision. Nothing syncs with git.
- **Files keep only bootstrap values and secrets**: `.env` or a secret store, the GitHub App key, and the listen address. Secrets never go into configuration tables.
- **Migration**: the first start of the version that has the tables imports the instance folder as revision 1, attributed to the instance's `operator:` value, and keeps each loop's pause state. Each managed repo becomes a project with one repository. Later starts ignore the folder.

## Considered options

- **Keep the files** (ADR 0001 and ADR 0009): git history, loop edits reviewable in PRs, and agents editing loops with file tools. In practice the instance repo has no remote, nobody reviews loop edits in PRs, and the UI shows no history, while files can't enforce a member's permissions or record who changed them.
- **Files with a UI writer through the YAML AST** (ADR 0016, never built): the files stay, but every API write rewrites YAML and commits to a local repository, edits made outside the API still bypass authorization, two members editing one file conflict, and reads still need a reload.
- **The database with an optional git sync**, where a push to a git repository is imported as a revision: suits teams that review configuration in PRs, but two write paths conflict, and a failed sync needs error states of its own.
- **The database with export and import** (chosen): one write path through the API, with authorization and a revision for every change.

## Consequences

- ADR 0009 rejected "config in the database, files as export" because it lost git history, PR-reviewable loop edits, and agents editing loops with file tools. Revisions replace the git history and show it in the UI, and `usine config export`, `import`, and `edit` replace the file tools; review of configuration in PRs is dropped.
- Form edits save fields to the database, so they don't need ADR 0004's targeted YAML-AST writer, and export writes whole files. A raw editor in the UI edits an entity in the export format.
- An import that fails validation saves no revision, so the quarantine of invalid files is no longer needed for configuration that the API writes.
- The runtime store is the whole configuration, so a backup of the store is a backup of the instance's configuration, with the secrets files beside it.
- The glossary's loop, instance repo, registry, and project change meaning. The project entry changes with this ADR; the others change when #633's implementation replaces the files.
- Every guide and reference page that tells the reader to edit `usine.yaml` or a loop file changes with the implementation.
