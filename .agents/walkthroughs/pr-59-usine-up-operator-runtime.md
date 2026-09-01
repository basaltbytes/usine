---
walkthrough: 1
title: Usine up operator runtime
pr: 59
commit: a915bc10342258b413d5d660335bd2eb00096261
meta:
  pr: "#59"
  commit: a915bc1
  scope: engine, orchestrator, CLI, web
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Usine becomes a foreground operator service" icon="browser" %}
This change connects four layers into one local factory:

- The engine stores Loop pause state and lists durable Runs.
- The orchestrator projects Runs, trigger failures, and protocol-v2 transcripts into an operator API.
- The `usine up` CLI starts polling and scheduling with the local worker runtime, then serves typed HTTP routes and the bundled web app.
- The web app shows Projects, global needs-you items, Loop controls, Run actions, and a live Run drawer.

The main review concern is the cross-layer contract. A database state change must affect both trigger streams, operator projections must preserve domain state, and missing GitHub App credentials must leave the HTTP service available without starting either trigger stream.
{% /section %}
{% /group %}

{% group label="Durable Loop controls" %}
{% section id="pause-runtime" title="Pause state stays outside authored Loop files" icon="database" related=["operator-projection"] %}
`LoopControl` reads and writes one boolean per Loop in `usine_loop_runtime`. A missing row means **unpaused**. Writes use an upsert, and repeated writes return without changing the database. This makes pause and unpause idempotent and keeps the instance repo unchanged.

{% code file="packages/engine/src/loop-control.ts" from=13 to=76 expect="const makeLoopControl = Effect.gen(function* () {" /%}

Both trigger streams read the durable states at the start of each cycle. Polling removes paused Loops before it builds the repository watch set. Scheduling applies the same filter before it computes due Ticks.

```pseudo
on trigger cycle
  read paused Loop names
  remove paused Loops
  evaluate remaining triggers
  submit new Events
```

{% code file="packages/orchestrator/src/polling-triggers.ts" from=369 to=383 expect="      const poll = Effect.fn(\"PollingTriggers.poll\")(function* (instance: LoadedInstance) {" /%}

{% callout tone="key" %}
Pause prevents new Runs from opening through later trigger cycles. It does not cancel or modify existing Runs.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Observe and intervene" %}
{% section id="operator-projection" title="One projection joins factory state" icon="workflow" related=["pause-runtime","live-drawer"] %}
`Operator.overview()` joins four sources: all Run snapshots, Loop runtime states, the latest polling cycle, and the latest schedule cycle. It then:

- groups Runs under configured Projects;
- derives `clear`, `active`, or `needs-you` Project status;
- adds pause state to each authored Loop;
- creates global needs-you entries for approval waits, Run failures, poll failures, and schedule failures.

{% code file="packages/orchestrator/src/operator/service.ts" from=30 to=56 expect="  const overview = Effect.fn(\"Operator.overview\")(function* (instance: LoadedInstance) {" /%}

The detail projection adds the Event dedup key and payload, Attempt history and typed failures, result text, a produced pull-request URL, and transcript events. Transcript projection keeps parent and child session identities. It translates channel payload variants into stable labels and details for the UI.

{% code file="packages/orchestrator/src/operator/projection.ts" from=39 to=58 expect="export const runView = (snapshot: RunSnapshot): RunView => {" /%}

{% code file="packages/orchestrator/src/operator/projection.ts" from=61 to=126 expect="const transcriptEvent = (entry: TranscriptEntry): TranscriptEventView => {" collapsed=true /%}

Approve is not a mutable flag. The operator service creates a deterministic approval Event for the Run, while retry, cancel, pause, and unpause call the existing engine operations.

{% code file="packages/orchestrator/src/operator/service.ts" from=141 to=171 expect="  const approve = Effect.fn(\"Operator.approve\")(function* (runId: Run.RunId) {" /%}

{% callout tone="warn" %}
The overview has no pagination or retention filter. The UI requests it every two seconds, and `RunStore.list()` loads a full snapshot for every durable Run with concurrency 16. Review this as the current local-factory scale boundary.
{% /callout %}

{% code file="packages/engine/src/store/store.ts" from=435 to=440 expect="  const list = Effect.fn(\"RunStore.list\")(function* () {" /%}
{% /section %}

