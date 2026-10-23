# Instance repo without a remote; runtime toggles in the database

[ADR 0001](./0001-loops-live-in-the-instance-repo.md) stands: loops, agents, registry, and lane maps are instance repo files, and UI edits commit to its default branch.

The instance repo needs **no remote**: `usine init` creates a local git repo, and the engine writes the commits. A remote is needed only to share the instance, back it up, or move the orchestrator off the machine. Sharing, the original reason for loops as files, means publishing the repo (public repo, template), not an export format.

The file/database boundary is **authored versus runtime**: authored content (loop bodies, agents, lane maps, settings) is committed files, and runtime toggles (pausing a loop) are database state, with runs and events.

## Considered options

- **Everything commits** (pause as `paused: true` frontmatter): the file stays the whole truth, but a commit per toggle is ceremony for a switch, and noise in authored history.
- **Config in the database, files as export** (n8n's model): supports sharing by export and import, but loses git history, PR-reviewable loop edits, and agents editing loops with file tools. It reverses ADR 0001 for a problem the optional remote already solves.
- **Optional remote with an authored/runtime split** (chosen): git stays the storage, with no ceremony. What prompted revisiting ADR 0001 was entirely on the runtime-toggle side.

## Consequences

- An instance works from day one with no GitHub account linked for its own config; managed repos still need API access.
- Pause and unpause are instant, survive restarts in the database, and add no commits. A paused loop's file no longer shows the pause, so the UI must show it wherever the loop appears.
- The persistence ticket adds pause marks (with runs, cursors, intervention marks) to its durable-state inventory.
- The persistence ticket still picks the database (SQLite or Postgres); this ADR only requires local-first.
