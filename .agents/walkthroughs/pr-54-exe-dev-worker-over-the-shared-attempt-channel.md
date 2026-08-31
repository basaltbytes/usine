---
walkthrough: 1
title: exe.dev Worker over the shared Attempt channel
pr: 54
commit: c848848ed84aa32169d81a14c3ec46e678f32c35
meta:
  pr: "54"
  commit: c848848ed84a
  scope: executor and orchestrator
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Remote Worker execution through the existing seam" icon="cloud" %}
This change adds an exe.dev Worker adapter behind the existing five executor operations. The orchestrator and SQLite store stay local. A persistent exe.dev VM keeps repository caches and runs one run host per Attempt over SSH.

The main review points are:

- preflight verifies the baked VM before the scheduler creates capacity;
- prepare attaches a bounded native GitHub integration grant and creates an isolated worktree;
- local stdio and remote SSH now use one framing and cancellation implementation;
- cleanup removes remote worktrees and releases shared grants;
- each scheduler composition accepts only one Worker kind.

{% callout tone="warn" %}
A single composition does not support a mixed Worker pool. The config schema accepts both `local` and `exe.dev` entries, but `stepExecutorLayer` rejects every Worker whose kind differs from the supplied `Executor.kind`.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Worker selection and readiness" %}
{% section id="worker-kind" title="The adapter declares its Worker kind" icon="sliders" related=["preflight"] %}
`Worker.Kind` now owns the `local` and `exe.dev` values, and the config schema reuses it. The `Executor` contract also exposes `kind` beside the unchanged five operations.

{% code file="packages/executor/src/index.ts" from=105 to=118 expect="/** The five-operation worker contract from ADR 0006. Preflight verifies only — it never installs. */" /%}

At layer construction, the scheduler first validates all configured Workers against that adapter kind. It then runs every preflight concurrently and creates capacity slots only after all checks succeed.

{% code file="packages/orchestrator/src/scheduler.ts" from=82 to=102 expect="/** Configured FIFO worker scheduler and Executor-to-engine adapter. */" /%}

The new composition supplies Node process services to the exe.dev adapter, connects it to the scheduler, and provides that scheduler to the local SQLite engine. Unless the caller overrides it, the grant window is `maxAttemptMinutes + 5`.

{% code file="packages/orchestrator/src/exe-dev.ts" from=13 to=27 expect="/** Complete local-orchestrator / exe.dev-Worker engine composition. */" /%}
{% /section %}

{% section id="preflight" title="Preflight proves the baked VM is ready" icon="shield-check" related=["worker-kind","remote-workspace"] %}
Preflight resolves the configured Worker name from exe.dev metadata. It requires a running VM, parses the SSH destination, and requires an absolute remote home directory. It then checks Git, Node.js 22 or later, the current Attempt protocol version, each configured harness login, and each configured native GitHub integration.

A failed check becomes `WorkerCapabilityError` with one of five capability values: `machine`, `toolchain`, `run-host`, `harness-login`, or `credentials`. This moves VM image skew to scheduler startup instead of an active Attempt. Preflight does not install or attach anything.

