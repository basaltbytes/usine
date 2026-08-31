---
walkthrough: 1
title: Local Attempt execution from scheduling to cleanup
pr: 52
commit: 28765e4718cc8d5a8d45e770ebc7eb07175f9265
meta:
  pr: "#52"
  commit: 28765e4
  scope: local worker runtime
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Local worker runtime" icon="workflow" %}
This change connects the durable Run engine to a local Worker. The orchestrator now reserves configured capacity, the executor prepares an isolated Git worktree, and a one-shot run host exchanges versioned Attempt envelopes over standard input and output. The engine persists those envelopes as a Transcript and stores a structured Step result before the executor removes the worktree.

The implementation covers the end-to-end stub-agent path, retryable channel loss, FIFO capacity, and two-stage cancellation. The stub does not act on GitHub, so its concrete harvester records commits only; the shared result contract also accepts pull-request and comment facts from the real agent layer introduced by the follow-on ticket.
{% /section %}
{% /group %}

{% group label="Attempt channel and result" %}
{% section id="channel-contract" title="Protocol-v1 channel contract" icon="sync" related=["run-host"] %}
`@usine/core` makes the wire contract a strict Schema boundary: every frame decodes with unknown keys rejected, in production and tests alike. A `Start` frame carries a secret-free `RunSpec`. Later inbound frames carry `Steer` or `Interrupt`. Outbound envelopes carry `Started`, agent messages, or exactly one terminal payload shape: `Final` with a `StepResult`, `Failed` with a typed Attempt failure, or `Interrupted` acknowledging an interrupt.

Each envelope includes the protocol version, Attempt identity, UTC send time, and a sequence that starts at one.

{% code file="packages/core/src/attempt-channel.ts" from=7 to=115 expect="export const PROTOCOL_VERSION = 1 as const;" /%}

Runtime ordering is a pure reducer owned by the protocol module: `admit` rejects a wrong Attempt identity, a skipped sequence, a missing first `Started`, a duplicate `Started`, and output after a terminal envelope — six unit-tested violation cases every transport adapter folds identically. A closed channel without a terminal envelope becomes an `InfraFailure`, so the existing three-Attempt retry rule applies.

{% code file="packages/core/src/attempt-channel.ts" from=147 to=186 expect="export const admit = (" collapsed=true /%}

{% code file="packages/executor/src/local/index.ts" from=499 to=653 expect="      const execute = Effect.scoped(" collapsed=true /%}
{% /section %}

{% section id="run-host" title="One-shot run host and harvested facts" icon="terminal" related=["channel-contract","durable-transcript"] %}
The published `usine-run-host` executable reads newline-delimited frames. Its current agent is deterministic: it emits `Started`, emits one progress message, races completion against an inbound interrupt, and ends with `Final`, an agent-level `Failed`, or an `Interrupted` acknowledgement. On completion, one `git log` call lists commits between the prepared base commit and `HEAD` (hash and summary NUL-separated), validates each SHA, and stores each commit summary in the structured result.

{% code file="packages/run-host/src/index.ts" from=180 to=209 expect="    const harvestCommits = Effect.fn(\"RunHost.harvestCommits\")(function* () {" collapsed=true /%}

{% callout tone="note" %}
The deterministic stub does not create pull requests or comments. `StepResult.PullRequest` and `StepResult.Comment` are already part of the wire and storage schema so the follow-on real agent can report those facts without changing the Attempt protocol.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Local worker execution" %}
{% section id="capacity" title="Capacity leases keep excess Runs pending" icon="meter" related=["workspace-lifecycle"] %}
At layer construction, the orchestrator rejects non-local Worker kinds and runs preflight for every configured Worker. It then creates one available slot for each unit of `maxConcurrentAttempts`.

A Run requests a reservation before the store creates its Attempt. Reservations use Event receipt time as the primary order and request order as the tie-breaker. A dispatcher pairs the oldest reservation with the next available Worker slot. The Run therefore stays `Pending` while no slot is available.

The wait itself is interruptible — a cancel reaches a run parked in `reserve`, and the reservation's own interrupt handler releases or reoffers the slot. Only once the lease exists does the workflow take on the release obligation (`Effect.ensuring`). A run that closes while queued — canceled, superseded, or revoked — surfaces as the routine `RunClosed` outcome from `beginAttempt`: the slot is released and the workflow settles without executing anything.

{% code file="packages/orchestrator/src/index.ts" from=82 to=210 expect="export const stepExecutorLayer = (" collapsed=true /%}
{% /section %}

{% section id="workspace-lifecycle" title="Cached clone, isolated worktree, and ambient credential" icon="git-branch" related=["capacity","cancellation"] %}
For each Attempt, `prepare` requests one repository-scoped credential. The run host and every git command receive an allowlisted environment (`extendEnv: false`) plus that one credential — the orchestrator's own secrets, the GitHub App private key included, never reach the agent, and the token is scrubbed from any stderr tail before an error can persist it. The credential is not in `RunSpec`, channel frames, or stored Git configuration, and its value is intentionally omitted from this walkthrough.

The adapter keeps a bare cache under the selected Worker and serializes fetches for a repository. A first clone lands in a staging directory and renames into place atomically, so an interrupted clone can never poison the cache. Later use updates the remote, fetches the requested revision (every git call bounded by a timeout), resolves `FETCH_HEAD` to a validated commit SHA, and creates a detached worktree for the Attempt. At layer build, a sweep prunes bare-cache registrations and removes attempt directories a crashed orchestrator left behind.

{% code file="packages/executor/src/local/index.ts" from=265 to=292 expect="    const preflight = Effect.fn(\"LocalExecutor.preflight\")(function* (" /%}

