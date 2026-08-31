---
walkthrough: 1
title: Codex and Pi harness children with Attempt protocol v3
pr: 58
commit: fb24c80cc3355e61f63edc8cc98e281577f84ba1
meta:
  pr: "58"
  commit: fb24c80
  scope: agents, channel, persistence
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="What changes in this pull request" icon="git-pull-request" %}
This change completes the child harness dispatcher. The Pi parent can now start Claude Code, Codex, or Pi from the Agent's `BrainSpec.harness`. Each backend returns the same session event and control contract.

Codex adds the largest new path. It owns a scoped `codex app-server` process, correlates JSON-RPC responses, rejects unknown models, starts a headless ephemeral thread, and converts Codex notifications into usine session events. Pi now uses the existing SDK seam for child sessions as well as the parent session.

The Attempt channel moves to protocol v3. A successful parent launch sends a `Started` payload with model data. The engine updates the Attempt and appends the envelope in one database transaction.

`Started` records the rostered child brain and the SDK-selected Pi parent model. A parent can start no children or several children, so each backend-selected child model stays on its own `ChildSession` events.
{% /section %}
{% /group %}

{% group label="Harness children" %}
{% section id="harness-dispatch" title="The roster selects one child backend" icon="git-branch" related=["pi-child","codex-child"] %}
The public `ChildBackend` seam does not change for the subagents extension. The new dispatcher reads the child session's authored harness and calls one concrete service. The switch is exhaustive because `Harness` contains only `claude`, `codex`, and `pi`.

{% code file="packages/agents/src/pi/children.ts" from=9 to=22 expect="  return ChildBackend.of({" /%}

The Node composition supplies all three implementations to the dispatcher. The Pi parent still depends only on `ChildBackend`, so changing an Agent file does not change parent orchestration.

{% code file="packages/agents/src/pi/index.ts" from=15 to=25 expect="const childImplementations = Layer.merge(" /%}

```mermaid
flowchart LR
  parent[Pi parent] --> dispatch{BrainSpec harness}
  dispatch -->|claude| claude[Claude Code child]
  dispatch -->|codex| codex[Codex child]
  dispatch -->|pi| pi[Pi child]
  claude --> events[Session events and controls]
  codex --> events
  pi --> events
```
{% /section %}

{% section id="pi-child" title="Pi SDK sessions now run as children" icon="ai-model" related=["harness-dispatch","contract-proof"] %}
The Pi SDK setup is shared by parent and child sessions. It parses a requested `provider/model`, selects the SDK model, keeps the session in memory, and disables project settings, extensions, prompt templates, skills, and themes. The inline subagents extension is still available to the parent through `extensionFactories`.

{% code file="packages/agents/src/pi/pi.ts" from=65 to=104 expect="export const piSdkLive = Layer.succeed(PiSdk)({" /%}

The child adapter starts Pi without extensions, then rebuilds the public `ChildSession` with the SDK-selected model. It emits normalized SDK events and exposes native `steer` and `abort` operations. SDK and control failures remain typed `SessionOperationError` values.

{% code file="packages/agents/src/pi/pi.ts" from=221 to=267 expect="  const launch: PiChildBackend[\"Service\"][\"launch\"] = Effect.fn(\"PiChildBackend.launch\")(" collapsed=true /%}

{% code file="packages/agents/src/pi/pi.ts" from=276 to=323 expect="      yield* Effect.tryPromise({" collapsed=true /%}
{% /section %}

{% section id="codex-child" title="Codex app-server transport and event normalization" icon="terminal" related=["harness-dispatch","pool-events","contract-proof"] %}
Codex needs a process transport in addition to a child adapter. The process starts from the worker user's home directory, not from the Attempt worktree. The command also marks the target worktree as untrusted before Codex starts a thread. This prevents process startup from loading repository-owned Codex configuration.

{% code file="packages/agents/src/pi/codex.ts" from=138 to=178 expect="export const codexAppServerCommand = (" /%}

The transport assigns a numeric id to each request and stores a `Deferred` response in a pending map. The stdout router resolves the matching request, emits notifications to a queue, and rejects server-to-client requests because usine runs the child headlessly. An unexpected stdout close, stderr failure, or process exit fails every pending request and the notification stream.

{% code file="packages/agents/src/pi/codex.ts" from=207 to=263 expect="      const routeLine = Effect.fn(\"CodexAppServer.routeLine\")(function* (line: string) {" collapsed=true /%}

After JSON-RPC initialization, the adapter reads every model catalog page. It disables provider fallback. It then starts an ephemeral thread and a turn with `approvalPolicy: never` and danger-full-access sandbox settings. The thread response supplies the model stored on the normalized child session.

{% code file="packages/agents/src/pi/codex.ts" from=501 to=578 expect="      const models: Array<(typeof ModelListResponse.Type.data)[number]> = [];" /%}

Completed Codex items become one text event or a tool completion event. Streaming text deltas are not persisted. Turn completion resolves or fails the common session channel. `turn/steer` and `turn/interrupt` retain both thread and turn identity.

{% code file="packages/agents/src/pi/codex.ts" from=584 to=634 expect="              const notification = yield* decodeResponse(" collapsed=true /%}

{% code file="packages/agents/src/pi/codex.ts" from=664 to=737 expect="            if (method !== \"turn/completed\") return;" collapsed=true /%}
{% /section %}

