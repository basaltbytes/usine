# Pi runs every agent; the operator defines named agents

usine's agent layer is one adapter, the in-process Pi SDK. Every run is a Pi parent session whose usine subagents extension starts real harnesses as scoped children (in v1: Claude Code through the Claude Agent SDK, Codex through `codex app-server` JSON-RPC over stdio, Pi through the SDK). Agents are files, `agents/<name>.md` in the instance repo: the frontmatter is the brain spec (harness, model, normalized reasoning effort, optional parent model), and the body is the persona. Every loop must set `agent:` (ADR 0004's slot). A run's prompt is the context preamble, persona, and interpolated loop body; children also get the persona.

## Considered options

- **Flat per-harness adapters**: no parent session or token cost, but no in-run orchestration, and one 0.x adapter per harness to maintain.
- **Pi-only layer** (issue #4's first resolution): Pi calls provider APIs directly. Smallest surface, but no vendor-harness behavior or subscription billing, which the operator requires.
- **Pi parent with a subagents extension** (chosen): proven by davis7dotsh/my-pi-setup. The parent orchestrates real harness sessions on the operator's subscriptions, usine's seam is one adapter, and the multi-harness code is a reusable Pi extension.

## Consequences

- usine writes the extension: unlicensed, my-pi-setup is only a design reference (backend contract, normalized event stream, streaming-input bridge, interrupt semantics). It uses Effect v4, exact-pinned dependencies (`@earendil-works/pi-coding-agent`, `@anthropic-ai/claude-agent-sdk`, the app-server protocol), and live contract tests against the real CLIs.
- Claude children draw the Claude plan's monthly Agent SDK credit (capped API-rate credit, 2026-06-15 policy), and OAuth stays within the terms because the child is Claude Code. Codex children use the ChatGPT plan. The Pi parent bills API keys (instance default model in `usine.yaml`, per-agent override). _Revised by [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)_: the credit was paused before taking effect. Claude children use the plan's usage windows, metered by usine in estimated USD.
- Children run headless with permissions bypassed (`bypassPermissions` / `approvalPolicy: never`); the worker seam isolates them. Workers provide harness binaries, login state, and a duplex channel for events and steer/interrupt.
- The engine validates only its own shapes (harness enum, effort scale `off|minimal|low|medium|high|xhigh|max`). Model ids pass through; an unknown one fails the attempt with a typed error. Runs record what actually started.
- Acceptance loops are harness-free: to change a loop's brain, edit its agent file.

## Amendment (2026-09-03, #102)

Parent reasoning effort is configured, not inherited: `settings.parent_effort` in `usine.yaml` sets the default, and `parent_effort` in an agent file overrides it, like the parent model. Unset, it uses the child's effort. A parent model that can't run the resolved effort fails the attempt with a typed error before the session starts; the SDK doesn't clamp it.

## Amendment (2026-10-08, #176)

The subagents extension is now a pi-durable extension (`@usine/durable`), and the Pi parent runs in the orchestrator, not a worker run host. Each attempt is a `usine.attempt` task with its parent conversation, and the `subagent` tool is the parent's only tool. pi-durable commits the conversation, each tool call's intent, and its output so far before showing anything, so an orchestrator restart resumes the attempt instead of failing it.

The parent's system prompt remains the `usine` section alone because its only tool is `subagent`, children read the worktree's `AGENTS.md` themselves, and three weeks of internal use ran with this prompt (#185).

Unchanged: the parent's model, effort, and pool resolution, the child-session budget, `[usine:blocked]` reports, and the three child backends. A child is a vendor process the parent can't replay, so the tool isn't replay-safe. After a restart, its call ends as interrupted with the committed output, and the parent model decides whether to delegate again. Resuming the vendor session by recorded id comes later.

Every child and its commands get exactly the attempt's environment, because the orchestrator's own contains the App private key ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)). It's never stored, so after a restart new children wait for the executor. Interrupting the parent aborts its current turn and children, rather than blocking its next tool call. The parent is then on hold until operator guidance or a release ([ADR 0018](./0018-takeover-and-edit-and-retry.md)).

## Amendment (2026-11-02, #820): child task preservation

The runtime includes the stored rendered loop task unchanged in every child's initial prompt. This includes edit-and-retry amendments. The parent's `subagent.task` argument supplies supplemental context or a focused assignment within that task; conflicting parent context does not replace the task's instructions.

The durable runtime records the exact child prompt on `SessionStarted.prompt`, alongside saved harness session metadata. The run page displays it in the attempt details, including when the launch is outside the loaded transcript page. Older transcripts omit the prompt.

## Amendment (2026-11-05, #953): role admission