{% code file="packages/executor/src/local/index.ts" from=294 to=424 expect="    const prepare = Effect.fn(\"LocalExecutor.prepare\")(function* (request: CheckoutRequest) {" collapsed=true /%}

At the orchestrator seam, `cleanup` runs through `Effect.ensuring` — the worktree dies at attempt end regardless of outcome, and cleanup never decides that outcome: a failed removal is logged for manual attention instead of converting a finished agent session into a retryable infra failure. Cleanup removes the worktree from Git metadata, removes any remaining directory, prunes worktree metadata, drops the Attempt state, and wipes the in-memory redacted credential.

{% callout tone="note" %}
This stub-runtime preflight verifies Git and protocol compatibility without creating worker state. Harness-login checks become applicable when the real harness replaces the stub; repository-scoped credentials are minted and validated when `prepare` receives the Attempt's repository.
{% /callout %}
{% /section %}

{% section id="cancellation" title="Interrupt, grace period, then hard kill" icon="stopwatch" related=["workspace-lifecycle","durable-transcript"] %}
Operator cancellation first closes the durable projection. If an Attempt is open, the engine asks the `StepExecutor` to interrupt it before interrupting the workflow and continuing queued work. A failed handshake is returned as `AttemptCancellationError`; the Run remains canceled.

Inside the local executor, a `cancelStarted` flag makes the operation idempotent. The first call appends an inbound `Interrupt` envelope to the Transcript, writes the same frame to the run host, and waits for process exit. If the grace period expires, it sends `SIGKILL`. If Transcript append or frame delivery fails, it kills the process immediately and returns the failure. Cleanup still runs through the resource finalizer.

{% code file="packages/executor/src/local/index.ts" from=426 to=482 expect="    const cancelActive = Effect.fn(\"LocalExecutor.cancelActive\")(function* (" /%}
{% /section %}
{% /group %}

{% group label="Durable transcript and proof" %}
{% section id="durable-transcript" title="Append-only Transcript and cursor reads" icon="database" related=["channel-contract","cancellation"] %}
The engine passes an append function into every executor call. Each accepted inbound or outbound envelope is stored with its direction, channel sequence, receive time, and an auto-incremented database sequence. The unique key `(attempt, direction, channel sequence)` makes repeated append calls idempotent.

`RunEngine.transcript` reads one Attempt in ascending database order. With no cursor it returns the full Transcript. With `after`, it returns rows whose database sequence is greater than the cursor. This separates the global read cursor from the per-direction channel sequence.

{% code file="packages/engine/src/store/queries.ts" from=430 to=471 expect="  const appendTranscript = Effect.fn(\"RunStoreQueries.appendTranscript\")(function* (" /%}

The migration adds the execution context twice, deliberately: the trigger-event columns are the immutable submitted fact (a queued Event is claimed from them later), and the run columns are the Run's *effective* context, seeded at creation — the point ADR 0018's edit-and-retry will amend. All columns are plain `NOT NULL` with no sentinel defaults: nothing has shipped, so the migration assumes a fresh runtime database rather than backfilling fake values into branded types.

{% code file="packages/engine/drizzle/20260831072015_attempt_channel/migration.sql" from=1 to=35 expect="CREATE TABLE `usine_attempt_transcripts` (" /%}
{% /section %}

{% section id="runtime-tests" title="Behavior covered at real process and database seams" icon="beaker" related=["capacity","workspace-lifecycle","durable-transcript"] %}
{% tests %}
{% test name="Attempt channel schema" kind="unit" ref="packages/core/test/attempt-channel.test.ts" asserts=["round-trips a final envelope through JSON", "rejects an extra credential field in RunSpec", "admits a legal flow and rejects all six protocol violations"] %}The protocol test checks the strict Schema boundary and the pure reducer, not a hand-built transport parser.{% /test %}
{% test name="Closed-while-queued outcomes" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["a canceled queued run reports RunClosed instead of a defect", "no attempt row is created"] %}Worker capacity makes closing between claim and begin a routine event.{% /test %}
{% test name="Cancel reaches a parked reservation" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["a run waiting on a full worker queue cancels cleanly", "no attempt starts"] %}A never-resolving reserve stands in for a saturated scheduler.{% /test %}
{% test name="Cleanup stays out of the outcome" kind="unit" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["a failed worktree removal keeps the attempt succeeded"] %}A fake Executor fails only its cleanup operation.{% /test %}
{% test name="Successful local Attempt" kind="unit" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["runs a real child host against a temporary Git remote", "persists and tails the Transcript", "removes the worktree", "does not persist the fixture credential in Git config"] %}The fixture credential value is omitted here.{% /test %}
{% test name="Cancellation and scheduling" kind="unit" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["records an inbound interrupt", "accepts repeated cancellation", "cleans the worktree", "starts the older pending Event first"] %}The test uses one configured capacity slot to make queue order observable.{% /test %}
{% test name="Channel loss" kind="unit" ref="packages/orchestrator/test/local-worker.test.ts" asserts=["classifies missing terminal output as InfraFailure", "stops after three Attempts", "cleans every worktree"] %}A real child fixture reports protocol v1 and then closes without an envelope.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Protocol and configuration" only="{packages/core/**,packages/config/**}" /%}
{% filegroup label="Durable engine" only="packages/engine/**" /%}
{% filegroup label="Executor and run host" only="{packages/executor/**,packages/run-host/**}" /%}
{% filegroup label="Orchestrator" only="packages/orchestrator/**" /%}
{% filegroup label="Release metadata" only="{.changeset/**,pnpm-lock.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}
