# Usine

An agent-agnostic software factory: an engine that runs coding agents on software-work state (GitHub issues, PRs) according to loops that users define. The engine provides the building blocks. Every loop is user-defined, and none is built in.

## Language

Glossary terms are lowercase common nouns in UI copy and in documentation prose. They are capitalized only as headings and in code identifiers. The voice rules for the web UI are in the Voice section of `apps/web/DESIGN.md`, and UI copy follows those rules, not the phrasing of this file.

**Loop**:
A user-defined automation: a trigger, a selection of matched items, and an agent action per item. Authored as a file in the instance repo: the file is the source of truth, the filename is the loop's name, and the UI reads and writes that file.
_Avoid_: workflow (reserved for a possible future multi-step graph), schedule, task, cron

**Instance repo**:
The operator-owned git repo the orchestrator is pointed at, containing every loop file, the registry, and the instance settings. It is separate from the usine engine, and managed repos contain no instance files.
_Avoid_: config repo, factory repo

**Registry**:
The declaration, inside the instance repo, of the repos that the instance manages, with optional tags for selection.
_Avoid_: repo list, inventory

**Managed repo**:
A repo declared in the registry, for the engine to run loops against. The instance needs no write access to it for configuration. It is the registry-level mechanism beneath a project.
_Avoid_: target repo

**Project**:
A managed repo as the operator sees it: the repo with the board, runs, and usine activity for that repo. The sidebar lists every project of the instance.
_Avoid_: repo (for the operator-facing surface: the registry declares managed repos, and the operator works in projects)

**Board**:
A project's kanban view: the project's tasks grouped into lanes, with each task's run history on the task's card. A task's current item determines the task's lane, except while the task's newest open run is running: its card then stays in the lane whose label the run's trigger matched, since a loop often removes that label first. The board is also a trigger surface: dragging a card writes the label swap to the task's current item on GitHub.
_Avoid_: kanban (the form, not the name), pipeline

**Overview**:
The operator's first page across all projects, at `/`: what needs the operator's attention (Needs attention), the running attempts, each stalled item that a loop's trigger matches, with the stall reason, the recent runs, and the workers' slots. The code and the API call it the desk (`/api/desk`).
_Avoid_: desk (on screen), home, dashboard. The overview read (`/api/overview`) that every page uses is not this page.

**Task**:
A piece of work as the operator sees it, joining explicitly linked issues and pull requests within one project and the runs on those items. A task's current item is the item with the newest open run, otherwise the latest open PR, latest settled PR, or originating issue.
_Avoid_: Run (one execution of a loop), Item (one issue or PR). The lower-case `task` field is the rendered prompt given to an agent.

**Lane**:
One column of a board, mapping one or more GitHub labels or state sources. Configured per repo and two-way synced with the labels, with defaults proposed from the repo's existing labels. usine never deletes a label.
_Avoid_: column, status, stage

