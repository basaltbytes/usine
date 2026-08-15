# Usine

An agent-agnostic software factory: an engine on which users define loops that watch software-work state (GitHub issues, PRs) and act on it by running coding agents. The engine provides the building blocks; the loops are user-defined, not built in.

## Language

**Loop**:
A user-defined automation: a trigger, a selection of matched items, and an agent action per item. Authored as a file in the instance repo — the file is the source of truth, its filename is the loop's name, and the UI round-trips through it.
_Avoid_: workflow (reserved for a possible future multi-step graph), schedule, task, cron

**Instance repo**:
The operator-owned git repo the orchestrator is pointed at — holds every loop file, the registry, and factory settings. Separate from the usine engine; managed repos carry no factory files.
_Avoid_: config repo, factory repo

**Registry**:
The declaration, inside the instance repo, of which repos the factory manages, with optional tags for selection.
_Avoid_: repo list, inventory

**Managed repo**:
A repo declared in the registry — what loops watch and act on. The factory needs no write access to it for configuration.
_Avoid_: project, target repo

**Selector**:
A loop's optional narrowing of which managed repos it applies to, by name or tag; without one, a loop applies to every managed repo.
_Avoid_: filter (the trigger's selection expression matches items within a trigger; a selector selects repos)

**Trigger**:
The standing condition that fires a loop — a watched stream narrowed by a selection expression over item payloads, or a schedule. What it produces when it fires is an Event.
_Avoid_: event (that's one deduplicated match, not the condition), watcher, filter (the selection expression plays the filter role; there is no separate filter construct)

**Stream**:
The class of software-work state a trigger watches — issues or pull requests in managed repos, or the clock for schedules. A trigger names exactly one; the catalog is engine-owned and deliberately small.
_Avoid_: source, feed, event type

**Payload slice**:
The defined portion of GitHub's object graph fetched as an item's payload for one stream — GitHub's shapes and names throughout, the slice choosing only which graph edges come along. Selection expressions and prompt interpolation both range over it.
_Avoid_: event shape, custom schema

**Event**:
One deduplicated fact the engine may react to, carrying a dedup key and payload — a trigger matching GitHub state, or an operator approval. The dedup key is derived by the engine per trigger type, never authored in the loop file.
_Avoid_: firing, occurrence, message

**Item**:
The piece of software-work state a loop acts on — an issue or PR in a managed repo, identified apart from its changing content. Coarser than an Event: many Events can concern one Item.
_Avoid_: matched item (long form), target, resource

**Run**:
The work a loop owes one Event — at most one open per dedup key, ever. Open states: pending, waiting, running; closed: succeeded, failed, canceled.
_Avoid_: execution, job, workflow run

**Step**:
A named unit inside a run whose stored result is addressable by name; exactly one per run in v1 (the agent action). The loop file names it, and the name is its identity — renaming makes a new step.
_Avoid_: stage, node, activity (the Effect mechanism underneath, not the domain concept)

**Attempt**:
One try of a step on a worker. Retries are new attempts under the same step, never new runs; only typed infra errors retry automatically, capped — agent failures wait for the operator.
_Avoid_: retry (the act; the record is an attempt)

**Approval**:
An operator's go-ahead for a run gated by its loop — recorded as an Event the waiting run consumes, not a flag.
_Avoid_: confirmation, sign-off

**Supersede**:
What a newer Event does to the same Item's open run: cancels it (reason recorded) and takes its place. Engine behavior per trigger type, never a loop-file setting.
_Avoid_: preempt, replace

**Orchestrator**:
The long-running headless server that evaluates triggers, schedules work, holds state, and serves the UI. Runs locally or in the cloud; where it runs never changes what it is.
_Avoid_: daemon, app, backend

**Worker**:
The place an agent run executes — a machine with a checkout. Local process first; remote executors (e.g. exe.dev) behind the same seam.
_Avoid_: runner, sandbox, executor (the seam may be named executor in code, but the concept is Worker)

**Agent**:
A named member of the factory's team — a persona with standing instructions plus the brain spec that runs it (harness, model, reasoning effort). Defined as a file in the instance repo, filename as identity; every loop names the agent that owns its runs.
_Avoid_: profile, bot, teammate, persona (the body text is the persona; the entity is the Agent)

**Harness**:
The coding-agent runtime an agent's brain spec names — Claude Code, Codex CLI, or Pi — driven as a child of the run's Pi parent session. Swapping an agent's harness is editing that one field, never rewriting the agent or its loops.
_Avoid_: backend, adapter (the usine code that drives a harness, not the concept), runner, agent (a named team member, not the runtime)
