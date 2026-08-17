# The instance repo needs no remote; runtime toggles live in the DB, not the file

[ADR 0001](./0001-loops-live-in-the-instance-repo.md) stands — loops, agents, registry, and lane maps are files in the instance repo, and UI edits to them commit to its default branch. This ADR fixes two edges that decision left open. First: the instance repo requires **no remote** — `usine init` scaffolds a local `git init` repo invisibly, commits are engine-authored plumbing, and a remote (GitHub or otherwise) becomes necessary only for the three things that genuinely need one: sharing the factory, backing it up, and moving the orchestrator off the machine. Sharing — the original motivation for loops-as-files — works by publishing the repo (public repo, template), not by a separate export format. Second: the file/DB boundary is **authored vs. runtime**. What the operator authors (loop bodies, agents, lane maps, settings) is a file and commits; what the operator toggles at runtime (pausing a loop) is orchestrator state in the DB, alongside runs and events. A loop file describes what the loop *is*; the DB records what the factory is *doing about it*.

## Considered Options

- **Everything commits** (pause as `paused: true` frontmatter) — keeps the file the whole truth, but a commit per toggle-flip is ceremony where the operator wants a switch, and it pollutes the authored history with operational noise.
- **Config in the DB, files as export** (n8n's model) — serves sharing via export/import but forfeits git history, PR-reviewable loop edits, and agents editing loops with plain file tools; reverses ADR 0001 for a problem the remote-optional reading already solves.
- **Remote-optional repo + authored/runtime split** (chosen) — git stays the substrate but disappears as ceremony; the awkwardness that motivated reconsidering ADR 0001 turned out to live entirely on the runtime-toggle side of the line.

## Consequences

- A factory works day one with no GitHub account linkage for its own config; managed repos still need API access as before.
- Pause/unpause is instant, survives restarts via the DB, and leaves no commit noise — but a paused loop's file no longer tells that one fact; the UI must surface paused state wherever the loop appears.
- The persistence ticket inherits pause marks (with runs, cursors, intervention marks) in its durable-state inventory.
- Which storage the DB uses (SQLite vs Postgres) remains the persistence ticket's decision; nothing here constrains it beyond local-first.