**Selector**:
A loop's optional narrowing, by name or tag, of the managed repos that the loop applies to. A loop without a selector applies to every managed repo.
_Avoid_: filter (the trigger's selection expression matches items within a trigger, and a selector selects repos)

**Trigger**:
The standing condition that fires a loop: a stream narrowed by a selection expression over item payloads, or a schedule. Each firing produces an event.
_Avoid_: event (one deduplicated match, not the condition), watcher, filter (the selection expression is the filter, and there is no separate filter construct)

**Stream**:
The class of software-work state that a trigger is evaluated against: issues or pull requests in managed repos, or the clock for schedules. A trigger has exactly one stream. The catalog (`issue`, `pr`, `schedule`) is part of the engine and is deliberately small.
_Avoid_: source, feed, event type

**Tick**:
One scheduled firing instant of a schedule trigger, identified by the time it was scheduled for, not by the time it actually ran. After downtime, only the latest missed tick fires.
_Avoid_: cron job, firing, interval

**Payload slice**:
The defined portion of GitHub's object graph that the engine fetches as an item's payload for one stream, in GitHub's shapes and names throughout. The slice only determines which graph edges are included. Selection expressions and prompt interpolation are both evaluated against it.
_Avoid_: event shape, custom schema

**Event**:
One deduplicated fact that the engine processes, with a dedup key and a payload: a trigger matching GitHub state, an operator approval, or the operator running a run again. The engine derives the dedup key from the event's content, per trigger type, and the key is never authored in the loop file. Apart from timestamps, the same state is always the same event.
_Avoid_: firing, occurrence, message

**Hint**:
A droppable request for the engine to fetch the state of a repo or an item before the next poll. Produced by usine's own GitHub writes and, when enabled, by webhook deliveries. A hint affects latency only and is never a correctness source: polling is the backstop that detects every change, and the dedup ledger deduplicates a change fetched twice.
_Avoid_: webhook event (a delivery is one hint source, not the concept), push, notification

**Item**:
The piece of software-work state that the engine runs a loop against: an issue or PR in a managed repo, with a stable identity and changing content. Coarser than an event: many events can concern one item.
_Avoid_: matched item (long form), target, resource

**Lifecycle**:
The path of one piece of work through the engine: the engine opens a run for a deduplicated event, the run's named step is tried as attempts, and exactly one closed state ends the run.
_Avoid_: run model (ADR 0002's name for the same path), workflow, state machine (the closing mechanism, not the whole path)

**Run**:
The work done for one event of a loop. There is never more than one open run per dedup key. Open states: pending, waiting, queued, running. Closed states: succeeded, failed, canceled.
_Avoid_: execution, job, workflow run

**Step**:
A named unit inside a run, with a stored result addressable by name. Exactly one per run in v1 (the agent action). The loop file declares the name, which is the step's identity: renaming makes a new step.
_Avoid_: stage, node, activity (a workflow-engine term, not the domain concept)

**Attempt**:
One try of a step on a worker. A retry is a new attempt under the same step, never a new run. Only typed infra errors are retried automatically, up to a cap. An agent failure requires operator action.
_Avoid_: retry (the act, not the record, which is an attempt)

**Attempt window**:
When an attempt was at work on its run's item: from its start until its outcome was recorded, and open while it runs. Every attempt on a local or SSH worker writes to GitHub as the same App, so the run reader gives a write on the item to the attempt whose window holds it, and the harvest keeps a signed comment only when it was posted in its own attempt's window and in no other attempt's of the same agent. A write that two windows hold belongs to neither.
_Avoid_: session (the parent's or a child's harness conversation), lease (a worker slot reservation)

**Reattach**:
The orchestrator continuing an open attempt after a restart when the durable task of the attempt's Pi parent is still live, with the same identity, number, and worktree, and without using a retry. Applies to every worker. A reattachment whose worktree is gone fails, and the next attempt starts fresh.
_Avoid_: retry (starts a new attempt), takeover (operator intervention in a live session)

**Approval**:
An operator's go-ahead for a run of a loop with an approval gate. Recorded as an event, not a flag, which the run consumes in the waiting state. The event includes the operator login that gave the approval and the channel: the web UI or a 👍 on the ask.
_Avoid_: confirmation, sign-off

**Ask**:
A request from usine for an operator answer on a blocked run, posted where the operator will see it. Two shapes: yes/no (approve, retry, restart, or cancel), closed by a reaction, and question (an agent's clarification request), answered in prose by a reply addressed to usine. The live attempt is parked until a question's answer arrives. Only the operator's own login can answer either shape.
_Avoid_: notification (how an ask is delivered, not what it is), prompt, request, question (one shape of ask, not the concept)

**Takeover**:
The operator stepping into a live session of a running attempt: operator messages are added to the session as user turns, in the Pi parent and harness children alike. Taking over a session places a hold. Recorded in the transcript, never in the event ledger.
_Avoid_: attach (the mechanism, not the concept), remote control, child takeover (long form)

**Hold**:
The per-session state that a takeover creates. Until the operator releases the hold, an idle held child does not return a result to the parent, and an idle held Pi parent does not end the attempt, which stays open for the operator. The first operator message to a session creates the hold implicitly. An explicit release ends the hold, and a released parent then continues the task. Several sessions can be held at once.
_Avoid_: claim, lock, pause (the loop-level switch)

**Edit-and-retry**:
The operator amending a failed run before retrying it: the task text (the interpolated loop-body result), the agent, or both. The amendment is sticky. It rewrites the run's effective context, and every later attempt runs with that context until the next amendment. Each attempt's record shows what that attempt actually ran.
_Avoid_: modify-and-rerun, edit-and-restart

**Run again**:
The operator opening a new run for the item state of a succeeded or canceled run, with the task text and agent that edit-and-retry can amend. It is a separate operator event, so the polled event of that state stays linked to the original run, and a later poll of the unchanged item opens no run. The loop's approval gate and the item's cycle budget apply as they do to a polled event.
_Avoid_: rerun, retry (the next attempt of a failed run), restart

**Supersede**:
The engine canceling an item's open run, with the reason recorded, when a newer event for the same item arrives before any attempt starts, and opening a run for the newer event instead. A running attempt always finishes, and the newer state is evaluated again when that attempt ends. Engine behavior, never a loop-file setting.
_Avoid_: preempt, replace

**Revoke**:
The engine canceling a run with no started attempt because the run's item no longer matches the loop's trigger. Revoke never affects a running attempt. It is distinct from operator cancel and from supersede.
_Avoid_: cancel (the operator's act), expire

**Pause**:
The operator's loop-level switch. The engine opens no new runs from the triggers of a paused loop, but the operator can still run one of the loop's runs again. Pause is runtime state in the orchestrator, never written to the loop file, and existing runs are unchanged. A loop created in the UI starts paused, and unpausing arms it. A loop added through git starts unpaused.
_Avoid_: disable (deleting or renaming the file is how a loop is retired), stop

**Orchestrator**:
The long-running headless server that evaluates triggers, schedules work, stores state, and serves the UI. It runs locally or in the cloud, and the location never changes what it is.
_Avoid_: daemon, app, backend

**Worker**:
The place where an attempt's children run: a machine with the attempt's checkout. Local processes first, then remote workers (an exe.dev VM, or any Linux machine the orchestrator connects to over SSH) behind the same seam. Every attempt's Pi parent runs in the orchestrator, whatever the worker.
_Avoid_: runner, sandbox, executor (the seam may be named executor in code, but the concept is Worker)

**Run host**:
No longer exists. The one-shot usine process that hosted an attempt's Pi parent on a worker, until the Pi parent was moved into the orchestrator (ADR 0006).

**Attempt channel**:
The attempt-scoped messages for one attempt's activity: normalized session events sent from the attempt's parent and children, and session-addressed operator input (steer, interrupt, takeover messages) sent to them. The parent's durable task relays these messages inside the orchestrator. The messages are the same wherever the children run.
_Avoid_: stream (reserved for what a trigger is evaluated against), pipe, socket

**Transcript**:
The persisted sequence of one attempt's activity, made of the attempt channel messages. The run drawer replays it live or afterwards. The orchestrator stores this durable record beyond the end of the attempt.
_Avoid_: log, session history, output

**Preflight**:
The executor's verify-only readiness check of a worker: the toolchain, enough memory for the worker's concurrent attempts, each rostered harness and the harness login where children run on the worker, and the worker's long-lived credentials, such as exe.dev's GitHub integrations. It fails with typed capability errors and never installs anything: making a worker ready is out-of-band. Local and SSH workers have no long-lived GitHub credential: each attempt's installation token is minted when the attempt is prepared, and a refusal there stops the attempt before launch.
_Avoid_: bootstrap, provisioning (the out-of-band act), health check

**Gateway**:
The host in front of worker VMs that have no public address. It provides the workers' SSH bastion, resolver, and time server, the proxy that adds the GitHub credential, and any LLM credential stored on the gateway, to the workers' requests, and the forward proxy to an allowlist of package hosts and the hosts of the harness logins used on the workers. A worker behind the gateway has no GitHub token and can connect to no other host (ADR 0027).
_Avoid_: edge, NAT, firewall (one of the gateway's parts)

**Attachment**:
One attempt's installation token, which the executor gives to the gateway for one worker and one repository. The attachment is in force until the token expires or the attempt's cleanup detaches it.
_Avoid_: grant (exe.dev's term for its own), integration, binding

**Caller token**:
The value that an attempt's children send to the gateway instead of a credential. It identifies the attachment, the worker, and the repository, and the gateway accepts it only while that attachment is in force.
_Avoid_: API key, placeholder (how a harness uses it, not what it is)

**Agent**:
A named entity in the instance: a persona with standing instructions, plus the brain spec for running it (harness, model, reasoning effort). Each agent is a file in the instance repo, and the filename is the agent's identity. Every loop specifies the agent for the loop's runs.
_Avoid_: profile, bot, teammate, persona (the body text is the persona, and the entity is the Agent)

**Harness**:
The coding-agent runtime set in an agent's brain spec (Claude Code, Codex CLI, or Pi), driven as a child of the run's Pi parent session. Changing an agent's harness means editing that one field, never rewriting the agent or the loops that use the agent.
_Avoid_: backend, adapter (the usine code that drives a harness, not the concept), runner, agent (the named Agent entity, not the runtime)

**Pool**:
The billing source that an attempt's usage is charged to: API keys (API-key-authenticated Pi sessions), the Claude plan (Claude Code children), or the ChatGPT plan (Codex children and subscription-authenticated Pi parents). Usage in each pool is measured by that pool's native meter. A pool is not a harness: two harnesses can share one pool.
_Avoid_: budget (an amount, not a source), account, quota

**Runaway guard**:
The per-attempt ceiling (wall-clock time and consumed tokens) that interrupts an attempt running without progress. Each ceiling is opt-in in `usine.yaml` and absent by default. An armed ceiling sends the parent session one warning at 80%, before it trips. The wall-clock count pauses while an ask or a hold is open, because an attempt blocked on or supervised by the operator is never a runaway, and the token ceiling stays armed throughout. A tripped ceiling fails the attempt with a dedicated error class that is never retried automatically. Only the operator can restart a runaway.
_Avoid_: budget, timeout (the wall-clock half only), kill switch

**Salvage**:
What the executor preserves of an attempt's worktree when the attempt ends without success: uncommitted changes committed as a work-in-progress snapshot and HEAD pushed to `usine/salvage/<run>/<attempt>`, recorded on the attempt. The next attempt of the same run starts from a pushed salvage, rebased onto the current revision, and a salvage that conflicts with that revision is left on the salvage branch. When the push fails, the executor leaves the worktree on the worker and records the worktree path instead.
_Avoid_: backup, checkpoint, recovery branch

**Child-session budget**:
The maximum number of child sessions that a parent can spawn during one attempt. The budget counts sequential and concurrent spawns. A spawn beyond the budget fails the attempt, which then requires operator action.
_Avoid_: child concurrency, concurrent-children cap

**Cycle budget**:
The number of rounds that loops can run on one item before the operator must reset the budget. A round permits each participating loop one run, and retries stay within that run. On exhaustion, the engine opens an item-level ask and stops further unattended work on the item.
_Avoid_: review count, retry limit, token budget

**Block**:
A standalone piece of the engine, published separately so that an orchestrator can be assembled from parts. The usine orchestrator is the first composition, not the only intended one.
_Avoid_: module (any code unit, while a block is published), component, plugin
