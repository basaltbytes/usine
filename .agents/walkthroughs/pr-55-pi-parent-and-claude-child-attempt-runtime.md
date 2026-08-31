---
walkthrough: 1
title: Pi parent and Claude child attempt runtime
pr: 55
commit: fec3796ceae27b433f63b3941779633a4c25be4a
meta:
  pr: "#55"
  commit: fec3796
  scope: agent runtime
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Attempts now run through live agent sessions" icon="agent" %}
This change replaces the default run-host stub with an in-process Pi parent and a headless Claude Code child. The orchestrator renders the loop task and freezes the payload, Agent, child brain, and parent model before execution. The run host then streams typed parent and child session events into the Attempt transcript.

The main review path is: **trigger evaluation → stored Run context → Attempt checkout → Pi parent → Claude child → protocol v2 transcript → terminal result**. The change also adds persistence migrations, parent steer and interrupt controls, adapter tests, and an opt-in GitHub App contract test.
{% /section %}
{% /group %}

{% group label="Immutable agent context" %}
{% section id="trigger-context" title="Triggers freeze rendered work and roster data" icon="workflow" related=["stored-context"] %}
Each loop resolves its named Agent from the loaded instance. The Agent-level parent model takes precedence over the instance default. The resulting context contains the persona, declared child brain, and effective parent model.

{% code file="packages/orchestrator/src/trigger-submission.ts" from=32 to=61 expect="/** Snapshot one authored loop's roster member and effective parent model. */" /%}

After a polling expression matches, the orchestrator renders the loop body through `ConfigParser.renderPrompt()`. It submits the rendered task with the exact item payload and resolved Agent context. Schedule Ticks use the same submission path and render against their Tick payload.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=259 to=296 expect="          const dedupKey = eventKey(loop, watched.repository, item, snapshot);" /%}

The parent prompt has a fixed order: repository and payload snapshot, Agent persona, rendered task, then the GitHub signature rule. A child gets a separate prompt with the same persona and signature because it does not inherit the parent prompt.

{% code file="packages/agents/src/prompt.ts" from=22 to=63 expect="/** Builds the complete parent prompt from immutable run context. */" /%}

A prompt-render failure is deterministic loop authoring, so both trigger paths isolate it to the failing loop, report it on the cycle, and keep the polling cursor advancing; submission and transport errors still stop only the affected repository cycle. Schedule fanout likewise reports Agent-resolution, cron-boundary, rendering, and submission failures without stopping sibling schedules.
{% /section %}

{% section id="stored-context" title="Events, Runs, and Attempts retain execution context" icon="database" related=["trigger-context","attempt-channel"] %}
The database stores the submitted Agent and parent model on the immutable trigger Event route. It copies them to the Run's effective context when the Event is claimed. When execution starts, the engine copies the Run's child `BrainSpec` and parent model to the new Attempt row.

{% code file="packages/engine/src/store/store.ts" from=218 to=250 expect="        const number = Attempt.AttemptNumber.make((lastAttempt?.number ?? 0) + 1);" /%}

Two migrations backfill old rows with legacy Agent and brain values before the new JSON columns become required. The schema checks each stored Agent and brain value as valid JSON.

{% callout tone="key" %}
The Attempt records the roster-declared child brain that Claude accepts before spawning. Model ids pass through unchanged, so an accepted alias is not rewritten to its resolved id. The child session descriptor uses that same brain, while the Pi `SessionStarted` activity records the parent model selected by the SDK.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Pi parent and Claude child" %}
{% section id="session-model" title="One activity model covers parent and child sessions" icon="git-branch" related=["parent-runtime","attempt-channel"] %}
Core now owns the Agent brain and session schemas. `ParentSession` has no parent field. `ChildSession` has exactly one `parentId`. The public protocol can therefore represent parent activity and one child level, but not recursive child descriptors.

The session-event union covers session start and finish, text output, and paired tool start and finish events. Each event carries its full session descriptor. Transcript readers can identify the Agent, brain, and parent relation without separate session state.

{% code file="packages/core/src/agent.ts" from=34 to=121 expect="/** Value object: the harness child that a run is declared to spawn. */" /%}
{% /section %}

{% section id="parent-runtime" title="Pi owns orchestration and the subagent tool" icon="ai-model" related=["claude-child","session-model"] %}
`PiParentRuntime.launch()` creates an Attempt-scoped parent session. It starts the Pi SDK with the effective parent model, the Agent effort as the parent thinking level, and the usine-owned extension, distrusting the worktree's repository-controlled `.pi/` configuration. An unknown configured model fails through `UnknownModelError` before prompt execution.

The adapter converts Pi text and tool events to normalized activity. It places parent events and forwarded child events on one queue. The final parent text becomes the Step message. The returned session exposes Pi's native `steer()` and `abort()` operations.

{% code file="packages/agents/src/pi/pi.ts" from=207 to=349 expect="  const launch: AgentRuntime[\"Service\"][\"launch\"] = Effect.fn(\"PiParentRuntime.launch\")(" collapsed=true /%}

The `subagent` tool creates a first-level child from the rostered child brain. Pi invokes the tool outside any usine fiber, so the extension receives a runner that executes each child program on the launch fiber's own services and scope — the stderr log redirect survives, and a dying Attempt interrupts its children. It builds the child-only prompt, forwards child activity into the parent queue, waits for the child result, and returns that text as Pi tool output. If Pi aborts the tool call, the extension interrupts the child first.

