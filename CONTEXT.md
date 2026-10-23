# Usine

usine runs coding agents against GitHub issues and pull requests, using loops that the operator defines in files.

## Language

In UI copy and documentation, write glossary terms as lowercase common nouns. Capitalize them only in headings and code identifiers. For UI copy, follow the Voice section of `apps/web/DESIGN.md`.

**Loop**:
A file in the instance repo that defines a trigger and the agent run to start for each matched item. The filename is the loop name.
_Avoid_: workflow, schedule, task, cron

**Instance repo**:
The git repo that contains the loops, agents, registry, and settings of an instance.
_Avoid_: config repo, factory repo

**Registry**:
The list of managed repos in the instance repo, with optional tags.
_Avoid_: repo list, inventory

**Managed repo**:
A repo that the registry declares and that loops run against.
_Avoid_: target repo

**Project**:
The UI page for one managed repo, with its board, runs, and activity.
_Avoid_: repo (in the UI)

**Board**:
The kanban view of a project's tasks, grouped into lanes. Dragging a card changes the labels of the task's current item on GitHub.
_Avoid_: kanban, pipeline

**Overview**:
The page at `/` that lists, across all projects, items that need attention, running attempts, stalled items, recent runs, and worker slots. In code and in the API, it's called the desk (`/api/desk`).
_Avoid_: desk (in the UI), home, dashboard

**Task**:
A group of linked issues and pull requests in one project, with their runs.
_Avoid_: run, item

**Current item**:
The item of a task that the board places in a lane: the item with the newest open run, or else the latest open PR, the latest closed PR, or the originating issue.

**Lane**:
A board column that maps to one or more GitHub labels or item states.
_Avoid_: column, status, stage

**Selector**:
A repo name or tag that limits the managed repos a loop applies to. A loop without a selector applies to all managed repos.
_Avoid_: filter

**Trigger**:
The condition that starts a loop: a stream with a selection expression, or a schedule.
_Avoid_: event, watcher, filter

**Stream**:
The kind of state that a trigger evaluates: `issue`, `pr`, or `schedule`.
_Avoid_: source, feed, event type

**Tick**:
One scheduled time of a schedule trigger. After downtime, only the latest missed tick fires.
_Avoid_: cron job, firing, interval

**Payload slice**:
The fields of GitHub's object graph that the engine fetches for an item of a given stream. Selection expressions and prompt templates read from it.
_Avoid_: event shape, custom schema

**Event**:
A deduplicated input to the engine: a trigger match, an approval, or a run-again request. The engine derives its dedup key from its content.
_Avoid_: firing, occurrence, message

**Hint**:
An optional request to fetch a repo or item before the next poll. Hints reduce latency; polling still detects every change.
_Avoid_: webhook event, push, notification

**Item**:
An issue or pull request in a managed repo.
_Avoid_: matched item, target, resource

**Lifecycle**:
The sequence for one event: open a run, try its step as one or more attempts, and close the run.
_Avoid_: run model, workflow, state machine

**Run**:
The work for one event of a loop. Only one run per dedup key can be open. Open states are `pending`, `waiting`, `queued`, and `running`; closed states are `succeeded`, `failed`, and `canceled`.
_Avoid_: execution, job, workflow run

**Step**:
A named unit of a run with a stored result. In v1, each run has one step: the agent action.
_Avoid_: stage, node, activity

**Attempt**:
One try of a step on a worker. A retry creates a new attempt in the same run.
_Avoid_: retry

**Attempt window**:
The time from an attempt's start to its recorded outcome. The run reader uses it to assign GitHub writes to an attempt.
_Avoid_: session, lease

**Reattach**:
To resume an open attempt after an orchestrator restart, if its Pi parent's durable task is still live.
_Avoid_: retry, takeover

**Approval**:
An event that lets a run of a gated loop leave the `waiting` state. It records the operator login and the channel (web UI or 👍 on the ask).
_Avoid_: confirmation, sign-off

**Ask**:
A request for an operator answer on a blocked run: either yes/no, answered with a reaction, or a question, answered with a reply.
_Avoid_: notification, prompt, request, question

**Takeover**:
Sending operator messages to a running attempt's session as user turns. A takeover places a hold.
_Avoid_: attach, remote control, child takeover

**Hold**:
A session state that stops an idle child from returning its result, and stops an idle Pi parent from ending the attempt, until the operator releases it.
_Avoid_: claim, lock, pause

**Edit-and-retry**:
Retrying a failed run with a changed task text, agent, or both. The change applies to all later attempts.
_Avoid_: modify-and-rerun, edit-and-restart

**Run again**:
An operator event that opens a new run for the item state of a succeeded or canceled run.
_Avoid_: rerun, retry, restart

**Supersede**:
To cancel an item's open run because a newer event for the item arrived before any attempt started, and open a run for the newer event.
_Avoid_: preempt, replace

**Revoke**:
To cancel a run with no started attempt because its item no longer matches the trigger.
_Avoid_: cancel, expire

**Pause**:
A loop flag that stops new runs from the loop's triggers. The orchestrator stores it, not the loop file.
_Avoid_: disable, stop

**Orchestrator**:
The headless server that evaluates triggers, schedules attempts, stores state, and serves the UI.
_Avoid_: daemon, app, backend

**Worker**:
A machine that runs an attempt's harness children in a checkout: local, an exe.dev VM, or an SSH host. The Pi parent always runs in the orchestrator.
_Avoid_: runner, sandbox, executor

**Run host**:
Removed in ADR 0006.

**Attempt channel**:
The messages of one attempt: session events from its parent and children, and operator input to a session.
_Avoid_: stream, pipe, socket

**Transcript**:
The stored attempt channel messages of one attempt.
_Avoid_: log, session history, output

**Preflight**:
A read-only check that a worker can run attempts. It fails with typed capability errors and never installs anything.
_Avoid_: bootstrap, provisioning, health check

**Gateway**:
A host that gives worker VMs without a public address SSH access, DNS, time, credential injection for GitHub and LLM requests, and an allowlisted forward proxy (ADR 0027).
_Avoid_: edge, NAT, firewall

**Attachment**:
An attempt's installation token, registered on the gateway for one worker and one repo until it expires or is detached.
_Avoid_: grant, integration, binding

**Caller token**:
The token that an attempt's children send to the gateway instead of a credential. The gateway accepts it while its attachment is valid.
_Avoid_: API key, placeholder

**Agent**:
A file in the instance repo that defines standing instructions and a brain spec (harness, model, reasoning effort). The filename is the agent name.
_Avoid_: profile, bot, teammate, persona

**Harness**:
The coding-agent CLI in an agent's brain spec: Claude Code, Codex CLI, or Pi.
_Avoid_: backend, adapter, runner, agent

**Pool**:
The billing source for an attempt's usage: API keys, the Claude plan, or the ChatGPT plan.
_Avoid_: budget, account, quota

**Runaway guard**:
Optional per-attempt limits on wall-clock time and tokens, set in `usine.yaml`. Exceeding a limit fails the attempt without an automatic retry.
_Avoid_: budget, timeout, kill switch

**Salvage**:
The branch `usine/salvage/<run>/<attempt>` that the executor pushes with the work of an attempt that didn't succeed. The run's next attempt starts from it.
_Avoid_: backup, checkpoint, recovery branch

**Child-session budget**:
The maximum number of child sessions that a parent can start in one attempt.
_Avoid_: child concurrency, concurrent-children cap

**Cycle budget**:
The number of rounds that loops can run on one item before the operator must reset it.
_Avoid_: review count, retry limit, token budget

**Block**:
A separately published engine package.
_Avoid_: module, component, plugin