Harness descriptors declare capabilities for each credential route and placement. One `admitBrain` policy checks configuration, worker preflight, coordinator start, and child launch. The coordinator requires `durable-coordination`; Pi on the orchestrator provides it through pi-durable. Claude Code and Codex resume conversations without a journal of usine tool intents and results, so their descriptors refuse that role with a reason. The supervisor role runs on the orchestrator through gateway credentials, which keeps subscription credentials on the gateway.

This replaces harness-specific placement refusals with role requirements. `parent_model` and `parent_effort` remain the parent settings because only Pi provides durable coordination. Startup validates every rostered agent's resolved parent model, effort, and credential before the engine starts. A refusal quarantines that agent and its loops and appears in Needs attention. The operator UI remains available so the operator can repair a bad model or missing credential without recovering the server through the filesystem. Configuration imports, reloads, and saved edits repeat the check before accepting a revision, including changes to instance defaults or agent overrides. CLI imports and saved edits reject invalid parent brains before writing to the store, so an offline edit cannot leave a refused revision waiting for the next restart. A corrected reload restores quarantined agents and loops. Each attempt repeats admission to detect changed credentials.

## Amendment (2026-11-05, #959): saved Pi child conversations

Pi children persist conversations in a session directory under each attempt checkout and expose an explicit resume operation by saved Pi ID. This makes a child conversation available after its process exits, while keeping the files with the attempt that owns them. `SessionStarted.harnessSession` records the ID and directory, and the Pi descriptor declares `resume-session`. Preflight probes remain in memory because they have no conversation to continue.

The October restart rule for the durable `subagent` call still applies: an in-flight call ends as interrupted after an orchestrator restart. Persisting a Pi conversation and resuming it through the Pi runtime does not replay that call. Durable child reattachment is tracked in #976.

## Amendment (2026-11-05, #976): durable child-session recovery

The durable `subagent` call is replay-safe because it records its delegation count and saved child conversation before exposing session events. The task-scoped document stores the child session, harness session ID and directory, original worker and machine, cumulative usage, and retained partial output. Replaying the call reuses its child ID and budget slot, waits for the executor to attach fresh host and environment values, and resumes the conversation in the original checkout. The call appends resumed events to the same attempt transcript and returns the child's final report.

Saved-session selection belongs to each harness runtime behind `ChildRequest.resume`; the durable tool has no harness-specific branches. The shared role admission policy adds `resume-session` to the coding-agent requirements for this launch. Codex replaces its retained remote transport before resuming the recorded thread so earlier JSON-RPC requests and responses cannot enter the new connection. Claude Code stops the retained remote process before resuming, and Pi opens its saved session directory.

This replaces the October rule that every in-flight child call ends as interrupted. Calls without a committed saved session still return as interrupted, as do calls whose original worker, machine, or checkout is unavailable, whose route lacks resume capability, or whose resume fails. They include the committed output so the parent can decide how to continue. Recovery resumes a conversation rather than replaying commands; the continuation prompt tells the child to inspect interrupted work before repeating it.

The delegation document also records the completed report from `SessionIdle` and clears it on `SessionResumed` or finish. Recovery restores an idle child without starting a turn, so Release returns its saved report and only operator guidance starts more work.

Operator holds and child pauses persist separately in the task supervision document. Recovery restores both before the harness starts a turn, so a restart cannot resume work that the operator interrupted. A paused child remains idle until a steer or operator message supplies guidance; releasing a hold preserves its pause. The runaway guard restores surviving child holds from the transcript before counting unsupervised time. Claude Code and Pi initialize their usage meters from the committed totals because their SDK usage resets when the process restarts.

## Amendment: shared child continuation policy (2026-11-06)

Native `resume(request, reference)` reopens a saved conversation without sending a prompt. A shared policy above Claude Code, Codex, and Pi controls continuation for both live transport recovery and durable restart. Working children receive one continuation instruction and unread operator messages; supervised children wait for guidance. Interrupted tool calls close as errors. The journal persists the native reference before the first prompt and the rolling continuation history before each recovery turn. A fourth continuation within ten minutes fails with a typed error. Failed reopening returns interrupted and retains the original child budget slot.

Claude's session UUID comes from usine before SDK startup. Operator messages carry UUIDs, with delivery acknowledged through Claude's `user_message_uuids` or correlated Codex native user-message items. Claude typed-prompt turns do not stamp every mid-turn fold, so a successful result's pending-send count also settles submitted message IDs that have no UUID receipt. Codex retains unconsumed input across turn boundaries and restores pending receipt IDs when reattaching to an active turn. The shared conversation receives message IDs for every acknowledgement; continuation decisions remain independent of each adapter's delivery evidence.

If Codex native history confirms that the saved thread is empty, the shared policy sends the original task as its first input. A thread with saved work receives the continuation instruction.