{% section id="pool-events" title="ChatGPT rate windows enter the transcript" icon="meter" related=["codex-child"] %}
The shared event model now includes a pool identifier and optional primary and secondary rate windows. A Codex `account/rateLimits/updated` notification becomes `PoolRateLimitsUpdated` for the `chatgptPlan` pool. The event then follows the same Attempt transcript path as text and tool events.

{% code file="packages/core/src/agent.ts" from=113 to=149 expect="/** Billing source whose native meter produced a usage or health observation. */" /%}

{% code file="packages/agents/src/pi/codex.ts" from=636 to=662 expect="            if (method === \"account/rateLimits/updated\") {" /%}
{% /section %}
{% /group %}

{% group label="Attempt channel v3" %}
{% section id="started-models" title="Started records launch model data" icon="versions" related=["atomic-persistence","contract-proof"] %}
Protocol v3 adds `SpawnedSpec` to the first successful outbound frame. The schema requires a child brain and a parent model. A launch failure can instead be the first and terminal `Failed` frame, because no effective parent session exists in that case.

{% code file="packages/core/src/attempt-channel.ts" from=46 to=60 expect="/** The effective models selected when the run host successfully launches an Attempt. */" /%}

The run host now launches the Pi parent before it emits `Started`. It gets the parent model from the returned parent session. It copies the child brain from the incoming Agent spec.

{% code file="packages/run-host/src/index.ts" from=175 to=200 expect="      const launched = yield* Effect.result(" /%}

{% callout tone="key" %}
The Attempt writeback targets issue #57 item 1: when `parent_model` is absent, `Started` replaces it with the model selected by the Pi SDK. The rostered child brain remains the Attempt-level spec. Codex and Pi record each selected child model on that child's session events.
{% /callout %}
{% /section %}

{% section id="atomic-persistence" title="Model update and transcript append are atomic" icon="database" related=["started-models"] %}
When the engine receives an outbound `Started`, it updates the Attempt model columns and appends the transcript row inside one database transaction. Other inbound and outbound envelopes only append their transcript row through the same transaction wrapper.

{% code file="packages/engine/src/store/store.ts" from=424 to=438 expect="  const appendTranscript = Effect.fn(\"RunStore.appendTranscript\")(function* (" /%}

The update writes both model fields in one SQL statement. A replayed `Started` therefore converges on the same values before its transcript append completes.

{% code file="packages/engine/src/store/queries.ts" from=225 to=237 expect="  const updateAttemptSpawnedSpec = Effect.fn(\"RunStoreQueries.updateAttemptSpawnedSpec\")(function* (" /%}
{% /section %}
{% /group %}

{% group label="Contract proof" %}
{% section id="contract-proof" title="Backend, protocol, and persistence coverage" icon="beaker" related=["harness-dispatch","pi-child","codex-child","started-models"] %}
{% tests %}
{% test name="dispatches all rostered harnesses" kind="unit" ref="packages/agents/test/pi/children.test.ts" asserts=["iterates over all three Harness values","selects the matching concrete backend"] %}This keeps harness selection at the shared dispatcher seam.{% /test %}
{% test name="normalizes Codex behavior" kind="unit" ref="packages/agents/test/pi/codex.test.ts" asserts=["starts outside the worktree with untrusted repository config","uses headless thread settings","normalizes messages, tools, and rate windows","forwards steer and interrupt","separates unknown-model and agent-result failures"] %}A scripted `CodexConnection` tests behavior without replacing module imports.{% /test %}
{% test name="normalizes Pi child behavior" kind="unit" ref="packages/agents/test/pi/pi.test.ts" asserts=["records the SDK-selected model on the child session","forwards prompt, steer, and interrupt","maps SDK startup trouble to a typed operation failure"] %}A narrow `PiSdk` layer provides the real adapter seam.{% /test %}
{% test name="enforces protocol v3 ordering" kind="unit" ref="packages/core/test/attempt-channel.test.ts" asserts=["accepts Started then session events then terminal output","accepts Failed as a launch terminal","rejects sequence, identity, and ordering violations"] %}The reducer tests the new first-frame alternatives and the `SpawnedSpec` wire shape.{% /test %}
{% test name="persists Started model data" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["updates the Attempt brain","updates the effective parent model"] %}The local SQLite test reads the Attempt projection after the transcript append.{% /test %}
{% test name="runs the opt-in Codex contract" kind="unit" ref="packages/agents/test/integration/codex.test.ts" asserts=["runs a real headless Codex child","observes text and terminal session events"] %}An environment-gated Vitest case runs the Codex backend against an explicitly selected model.{% /test %}
{% test name="runs the opt-in Pi contract" kind="unit" ref="packages/agents/test/integration/pi.test.ts" asserts=["runs a real Pi SDK child","observes text and terminal session events"] %}A separate environment-gated Vitest case runs the Pi backend against an explicitly selected model.{% /test %}
{% /tests %}

{% callout tone="key" %}
The dispatcher matrix proves that the same parent request selects each backend from `BrainSpec.harness`. The existing live Agent loop covers the full Claude subagent path. The two new live contracts cover the Codex and Pi vendor boundaries. Together, these checks keep loop orchestration independent from the Agent brain frontmatter.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Agent runtime and tests" only="packages/agents/**" /%}
{% filegroup label="Attempt protocol and persistence" only="{packages/core/**,packages/engine/**,packages/run-host/**}" /%}
{% filegroup label="Executor and orchestration contracts" only="{packages/executor/**,packages/orchestrator/**}" /%}
{% filegroup label="Documentation and release" only="{docs/**,.changeset/**,pnpm-lock.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}