{% section id="live-drawer" title="The Run drawer tails instead of replaying" icon="sync" related=["operator-projection"] %}
The Run detail endpoint accepts a branded transcript sequence cursor. While a Run is open, the drawer requests new detail once per second with the last sequence. It merges unseen events into the cached transcript and stops timed refresh after the Run closes.

{% code file="apps/web/src/main.tsx" from=230 to=254 expect="      const key = [\"run\", runId] as const;" /%}

Parent events remain in the main feed. Child events are grouped by `parentId` and rendered in one collapsible level. The same drawer exposes approve, retry, and a two-click cancel flow. It also shows the task, Event payload, Attempts, typed errors, result, and pull-request link.

{% code file="apps/web/src/main.tsx" from=186 to=221 expect="      groups.set(event.parentId, {" /%}

The app uses the changed operator schemas at the fetch boundary. Its stylesheet defines the Catppuccin Mocha palette, modular type scale, Archivo signage, and IBM Plex Mono annotations directly as shared tokens.

{% code file="apps/web/src/styles.css" from=1 to=30 expect="@import \"tailwindcss\";" /%}
{% /section %}
{% /group %}

{% group label="Foreground usine up" %}
{% section id="startup-composition" title="Startup selects live or setup mode" icon="server" related=["operator-projection"] %}
`runtimeLayer()` composes the local engine and worker, GitHub polling, CEL parsing, both trigger services, `Operator`, and `Orchestrator`. `Orchestrator.run()` races the two non-terminating trigger streams under one scoped lifetime.

{% code file="packages/orchestrator/src/local.ts" from=39 to=66 expect="export const runtimeLayer = (" /%}

The CLI loads the instance first and then attempts to load GitHub App credentials. With credentials, it builds the runtime, forks the orchestrator, and launches the HTTP server. Without credentials, it does not build or fork that runtime. It serves a `NeedsSetup` overview and makes all intervention methods fail with a typed 503 response.

{% code file="apps/server/src/main.ts" from=34 to=69 expect="const up = Effect.scoped(" /%}

Credential values are omitted from this walkthrough. The change only names their supported environment and file sources here; reviewers should inspect credential handling at the boundary.

The server parses branded Run ids, Loop names, and transcript cursors before calling the backend. It returns schema-encoded overview and detail responses and maps typed engine failures to HTTP status codes. The server package also publishes the `usine` binary and copies the built web assets into `dist/web`.
{% /section %}

{% section id="behavior-proof" title="Behavior covered at service boundaries" icon="beaker" %}
{% tests %}
{% test name="persists pause across a fresh database layer" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["defaults an unknown Loop to unpaused","keeps repeated pause idempotent","restores paused state after rebuilding the service","unpauses the stored Loop"] %}Uses the local SQLite adapter, so the test covers the migration and service together.{% /test %}
{% test name="skips paused polling and schedule Loops" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["does not call GitHub for a paused polling Loop","reports zero submissions","stores the latest cycle"] %}The matching schedule test also asserts zero Loop fanout and exposes its latest cycle.{% /test %}
{% test name="projects operator overview and transcript detail" kind="unit" ref="packages/orchestrator/test/operator.test.ts" asserts=["derives needs-you Project state","surfaces pause and poll failure state","preserves parent and child session identity","returns only transcript entries after the cursor","records approval for the selected Run"] %}This fixes the contract between engine snapshots and transport-neutral operator views.{% /test %}
{% test name="serves setup mode through HTTP" kind="http" ref="apps/server/test/http.test.ts" asserts=["returns a typed NeedsSetup overview","rejects intervention with 503","rejects an invalid transcript cursor with 400"] %}This proves the server remains useful when credentials are absent. Credential values are not part of the fixture.{% /test %}
{% test name="lists Runs newest first" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["returns every submitted Run snapshot","orders newer Runs before older Runs"] %}This is the ordering used by Project Run lists in the operator overview.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Tests" only="{apps/server/test/**,packages/engine/test/**,packages/orchestrator/test/**}" /%}
{% filegroup label="Durable engine" only="packages/engine/**" /%}
{% filegroup label="Orchestrator" only="packages/orchestrator/**" /%}
{% filegroup label="CLI and web UI" only="{apps/server/**,apps/web/**}" /%}
{% filegroup label="Packaging and documentation" /%}
{% /files %}
{% /section %}
{% /group %}