{% code file="packages/executor/src/exe-dev/preflight.ts" from=94 to=179 expect="  const preflight = Effect.fn(\"ExeDevExecutor.preflight\")(function* (worker: Worker.Name) {" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Remote Attempt lifecycle" %}
{% section id="remote-workspace" title="Bounded grants and isolated remote worktrees" icon="git-branch" related=["preflight","attempt-channel"] %}
Prepare maps the managed repository to one native exe.dev integration. Before repository access, it sweeps crash leftovers once per Worker and acquires the grant. It uses a stable bare cache for each repository and a separate detached worktree for each Attempt. A repository semaphore serializes cache updates. A new cache is cloned to a staging path and moved into place only after success.

{% code file="packages/executor/src/exe-dev/index.ts" from=76 to=197 expect="    const prepare = Effect.fn(\"ExeDevExecutor.prepare\")(function* (request: CheckoutRequest) {" collapsed=true /%}

Grant updates are serialized by Worker and integration. Each prepare attaches or refreshes the bounded grant and increments an in-memory reference count. Cleanup decrements the count and detaches only after the final active Attempt releases it.

```pseudo
prepare Attempt
  sweep Worker once
  lock Worker + integration
  attach or refresh grant
  increment active count
  fetch cache and add worktree

cleanup Attempt
  remove and prune worktree
  lock Worker + integration
  if another Attempt is active
    decrement active count
  else
    detach integration
```

{% code file="packages/executor/src/exe-dev/grants.ts" from=18 to=64 expect="  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });" /%}

Every remote command becomes one quoted shell string after the SSH `--` boundary. The quoting handles embedded single quotes, so repository revisions and paths cannot add a second command. The SSH process receives only an environment allowlist. The run host receives the public integration host selector, not a GitHub credential. **Credential values are intentionally omitted from this walkthrough.**

{% code file="packages/executor/src/exe-dev/shell.ts" from=1 to=13 expect="const quote = (value: string): string => `'${value.replaceAll(\"'\", `'\"'\"'`)}'`;" /%}

Cleanup attempts worktree removal and grant release independently, logs both failures, and removes prepared state only after both resources are clean. The scheduler runs cleanup in `ensuring`, so launch success, failure, and interruption all enter this path without letting cleanup change the Attempt outcome.
{% /section %}

{% section id="attempt-channel" title="One session state machine for stdio and SSH" icon="workflow" related=["remote-workspace"] %}
The local adapter no longer owns protocol framing or cancellation. `runHostSessionFor` now handles both transports. Each adapter supplies only a process spawn function: the local adapter starts the run host in its worktree, while the exe.dev adapter starts SSH and connects the same input queue to SSH stdin.

```mermaid
sequenceDiagram
  participant O as Orchestrator
  participant S as Shared session
  participant H as Run host
  O->>S: launch prepared Attempt
  S->>H: Start frame
  H-->>S: Started and events
  S-->>O: append envelopes
  H-->>S: Final, Failed, or Interrupted
  S-->>O: result or typed failure
```

The session strictly decodes each newline-delimited outbound envelope. `AttemptChannel.admit` enforces Attempt identity and sequence rules before the sink persists it. A `Final` envelope is not sufficient by itself: the process must also exit successfully.

{% code file="packages/executor/src/run-host-session.ts" from=217 to=346 expect="    const launch = Effect.fn(\"RunHostSession.launch\")(function* (" collapsed=true /%}

Cancellation is idempotent. The first call persists and sends one `Interrupt` envelope. If delivery fails, delivery times out, or the process does not exit during the grace period, the session sends `SIGKILL`. Hard-kill itself is also time-bounded.

{% callout tone="key" %}
The implementation differs from the linked issue text, which says to kill the SSH session and then clean up. The code first performs the protocol interrupt and kills only on delivery failure or grace expiry. This behavior matches ADR 0006's two-stage cancellation rule.
{% /callout %}

{% code file="packages/executor/src/run-host-session.ts" from=119 to=202 expect="    const cancelActive = Effect.fn(\"RunHostSession.cancelActive\")(function* (" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Verification" %}
{% section id="proof" title="Process-seam and live-VM coverage" icon="beaker" %}
The fake SSH suite checks the adapter at the child-process seam. The opt-in integration test checks the full local-orchestrator to remote-VM path.

{% tests %}
{% test name="Remote lifecycle and credential boundary" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["preserves Start and outbound protocol envelopes", "quotes an adversarial revision as one remote argument", "limits the SSH environment", "cleans the worktree and grant idempotently"] %}A fake SSH process runs preflight, prepare, launch, transcript append, and repeated cleanup.{% /test %}
{% test name="Grant sharing and crash recovery" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["refreshes the grant for each prepare", "detaches only after the final cleanup", "sweeps abandoned worktrees", "rejects paths outside the sweep root"] %}Concurrent Attempts share one Worker integration without releasing it early.{% /test %}
{% test name="Protocol outcome and cancellation" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["reports run-host skew as a capability error", "rejects non-zero exit after Final", "sends one cooperative interrupt", "kills stalled or parked sessions after the grace"] %}The Effect test clock covers cooperative and forced cancellation branches.{% /test %}
{% test name="Live exe.dev Attempt" kind="tour" ref="packages/orchestrator/test/integration/exe-dev-worker.test.ts" asserts=["finishes a submitted Run on the configured VM", "persists Started, AgentMessage, and Final", "retains the bare cache", "removes the Attempt worktree"] %}This environment-gated test uses an existing baked VM and native integration.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Executor adapter and tests" only="packages/executor/**" /%}
{% filegroup label="Orchestrator composition and tests" only="packages/orchestrator/**" /%}
{% filegroup label="Worker model and config" only="{packages/core/**,packages/config/**}" /%}
{% filegroup label="Release metadata and lockfile" only="{.changeset/**,pnpm-lock.yaml}" /%}
{% filegroup label="Review walkthrough" only=".agents/walkthroughs/**" /%}
{% /files %}
{% /section %}
{% /group %}
