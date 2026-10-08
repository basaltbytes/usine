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
A repo declared in the registry — what loops watch and act on. The factory needs no write access to it for configuration. The registry-level mechanism beneath a Project.
_Avoid_: target repo

**Project**:
A managed repo as the operator sees it — the repo plus its board, runs, and factory activity. The home surface lists the factory's projects.
_Avoid_: repo (for the operator-facing surface; the registry declares managed repos, the operator works in projects)

**Board**:
A project's kanban view — its tasks grouped into lanes, with their Run histories on the cards. A task's current Item determines its lane. Dragging a card writes the label swap to that Item on GitHub, so the board doubles as a trigger surface.
_Avoid_: kanban (the form, not the name), pipeline

**Task**:
A piece of work as the operator sees it, joining explicitly linked issues and pull requests within one Project and the Runs on those Items. Its current Item is the one with the newest open Run, otherwise its latest open PR, latest settled PR, or originating issue.
_Avoid_: Run (one execution of a Loop), Item (one issue or PR); the lower-case `task` field is the rendered prompt given to an Agent

**Lane**:
One column of a board, mapping one or more GitHub labels or state sources. Configured per repo; defaults are proposed from the repo's existing labels, two-way synced — usine never deletes a label.
_Avoid_: column, status, stage

**Selector**:
A loop's optional narrowing of which managed repos it applies to, by name or tag; without one, a loop applies to every managed repo.
_Avoid_: filter (the trigger's selection expression matches items within a trigger; a selector selects repos)

**Trigger**:
The standing condition that fires a loop — a watched stream narrowed by a selection expression over item payloads, or a schedule. What it produces when it fires is an Event.
_Avoid_: event (that's one deduplicated match, not the condition), watcher, filter (the selection expression plays the filter role; there is no separate filter construct)

**Stream**:
The class of software-work state a trigger watches — issues or pull requests in managed repos, or the clock for schedules. A trigger names exactly one; the catalog — `issue`, `pr`, `schedule` — is engine-owned and deliberately small.
_Avoid_: source, feed, event type

**Tick**:
One scheduled firing instant of a schedule trigger, identified by the time it was scheduled for — not when it actually ran. After downtime, only the latest missed tick fires.
_Avoid_: cron job, firing, interval

**Payload slice**:
The defined portion of GitHub's object graph fetched as an item's payload for one stream — GitHub's shapes and names throughout, the slice choosing only which graph edges come along. Selection expressions and prompt interpolation both range over it.
_Avoid_: event shape, custom schema

**Event**:
One deduplicated fact the engine may react to, carrying a dedup key and payload — a trigger matching GitHub state, or an operator approval. The dedup key is derived by the engine per trigger type from the event's content — timestamps aside, the same state is the same Event, forever — never authored in the loop file.
_Avoid_: firing, occurrence, message

**Hint**:
A droppable nudge telling the engine to fetch a repo's or an item's state sooner than the next poll — produced by usine's own GitHub writes and, when enabled, by webhook deliveries. Latency only, never a correctness source: polling remains the backstop that sees every change, and the dedup ledger absorbs double-sees.
_Avoid_: webhook event (a delivery is one hint source, not the concept), push, notification

**Item**:
The piece of software-work state a loop acts on — an issue or PR in a managed repo, identified apart from its changing content. Coarser than an Event: many Events can concern one Item.
_Avoid_: matched item (long form), target, resource

**Lifecycle**:
How one piece of work moves through the engine — a deduplicated Event opens a Run, the Run's named Step is tried as Attempts, and exactly one closed state ends it.
_Avoid_: run model (ADR 0002's name for the same arc), workflow, state machine (the closing mechanism, not the journey)

**Run**:
The work a loop owes one Event — at most one open per dedup key, ever. Open states: pending, waiting, running; closed: succeeded, failed, canceled.
_Avoid_: execution, job, workflow run

**Step**:
A named unit inside a run whose stored result is addressable by name; exactly one per run in v1 (the agent action). The loop file names it, and the name is its identity — renaming makes a new step.
_Avoid_: stage, node, activity (the Effect mechanism underneath, not the domain concept)

**Attempt**:
One try of a step on a worker. Retries are new attempts under the same step, never new runs; only typed infra errors retry automatically, capped — agent failures wait for the operator.
_Avoid_: retry (the act; the record is an attempt)

**Reattach**:
The orchestrator continuing an open Attempt after a restart when its parent task is still live, preserving the Attempt's identity, number, and worktree without spending a retry. Applies to local Workers; a remote Worker's lost run-host connection remains an infrastructure failure eligible for capped retry as a new Attempt.
_Avoid_: retry (starts a new Attempt), takeover (operator intervention in a live session)

**Approval**:
An operator's go-ahead for a run gated by its loop — recorded as an Event the waiting run consumes, not a flag.
_Avoid_: confirmation, sign-off

**Ask**:
The factory's request for an operator answer on a blocked run, posted where the operator will see it. Two shapes: yes/no — approve, retry, restart, or cancel, closed by a reaction — and question — an agent's clarification request, answered in prose by a reply addressing the factory. A question parks its live attempt until the answer arrives; only the operator's own login can answer either shape.
_Avoid_: notification (how an ask travels, not what it is), prompt, request, question (one shape of ask, not the concept)

**Takeover**:
The operator stepping into a live session of a running attempt — operator messages join the session as user turns, Pi parent and harness children alike. Taking over a child places a Hold. Lives in the transcript, never the Event ledger.
_Avoid_: attach (the mechanism, not the concept), remote control, child takeover (long form)

**Hold**:
The per-child state a takeover creates — an idle held child defers returning its result to the awaiting parent until the operator releases it. Implicit on the first operator message to the child, ended by an explicit release; several children can be held at once.
_Avoid_: claim, lock, pause (the loop-level switch)

**Edit-and-retry**:
The operator amending a failed run before retrying it — the task text (the interpolated loop-body result), the agent, or both. Sticky: the amendment rewrites the run's effective context and every later attempt runs it until amended again; each attempt records what it actually ran.
_Avoid_: modify-and-rerun, edit-and-restart

**Supersede**:
What a newer Event does to the same Item's open run before any attempt starts: cancels it (reason recorded) and takes its place. A running attempt always finishes — the newer state is judged again once it ends. Engine behavior, never a loop-file setting.
_Avoid_: preempt, replace

**Revoke**:
The engine canceling a run no attempt has started because its Item no longer matches the loop's trigger. Never touches a running attempt; distinct from operator cancel and from supersede.
_Avoid_: cancel (the operator's act), expire

**Pause**:
The operator's loop-level switch: a paused loop opens no new runs. Runtime state in the orchestrator, never written to the loop file; existing runs are untouched. Loops created in the UI are born paused — unpausing is the arming act; a loop arriving by git is born unpaused.
_Avoid_: disable (deleting/renaming the file is how a loop retires), stop

**Orchestrator**:
The long-running headless server that evaluates triggers, schedules work, holds state, and serves the UI. Runs locally or in the cloud; where it runs never changes what it is.
_Avoid_: daemon, app, backend

**Worker**:
The place an agent run executes — a machine with a checkout. Local process first; remote executors (e.g. exe.dev) behind the same seam.
_Avoid_: runner, sandbox, executor (the seam may be named executor in code, but the concept is Worker)

**Run host**:
The one-shot usine process an executor launches on a remote Worker for a single Attempt, hosting its Pi parent session and returning the Step result when it exits. A local Worker's Pi parent runs in the orchestrator as a durable task.
_Avoid_: runner, daemon, worker process

**Attempt channel**:
The duplex channel between the orchestrator and a remote Worker's run host for one Attempt: normalized events flowing out and session-addressed operator input (steer, interrupt, takeover messages) flowing in as attempt-scoped framed messages. The byte transport underneath never changes the messages.
_Avoid_: stream (reserved for what a trigger watches), pipe, socket

**Transcript**:
The persisted flow of one Attempt's activity, which the run drawer replays live or after the fact, including Attempt channel events for remote Workers. The orchestrator stores this durable record beyond the Attempt's lifetime.
_Avoid_: log, session history, output

**Preflight**:
The executor's verify-only readiness check of a Worker: toolchain, login state, attached credentials, and, for remote Workers, run-host and protocol versions, failing with typed capability errors. It never installs; making a Worker ready is out-of-band.
_Avoid_: bootstrap, provisioning (that's the out-of-band act), health check

**Agent**:
A named member of the factory's team — a persona with standing instructions plus the brain spec that runs it (harness, model, reasoning effort). Defined as a file in the instance repo, filename as identity; every loop names the agent that owns its runs.
_Avoid_: profile, bot, teammate, persona (the body text is the persona; the entity is the Agent)

**Harness**:
The coding-agent runtime an agent's brain spec names — Claude Code, Codex CLI, or Pi — driven as a child of the run's Pi parent session. Swapping an agent's harness is editing that one field, never rewriting the agent or its loops.
_Avoid_: backend, adapter (the usine code that drives a harness, not the concept), runner, agent (a named team member, not the runtime)

**Pool**:
The billing source an attempt's usage draws from — API keys (API-key-authenticated Pi sessions), the Claude plan (Claude Code children), or the ChatGPT plan (Codex children and subscription-authenticated Pi parents). Each pool keeps its native meter; a pool is not a harness — two harnesses can share one pool.
_Avoid_: budget (an amount, not a source), account, quota

**Runaway guard**:
The per-attempt ceiling — wall-clock and consumed tokens — that interrupts an attempt burning without progress. Each ceiling is opt-in in `usine.yaml` and absent by default; an armed ceiling warns the parent session once at 80% before tripping. The wall-clock pauses while an ask or a hold is open: waiting on — or supervised by — the operator is never runaway; the token ceiling stays armed throughout. Tripping it fails the attempt with its own error class, which never auto-retries; only the operator restarts a runaway.
_Avoid_: budget, timeout (the wall-clock half only), kill switch

**Salvage**:
What the executor preserves of an Attempt's worktree when the Attempt ends without success: uncommitted changes committed as a work-in-progress snapshot and HEAD pushed to `usine/salvage/<run>/<attempt>`, recorded on the Attempt. The next Attempt of the same Run starts from a pushed salvage. A salvage whose push failed keeps the worktree on the Worker and records its path instead.
_Avoid_: backup, checkpoint, recovery branch

**Child-session budget**:
The maximum number of child sessions a parent may spawn during one Attempt. It counts sequential and concurrent spawns; the next spawn fails the Attempt and requires operator action.
_Avoid_: child concurrency, concurrent-children cap

**Cycle budget**:
The number of rounds an Item's Loops may perform before the operator must reset it. A round permits each participating Loop one Run; retries remain within that Run. Exhaustion opens an Item-level Ask and stops further unattended work on the Item.
_Avoid_: review count, retry limit, token budget

**Block**:
A standalone piece of the engine, published on its own so a factory can be assembled from parts — usine's orchestrator is the first composition, not the only intended one.
_Avoid_: module (any code unit; a block is published), component, plugin
