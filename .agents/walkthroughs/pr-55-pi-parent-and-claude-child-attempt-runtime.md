---
walkthrough: 1
title: Pi parent and Claude child attempt runtime
pr: 55
commit: 63aa06934ee11c416e0171fac8369b414c062407
meta:
  pr: "#55"
  commit: 63aa069
  scope: agent runtime
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Attempt execution now uses live agent sessions" icon="agent" %}
This change replaces the run-host stub with a production runtime. The orchestrator now freezes the rendered task, payload snapshot, named Agent, child brain, and resolved parent model before a Run starts. The run host then starts an in-process Pi parent. Pi can use the usine-owned `subagent` tool to run a headless Claude Code child in the same Attempt worktree.

Protocol v2 carries typed parent and child activity instead of plain agent messages. It also sends steer and interrupt controls to the live parent session. The engine stores the Agent context on Events and Runs, then copies the declared child brain and resolved parent model onto each Attempt.

**Review the change as one path:** trigger evaluation → immutable Run context → Pi parent → Claude child → normalized transcript → terminal Attempt result.
{% /section %}
{% /group %}

{% group label="Immutable agent context" %}
{% section id="trigger-context" title="Triggers freeze rendered work and roster data" icon="workflow" related=["stored-brain"] %}
Both polling and schedule triggers now resolve each loop's named Agent before submission. A per-Agent parent model overrides the instance default. A missing roster entry is treated as a defect because `LoadedInstance` is expected to contain valid references.

{% code file="packages/orchestrator/src/trigger-submission.ts" from=19 to=45 expect="export const resolveTriggerLoops = Effect.fn(\"TriggerRouting.resolveLoops\")(function* (" /%}

After a trigger expression matches, the orchestrator renders the loop body through the existing `ConfigParser.renderPrompt()` CEL seam. It submits that rendered task with the payload and resolved Agent context. This happens for GitHub item snapshots and schedule Tick payloads.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=231 to=245 expect="          const dedupKey = eventKey(loop, watched.repository, item, snapshot);" /%}

The Pi prompt has a fixed order: repository and payload snapshot, Agent persona, rendered task, then the GitHub signature rule. Child prompts repeat the persona and signature because a child does not inherit the parent's prompt text.

{% code file="packages/agents/src/prompt.ts" from=24 to=66 expect="    \"# Run context\"," /%}
{% /section %}

{% section id="stored-brain" title="Runs preserve context and Attempts preserve the declared brain" icon="database" related=["trigger-context","protocol-v2"] %}
The engine stores the Agent JSON and resolved parent model on both the immutable trigger Event route and the Run's effective context. When an Attempt begins, it copies the Run's child `BrainSpec` and parent model into the Attempt ledger before execution starts.

{% code file="packages/engine/src/store/store.ts" from=218 to=250 expect="        const number = Attempt.AttemptNumber.make((lastAttempt?.number ?? 0) + 1);" /%}

The database codec parses these JSON columns back into core schemas. Two migrations backfill existing rows with explicit legacy Agent and brain records before making the JSON columns required.

{% callout tone="key" %}
The Attempt row records the declared child brain and the resolved configured parent model. If no parent model is configured, the Attempt keeps `None`; the actual Pi default selected by the SDK appears in the parent `SessionStarted` activity instead.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Pi parent and Claude child" %}
{% section id="session-model" title="One activity model covers parent and child sessions" icon="git-branch" related=["parent-runtime","protocol-v2"] %}
Core now owns the Agent brain shapes and normalized session events. `ParentSession` has no parent field. `ChildSession` has exactly one `parentId`. This type structure limits public activity to one child level.

{% code file="packages/core/src/agent.ts" from=34 to=120 expect="/** Value object: the harness child that a run is declared to spawn. */" /%}

The normalized activity set records session boundaries, text, and tool calls. Each event carries its complete session descriptor, so transcript readers can identify the Agent, actual brain, and parent relation without external session state.
{% /section %}

{% section id="parent-runtime" title="Pi owns orchestration and the subagent tool" icon="ai-model" related=["claude-child","protocol-v2"] %}
`PiParentRuntime.launch()` creates an Attempt-scoped parent id and starts the Pi SDK with the resolved parent model, Agent effort, and one inline extension. The SDK's selected model becomes the parent session's actual `BrainSpec`. Unknown configured models fail through `UnknownModelError` before prompt execution.

The adapter subscribes to Pi messages and tool events, converts them to normalized activity, and places parent and child activity on one queue. The last parent text becomes the terminal step message. The runtime also exposes native `steer()` and `abort()` calls.

{% code file="packages/agents/src/pi/pi.ts" from=208 to=271 expect="      const parentId = Agent.SessionId.make(`parent:${request.spec.attemptId}`);" collapsed=true /%}

The `subagent` tool creates a first-level child descriptor from the rostered child brain. It assembles a child-only prompt, forwards the child's activity into the parent queue, waits for the child's result, and returns that result to Pi as the tool output. An aborted Pi tool call first interrupts the child.