{% code file="packages/agents/src/pi/subagents.ts" from=47 to=122 expect="/** Pi-owned extension factory. Its single tool can only create first-level child descriptors. */" /%}

{% callout tone="key" %}
Core validates `claude`, `codex`, and `pi` harness values, but this production child layer implements only Claude. A Codex or Pi child brain returns `UnsupportedHarnessError` before the child starts.
{% /callout %}
{% /section %}

{% section id="claude-child" title="Claude runs headlessly behind a narrow backend" icon="terminal" related=["parent-runtime","runtime-proof"] %}
The Claude adapter opens streaming input in the Attempt worktree. It disables session persistence, bypasses permission prompts because worker isolation remains the executor boundary, and loads only the worker user's own settings — the worktree's project and local settings carry repository-controlled hooks. It maps `off` to disabled thinking and `minimal` to Claude's `low` effort.

Before prompt delivery, the adapter reads the SDK model registry and accepts either a model alias or its resolved id. It emits one `TextOutput` per completed assistant message plus tool events, keeping the transcript at message granularity. An unsuccessful result becomes `AgentResultError` (the agent failed the work; the operator decides), while an output stream that closes without a result or an SDK failure becomes `SessionOperationError` (retryable infrastructure).

{% code file="packages/agents/src/pi/claude.ts" from=224 to=352 expect="  const launch: ChildBackend[\"Service\"][\"launch\"] = Effect.fn(\"ClaudeChildBackend.launch\")(" collapsed=true /%}

The child backend supports streaming user messages and SDK interrupt. However, inbound Attempt controls contain no target session id. The run host sends operator `Steer` and `Interrupt` frames only to the Pi parent. Child interrupt is available only through the subagent abort path in this change.
{% /section %}
{% /group %}

{% group label="Attempt protocol v2" %}
{% section id="attempt-channel" title="The run host bridges sessions to the transcript" icon="sync" related=["session-model","runtime-proof"] %}
Protocol v2 extends `RunSpec` with the payload, Agent, and parent model. It replaces the old plain agent message with a `SessionEvent` envelope that can contain parent or first-level child events.

{% code file="packages/core/src/attempt-channel.ts" from=28 to=81 expect="/** Value object: the rendered task text the run host gives the agent. */" /%}

After the strict `Start` frame, the run host launches `AgentRuntime` and writes each session event through its ordered envelope writer. Terminal failures map through the ADR 0002 taxonomy: SDK and process trouble becomes retryable `InfraFailure`, roster and agent-work failures park as `AgentFailure`. On the executor side every outbound line is credential-scrubbed before it is decoded or persisted, because protocol v2 carries raw tool inputs and outputs. Inbound frames must keep the correct Attempt id and contiguous sequence.

`Steer` calls the parent session. `Interrupt` starts the SDK abort before it wakes the terminal race, then the host emits `Interrupted`. Normal completion waits for the activity stream, harvests commits from the worktree, and emits `Final`.

{% code file="packages/run-host/src/index.ts" from=175 to=290 expect="      yield* emit(new AttemptChannel.Started());" /%}

The executable now composes the production Pi and Claude layer by default. Process tests select the deterministic runtime explicitly with `--stub` or `--stub-delay-ms`.
{% /section %}

{% section id="runtime-proof" title="Tests cover boundaries and the live GitHub contract" icon="beaker" related=["claude-child","attempt-channel"] %}
{% tests %}
{% test name="Prompt and domain contracts" kind="unit" ref="packages/agents/test/prompt.test.ts" asserts=["orders repository, payload, persona, and rendered task", "adds the Agent signature to parent and child prompts", "keeps child sessions one level deep", "maps session errors onto the ADR 0002 retry taxonomy"] %}Core tests also cover harness and effort values, opaque model ids, parent-model precedence, and protocol-v2 activity round trips.{% /test %}
{% test name="Pi parent and subagent extension" kind="unit" ref="packages/agents/test/pi/pi.test.ts" asserts=["normalizes parent text and tool events", "forwards steer and interrupt", "returns a typed unknown-model failure", "passes persona and child events through the extension", "runs subagent tool programs on the launch fiber's services"] %}The tests supply narrow SDK and child-backend services instead of replacing full vendor modules.{% /test %}
{% test name="Claude child adapter" kind="unit" ref="packages/agents/test/pi/claude.test.ts" asserts=["uses the declared model, worker-only settings, and headless options", "streams message-level events and ignores deltas", "rejects unknown models and non-Claude harnesses before prompt delivery", "splits agent-result failures from infrastructure failures"] %}The fake query exercises streaming input and the typed result channel.{% /test %}
{% test name="Durable local execution" kind="tour" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["persists three normalized session-event frames and the final result", "keeps cancellation and channel-loss behavior", "removes the Attempt worktree"] %}These process tests use the explicit stub while the normal executable uses the production runtime.{% /test %}
{% test name="Trigger failure isolation" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["isolates one loop's render failure", "advances the cursor past the broken loop", "still submits sibling loops"] %}The matching schedule-side test keeps the same isolation contract on Tick fanout.{% /test %}
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
