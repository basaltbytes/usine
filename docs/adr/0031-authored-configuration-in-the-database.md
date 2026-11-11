# Authored configuration in the database, with revisions

Settings, workers, repositories, projects, labels, loops, agents, and role bindings are entities in the instance database, their only source of truth (ADR 0010). Every change is a revision: the actor, the time, an optional message, and each entity's value before and after. A revert saves a new revision. Validation runs before saving, so stored configuration is always valid. Revisions apply live, except tracing, sign-in, and worker kind changes, which wait for the next start. A loop that a revision creates starts paused, so new work is armed on purpose.

Managed repositories contain no usine files. A loop belongs to a project and runs on every repository in it unless its selector narrows it. Loops in each repository would copy generic loops into all of them and make a loop edit need commit access everywhere.

Files are an import and export format only: `usine config export`, `import`, and `edit` use Markdown with YAML frontmatter, and nothing syncs with git. Startup imports the instance folder only into an empty database. Files keep only bootstrap values and secrets: `.env`, the GitHub App credentials, the listen address, and the instance ID. Configuration names a secret by its environment variable, never its value.

An instance repository of files was a remote database with a worse interface: no schema check at write time, no transactions, no per-member permissions, and no live reads. Members and remote clients (ADR 0030) must pass the API's authorization and be recorded as the author of each change, which a file edited over SSH bypasses.

## Considered options

- **Loops in managed repositories**, alone or overriding instance loops by name: copies per repository, and two discovery and write paths.
- **An instance repository of files**: git history and file tools, but no permissions or live reads, and nobody reviewed loop edits in pull requests.
- **The UI writing files through the YAML syntax tree**: outside edits still bypass authorization, and members editing one file conflict.
- **The database with a git sync**: two conflicting write paths, and sync failures that need states of their own.