{% code file="packages/agents/src/pi/subagents.ts" from=49 to=100 expect="        execute: (_toolCallId, params, signal, onUpdate) => {" /%}

{% callout tone="key" %}
Core validates `claude`, `codex`, and `pi` as harness names, but this production child layer implements only Claude. A Codex or Pi child brain reaches the Claude backend and returns `UnsupportedHarnessError`; those child adapters remain outside this change.
{% /callout %}
{% /section %}

{% section id="claude-child" title="Claude runs headlessly behind a narrow backend" icon="terminal" related=["parent-runtime"] %}
The Claude adapter opens streaming input in the Attempt worktree. It disables session persistence and bypasses permission prompts because worker isolation remains the executor boundary. It maps usine effort to Claude options, including disabled thinking for `off` and `low` for `minimal`.

Before sending the child prompt, the adapter asks the SDK for supported models and accepts either a model alias or its resolved model id. It then emits session boundaries, text deltas, and paired tool activity. An unsuccessful result, an output stream that closes without a result, or an SDK failure becomes a typed `SessionOperationError`.

{% code file="packages/agents/src/pi/claude.ts" from=239 to=318 expect="        agent: request.session.agent," collapsed=true /%}

The child seam also implements steer through additional streaming user messages and interrupt through the SDK query. The current run-host channel directs operator controls to the Pi parent; child control methods support the subagent abort path and future session-addressed control work.
{% /section %}
{% /group %}

{% group label="Attempt protocol v2" %}
{% section id="protocol-v2" title="The run host bridges sessions to the durable transcript" icon="sync" related=["session-model","stored-brain"] %}
Protocol v2 extends `RunSpec` with the payload, Agent, and parent model. It replaces the plain `AgentMessage` payload with an `Activity` envelope that can carry either parent or child events.

{% code file="packages/core/src/attempt-channel.ts" from=29 to=76 expect="export const Task = Schema.String.check(" /%}

After the strict `Start` frame, the run host launches `AgentRuntime`, forwards every session event as an outbound `Activity`, and preserves the existing ordered envelope writer. Agent launch and stream failures become terminal `AgentFailure` frames.

Inbound frames still require the correct Attempt id and contiguous sequence. `Steer` calls the live parent session. `Interrupt` starts the SDK abort before it wakes the terminal race, then the host emits `Interrupted`. On normal completion, the host waits for the activity stream, harvests commits from the worktree, and emits `Final`.

{% code file="packages/run-host/src/index.ts" from=196 to=275 expect="      const session = launched.success;" /%}
{% /section %}

{% section id="runtime-proof" title="Tests cover adapters, persistence, and the live contract" icon="beaker" related=["protocol-v2","claude-child"] %}
{% tests %}
{% test name="Prompt and domain contracts" kind="unit" ref="packages/agents/test/prompt.test.ts" asserts=["orders repository, payload, persona, and rendered task", "adds the Agent signature to parent and child prompts", "keeps child requests first-level"] %}Core tests also validate harness and effort values, opaque model ids, parent-model precedence, and protocol-v2 activity round trips.{% /test %}
{% test name="Pi parent and subagent extension" kind="unit" ref="packages/agents/test/pi/pi.test.ts" asserts=["normalizes parent text and tool activity", "forwards steer and interrupt", "returns a typed unknown-model failure", "forwards child activity and persona"] %}The tests use narrow SDK and backend services instead of module replacement.{% /test %}
{% test name="Claude child adapter" kind="unit" ref="packages/agents/test/pi/claude.test.ts" asserts=["uses the declared model and headless options", "streams normalized activity", "rejects an unknown model before prompt delivery"] %}The fake query exercises the real adapter boundary and typed result channel.{% /test %}
{% test name="Durable local execution" kind="tour" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["persists three normalized activity frames and the final result", "keeps cancellation and channel-loss behavior", "removes the Attempt worktree"] %}Process tests now select an explicit deterministic runtime with `--stub`; the normal executable composes the production Pi and Claude layer.{% /test %}
{% test name="Signed GitHub App comment" kind="tour" ref="packages/orchestrator/test/integration/agent-run.test.ts" asserts=["renders the issue title with CEL", "records child and parent brain context", "posts exactly one App-bot comment with the Agent signature", "persists first-level child activity"] %}This opt-in test uses a real Pi parent, Claude child, local worker, and GitHub App installation. It also removes its setup and result comments.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Agent runtime" only="{packages/agents/**,packages/run-host/**}" /%}
{% filegroup label="Domain and protocol" only="packages/core/**" /%}
{% filegroup label="Persistence" only="packages/engine/**" /%}
{% filegroup label="Trigger and worker routing" only="{packages/config/**,packages/executor/**,packages/orchestrator/**}" /%}
{% filegroup label="Release and workspace" only="{.changeset/**,pnpm-lock.yaml,pnpm-workspace.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}
