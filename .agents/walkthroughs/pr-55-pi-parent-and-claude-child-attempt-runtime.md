---
walkthrough: 1
title: Pi parent and Claude child attempt runtime
pr: 55
commit: b2a26b01990bdef1c0a95d5b339deea6fdb6395d
meta:
  pr: "#55"
  commit: b2a26b0
  scope: agent runtime
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Attempts now run through live agent sessions" icon="agent" %}
This change replaces the default run-host stub with an in-process Pi parent and a headless Claude Code child. The orchestrator renders the loop task and freezes the payload, Agent, child brain, and parent model before execution. The run host then streams typed parent and child activity into the Attempt transcript.

The main review path is: **trigger evaluation → stored Run context → Attempt checkout → Pi parent → Claude child → protocol v2 transcript → terminal result**. The change also adds native parent steer and interrupt handling, persistence migrations, adapter tests, and an opt-in GitHub App contract test.
{% /section %}
{% /group %}

{% group label="Immutable agent context" %}
{% section id="trigger-context" title="Triggers freeze rendered work and roster data" icon="workflow" related=["stored-brain"] %}
Each loop resolves its named Agent from the loaded instance. The Agent-level parent model takes precedence over the instance default. The resulting object contains the persona, declared child brain, and effective parent model.

{% code file="packages/orchestrator/src/trigger-submission.ts" from=32 to=61 expect="/** Snapshot one authored loop's roster member and effective parent model. */" /%}

After a polling expression matches, the orchestrator renders the loop body through `ConfigParser.renderPrompt()`. It submits the rendered task with the exact item payload and resolved Agent context. Schedule Ticks use the same submission path and render against their Tick payload.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=243 to=269 expect="          const dedupKey = eventKey(loop, watched.repository, item, snapshot);" /%}

The parent prompt has a fixed order: repository and payload snapshot, Agent persona, rendered task, then the GitHub signature rule. A child gets a separate prompt with the same persona and signature because it does not inherit the parent prompt.

{% code file="packages/agents/src/prompt.ts" from=21 to=66 expect="/** Builds the complete parent prompt from immutable run context. */" /%}

Polling reports prompt and submission failures per repository without stopping sibling repositories. Schedule fanout reports failures per loop and repository. It also isolates Agent-resolution and cron-boundary failures, so one bad schedule does not stop other schedules.
{% /section %}

{% section id="stored-brain" title="Events, Runs, and Attempts retain execution context" icon="database" related=["trigger-context","session-activity"] %}
The database stores the submitted Agent and parent model on the immutable trigger Event route. It copies them to the Run's effective context when the Event is claimed. When execution starts, the engine copies the Run's child `BrainSpec` and parent model to the new Attempt row.

{% code file="packages/engine/src/store/store.ts" from=218 to=250 expect="        const number = Attempt.AttemptNumber.make((lastAttempt?.number ?? 0) + 1);" /%}

Two migrations backfill old rows with explicit legacy Agent and brain values before the new JSON columns become required. The schema also checks that each stored Agent and brain value is valid JSON.

{% callout tone="key" %}
The Attempt records the roster-declared child brain that Claude accepts before spawning. Model ids pass through unchanged, so an accepted alias is not rewritten to its resolved id. The child session descriptor uses that same brain, while the Pi `SessionStarted` activity records the parent model selected by the SDK.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Pi parent and Claude child" %}
{% section id="session-activity" title="One typed activity model covers parent and child sessions" icon="git-branch" related=["parent-runtime","attempt-channel"] %}
Core now owns the Agent brain and session schemas. `ParentSession` has no parent field. `ChildSession` has exactly one `parentId`. This structure makes recursive child activity unrepresentable in the public protocol.

The normalized activity union covers session start and finish, text output, and paired tool start and finish events. Each event carries its full session descriptor, so transcript readers can identify the Agent, brain, and parent relation without separate session state.

{% code file="packages/core/src/agent.ts" from=34 to=127 expect="/** Value object: the harness child that a run is declared to spawn. */" /%}
{% /section %}

{% section id="parent-runtime" title="Pi owns orchestration and the subagent tool" icon="ai-model" related=["claude-child","session-activity"] %}
`PiParentRuntime.launch()` creates an Attempt-scoped parent session. It starts the Pi SDK with the effective parent model, the Agent effort, and the usine-owned extension. An unknown configured model fails through `UnknownModelError` before prompt execution.

The adapter converts Pi text and tool events to normalized activity. It places parent events and forwarded child events on one queue. The final parent text becomes the step message. The returned session also exposes Pi's native `steer()` and `abort()` operations.

{% code file="packages/agents/src/pi/pi.ts" from=206 to=342 expect="  const launch: AgentRuntime[\"Service\"][\"launch\"] = Effect.fn(\"PiParentRuntime.launch\")(" collapsed=true /%}

The `subagent` tool creates a first-level child from the rostered child brain. It builds the child-only prompt, forwards child activity into the parent queue, waits for the child result, and returns that text as Pi tool output. If Pi aborts the tool call, the extension interrupts the child first.

