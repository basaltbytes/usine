# Usine

usine runs coding agents against GitHub issues and pull requests, using loops that the operator defines.

## Language

In UI copy and documentation, write glossary terms as lowercase common nouns. Capitalize them only in headings and code identifiers. For UI copy, follow the Voice section of `apps/web/DESIGN.md`.

**Loop**:
A named definition within a project of a trigger and the agent run to start for each matched item.
_Avoid_: workflow, schedule, task, cron

**Instance repo**:
The git repo that contains an instance’s bootstrap files and configuration import and export files.
_Avoid_: config repo, factory repo

**Revision**:
A recorded change to the instance configuration, with a number, actor, time, optional message, and each entity’s value before and after the change.
_Avoid_: config commit, version

**Registry**:
The list of managed repos in the instance configuration, with optional tags.
_Avoid_: repo list, inventory

**Managed repo**:
A repo that the registry declares and that loops run against.
_Avoid_: target repo

**Project**:
A named group of managed repos with one board and the loops that run on them.
_Avoid_: repo (in the UI)

**Member**:
A GitHub login that can sign in to an instance. What it can see and do comes from its role bindings.
_Avoid_: user, account

**Role binding**:
A grant of one role to a member, on the instance or on one project. Instance roles: admin. Project roles: viewer, operator, maintainer.
_Avoid_: permission, ACL entry

**Board**:
The kanban view of a project's tasks, grouped into lanes. Dragging a card changes the labels of the task's current item on GitHub.
_Avoid_: kanban, pipeline

**Overview**:
The page at `/` that lists, across all projects, statistics, items that need attention, running attempts, stalled items, recent runs, and worker slots. In code and in the API, it's called the desk (`/api/desk`); its statistics come from `/api/statistics` and `/api/statistics/runs`.
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
A repo name or tag that limits which repositories in a project a loop applies to. A loop without a selector applies to every repository in its project.
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
The work for one event of a loop. Only one run per dedup key can be open. Open states are `pending`, `waiting`, `queued`, `running`, and `awaiting CI`; closed states are `succeeded`, `handed off`, `failed`, and `canceled`.
_Avoid_: execution, job, workflow run

**CI wait**:
The interval after an agent session ends during which a run waits for checks on its recorded pull request head.

**Step**:
A named unit of a run with a stored result and step outputs. In v1, each run has one step: the agent action.
_Avoid_: stage, node, activity

**Step output**:
A typed JSON document that an attempt writes in its checkout and the orchestrator stores with the step result.
_Avoid_: artifact, attachment, file

**Attempt**:
One try of a step on a worker. A retry creates a new attempt in the same run.
_Avoid_: retry

**Attempt window**:
The time from an attempt's start to its recorded outcome. The run reader uses it to assign GitHub writes to an attempt.
_Avoid_: session, lease

**Reattach**:
To resume an open attempt after an orchestrator restart, if its coordinator is still live: the Pi parent's durable task, or the event-driven coordinator's attempt journal.
_Avoid_: retry, takeover

**Approval**:
An event that lets a run of a gated loop leave the `waiting` state. It records the approving member's login; the web UI is the only approval channel.
_Avoid_: confirmation, sign-off

**Ask**:
A request for an operator decision, such as an agent's question or blocker or an exhausted cycle budget. The operator answers it in Needs attention.
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

**Suppression**:
The state in which a loop opens no run for an item's current state, because an attempt ended with a question or blocker. A later different item state, a retry, or resolving the run's failure lifts it.
_Avoid_: hold, pause

**Pause**:
A loop flag that stops new runs from the loop's triggers. The orchestrator stores it, not the loop file.
_Avoid_: disable, stop

**Orchestrator**:
The headless server that evaluates triggers, schedules attempts, stores state, and serves the UI.
_Avoid_: daemon, app, backend

**Worker**:
A machine that runs an attempt's harness children in a checkout: local, an exe.dev VM, or an SSH host. The Pi parent always runs in the orchestrator.
_Avoid_: runner, sandbox, executor

**Provisioner**:
The setting of an SSH worker that creates and retires machines at Hetzner Cloud, Boat, or boxd (ADR 0029). A worker with one is a provisioned worker.
_Avoid_: autoscaler, pool, fleet

**Attempt channel**:
The messages of one attempt: session events from its parent and children, and operator input to a session.
_Avoid_: stream, pipe, socket

**Transcript**:
The stored attempt channel messages of one attempt.
_Avoid_: log, session history, output

**Preflight**:
A check that a worker can run attempts. It fails with typed capability errors and installs nothing; an SSH worker's preflight pulls its attempt image.
_Avoid_: bootstrap, provisioning, health check

**Attempt container**:
The container that runs every command of one attempt on an SSH worker, with only that attempt's checkout and credentials mounted (ADR 0011).
_Avoid_: sandbox, box, VM

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
A named definition of standing instructions and a brain spec (harness, model, reasoning effort).
_Avoid_: profile, bot, teammate, persona

**Harness**:
The CLI or SDK that runs an agent session: Claude Code, Codex, or Pi. An agent's brain spec names it.
_Avoid_: backend, adapter, runner, agent

**Role**:
What a session does for usine, such as the coordinator, the coding agent, or the supervisor. A role states the placements, credential routes, tools, and persistence it needs; admission refuses a harness that lacks one. A member's access comes from a role binding instead.
_Avoid_: agent type, mode, persona

**Supervisor**:
The role that observes and operates the factory for a member, with the operator tools that the member's token allows. It runs on the orchestrator with the instance's `supervisor` brain and keeps its conversation between turns.
_Avoid_: orchestrator agent, assistant, operator agent

**Usine tool set**:
The tools that usine gives a session through the harness contract, defined once as a toolkit. The role that opens the session supplies their handlers, so it decides what each call can reach.
_Avoid_: MCP tools, custom tools, plugin

**Completion**:
One schema-checked value that a harness returns for one prompt, with no saved conversation.
_Avoid_: structured call, one-shot

**Pool**:
The billing source for an attempt's usage: API keys, the Claude plan, or the ChatGPT plan.
_Avoid_: budget, account, quota

**Runaway guard**:
Optional per-attempt limits on wall-clock time and tokens, set in `usine.yaml`. Exceeding a limit fails the attempt without an automatic retry.
_Avoid_: budget, timeout, kill switch

**Salvage**:
The branch `usine/salvage/<run>/<attempt>` that the executor pushes with the work of an attempt that didn't succeed. The run's next attempt starts from it.
_Avoid_: backup, checkpoint, recovery branch

**Coordinator**:
What starts an attempt's children and turns their reports into the attempt's outcome: a Pi parent session, or the event-driven coordinator, which handles each attempt lifecycle event with a rule, or a child's report with a completion from the decision brain, and has no parent session.
_Avoid_: orchestrator, supervisor

**Coordinator kind**:
The `coordinator` setting of an instance or agent: `session`, where a parent session coordinates the attempt, or `events`, where the event-driven coordinator does.
_Avoid_: parent kind, `parent: pi | none`

**Decision brain**:
The model and effort that decide a child's report for the event-driven coordinator, set by an agent's `decision` field; the harness is the agent's own.
_Avoid_: parent model, decision harness

**Child-session budget**:
The maximum number of child sessions that an attempt's coordinator can start in one attempt.
_Avoid_: child concurrency, concurrent-children cap

**Cycle budget**:
The number of rounds that loops can run on one item before the operator must reset it.
_Avoid_: review count, retry limit, token budget

**Block**:
A separately published engine package.
_Avoid_: module, component, plugin