{% code file="packages/agents/src/pi/subagents.ts" from=30 to=104 expect="/** Pi-owned extension factory. Its single tool can only create first-level child descriptors. */" /%}

{% callout tone="key" %}
Core validates `claude`, `codex`, and `pi` harness values, but this production child layer implements only Claude. A Codex or Pi child brain returns `UnsupportedHarnessError` before the child starts.
{% /callout %}
{% /section %}

{% section id="claude-child" title="Claude runs headlessly behind a narrow backend" icon="terminal" related=["parent-runtime","runtime-proof"] %}
The Claude adapter opens streaming input in the Attempt worktree. It disables session persistence and bypasses permission prompts because worker isolation remains the executor boundary. It maps `off` to disabled thinking and `minimal` to Claude's `low` effort.

Before prompt delivery, the adapter reads the SDK model registry and accepts either a model alias or its resolved id. It emits text deltas and tool activity. An unsuccessful result, an output stream that closes without a result, or an SDK failure becomes a typed `SessionOperationError`.

{% code file="packages/agents/src/pi/claude.ts" from=236 to=374 expect="  const launch: ChildBackend[\"Service\"][\"launch\"] = Effect.fn(\"ClaudeChildBackend.launch\")(" collapsed=true /%}

The child backend supports additional streaming user messages and SDK interrupt. The current Attempt channel has no child session id on inbound controls, so the run host sends operator `Steer` and `Interrupt` frames only to the live Pi parent. Child interrupt is currently used by the subagent abort path.
{% /section %}
{% /group %}

{% group label="Attempt protocol v2" %}
{% section id="attempt-channel" title="The run host bridges sessions to the transcript" icon="sync" related=["session-activity","runtime-proof"] %}
Protocol v2 extends `RunSpec` with the payload, Agent, and parent model. It replaces the old plain agent message with an `Activity` envelope that can contain parent or first-level child events.

{% code file="packages/core/src/attempt-channel.ts" from=28 to=80 expect="/** Value object: the rendered task text the run host gives the agent. */" /%}

After the strict `Start` frame, the run host launches `AgentRuntime` and emits every session event through its ordered envelope writer. Launch and stream failures become terminal `AgentFailure` frames. Inbound frames must keep the correct Attempt id and contiguous sequence.

`Steer` calls the parent session. `Interrupt` starts the SDK abort before it wakes the terminal race, then the host emits `Interrupted`. Normal completion waits for the activity stream, harvests commits from the worktree, and emits `Final`.

{% code file="packages/run-host/src/index.ts" from=178 to=287 expect="      yield* emit(new AttemptChannel.Started());" /%}

The executable now composes the production Pi and Claude layer by default. Process tests select the deterministic runtime explicitly with `--stub` or `--stub-delay-ms`.
{% /section %}

{% section id="runtime-proof" title="Tests cover boundaries and the live GitHub contract" icon="beaker" related=["claude-child","attempt-channel"] %}
{% tests %}
{% test name="Prompt and domain contracts" kind="unit" ref="packages/agents/test/prompt.test.ts" asserts=["orders repository, payload, persona, and rendered task", "adds the Agent signature to parent and child prompts", "keeps child sessions one level deep"] %}Core tests also cover harness and effort values, opaque model ids, parent-model precedence, and protocol-v2 activity round trips.{% /test %}
{% test name="Pi parent and subagent extension" kind="unit" ref="packages/agents/test/pi/pi.test.ts" asserts=["normalizes parent text and tool activity", "forwards steer and interrupt", "returns a typed unknown-model failure", "passes persona and child activity through the extension"] %}The tests supply narrow SDK and child-backend services instead of replacing full vendor modules.{% /test %}
{% test name="Claude child adapter" kind="unit" ref="packages/agents/test/pi/claude.test.ts" asserts=["uses the declared model and headless options", "streams normalized activity", "rejects an unknown model before prompt delivery"] %}The fake query exercises the adapter's streaming input and typed result channel.{% /test %}
{% test name="Durable local execution" kind="tour" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["persists three normalized activity frames and the final result", "keeps cancellation and channel-loss behavior", "removes the Attempt worktree"] %}These process tests use the explicit stub while the normal executable uses the production runtime.{% /test %}
{% test name="Signed GitHub App comment" kind="tour" ref="packages/orchestrator/test/integration/agent-run.test.ts" asserts=["renders the issue title with CEL", "records child and parent brain context", "posts one App-bot comment with the Agent signature", "persists first-level child activity"] %}This opt-in live test runs the real Pi parent, Claude child, local worker, and GitHub App installation. Credential values are omitted from this walkthrough.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Agent runtime and run host" only="{packages/agents/**,packages/run-host/**}" /%}
{% filegroup label="Domain and configuration" only="{packages/core/**,packages/config/**}" /%}
{% filegroup label="Persistence and worker handoff" only="{packages/engine/**,packages/executor/**}" /%}
{% filegroup label="Trigger routing and integration" only="packages/orchestrator/**" /%}
{% filegroup label="Review documentation" only=".agents/walkthroughs/**" /%}
{% filegroup label="Release and workspace" only="{.changeset/**,pnpm-lock.yaml,pnpm-workspace.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}
