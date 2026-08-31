---
walkthrough: 1
title: exe.dev Worker execution over the shared Attempt channel
pr: 54
commit: 94c8b620a5ba85c21f4fa123ce6c26d873c9f23c
meta:
  pr: "54"
  commit: 94c8b620a5ba
  scope: executor and orchestrator
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Remote execution behind the Worker seam" icon="cloud" %}
This change adds an exe.dev Worker adapter without changing the five executor operations or the Attempt channel protocol. The orchestrator stays local. It uses local SQLite for durable state, while a named exe.dev VM holds the cached repository and runs the one-shot run host over SSH.

The main review points are:

- preflight verifies the baked VM and reports a typed capability failure;
- prepare attaches a bounded native GitHub integration grant and creates a remote worktree;
- local and remote adapters now use one channel and cancellation state machine;
- cleanup removes the worktree and releases the shared grant after each Attempt;
- the scheduler checks the configured Worker kind against the supplied adapter.

{% callout tone="warn" %}
One composition supports one Worker kind. A config can name `local` and `exe.dev`, but `stepExecutorLayer` rejects any Worker whose kind differs from `executor.kind`. This PR does not compose a mixed local-and-remote pool.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Worker selection and readiness" %}
{% section id="worker-kind" title="The adapter declares the Worker kind" icon="sliders" related=["preflight"] %}
`Worker.Kind` is now the shared source for the `local` and `exe.dev` values. The config schema reuses this type. Each `Executor` also declares its kind, so the scheduler can validate the complete Worker list before it creates capacity slots or starts work.

{% code file="packages/executor/src/index.ts" from=105 to=113 expect="/** The five-operation worker contract from ADR 0006. Preflight verifies only — it never installs. */" /%}

The scheduler validates all configured Workers against that value. It then runs preflight concurrently and only creates the slot queue after every check succeeds.

{% code file="packages/orchestrator/src/scheduler.ts" from=82 to=100 expect="/** Configured FIFO worker scheduler and Executor-to-engine adapter. */" /%}

The new composition provides Node process services to the exe.dev adapter, connects it to the existing scheduler, and provides that scheduler to the local SQLite engine. Its default grant duration is `maxAttemptMinutes + 5`, rather than the adapter's standalone 65-minute default.

{% code file="packages/orchestrator/src/exe-dev.ts" from=13 to=27 expect="/** Complete local-orchestrator / exe.dev-Worker engine composition. */" /%}
{% /section %}

{% section id="preflight" title="Preflight proves the baked VM is usable" icon="shield-check" related=["worker-kind","grant-lifecycle"] %}
Preflight does not install software. It resolves the configured Worker name through exe.dev machine metadata, requires a running VM, parses a restricted SSH destination, and reads an absolute remote home directory.

It then checks these capabilities in order:

1. Git returns a recognized version string.
2. Node.js has major version 22 or later.
3. The remote run host reports the current Attempt protocol version.
4. Every configured harness login command exits successfully.
5. Every configured native GitHub integration passes exe.dev's integration test.

Failures become `WorkerCapabilityError` values tagged as `machine`, `toolchain`, `run-host`, `harness-login`, or `credentials`. This makes image skew fail during scheduler startup instead of during an Attempt.

{% code file="packages/executor/src/exe-dev/preflight.ts" from=94 to=162 expect="  const preflight = Effect.fn(\"ExeDevExecutor.preflight\")(function* (worker: Worker.Name) {" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Remote Attempt lifecycle" %}
{% section id="grant-lifecycle" title="Bounded edge grants follow active Attempts" icon="key" related=["workspace","preflight"] %}
The adapter maps each managed repository to one native exe.dev integration. Prepare attaches or refreshes that integration with a time limit before it accesses the remote repository.

A partitioned semaphore serializes updates for each Worker and integration pair. A reference count permits concurrent Attempts to share the attachment:

```pseudo
prepare Attempt
  lock Worker + integration
  attach or refresh bounded grant
  increment active count

cleanup Attempt
  lock Worker + integration
  if more Attempts remain
    decrement active count
  else
    detach integration
```

{% code file="packages/executor/src/exe-dev/grants.ts" from=18 to=64 expect="  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });" /%}

The SSH client receives only an allowlist of ordinary process and SSH-agent variables. GitHub credential variables are not copied from the orchestrator. The remote clone uses exe.dev's integration host, and the run host receives only the public `GH_HOST` selector. The credential itself stays at the exe.dev edge.
{% /section %}

{% section id="workspace" title="Cached clone, isolated worktree, and cleanup" icon="git-branch" related=["grant-lifecycle","attempt-channel"] %}
Prepare uses a stable bare cache per Worker and repository, but a separate worktree per Attempt. The repository lock prevents concurrent clone or fetch operations from changing the same cache. A first clone uses a staging path and moves it into place only after success. Every prepare fetches the requested revision, parses `FETCH_HEAD` as a commit SHA, and creates a detached worktree.

{% code file="packages/executor/src/exe-dev/index.ts" from=88 to=191 expect="      const vm = yield* worker.vmFor(request.worker);" collapsed=true /%}

Every remote command is converted to one shell command after the SSH `--` boundary. The quoting function single-quotes the executable and each argument, including embedded single quotes. This prevents a revision or path from becoming a second remote shell command.

{% code file="packages/executor/src/exe-dev/shell.ts" from=1 to=13 expect="const quote = (value: string): string => `'${value.replaceAll(\"'\", `'\"'\"'`)}'`;" /%}

Cleanup removes the Git worktree registration, removes the directory as a fallback, prunes the cache, and releases the grant. Missing prepared state is a logged no-op, so repeated cleanup is safe. If prepare fails, its error path also removes partial workspace state and releases the grant.
{% /section %}

{% section id="attempt-channel" title="One channel state machine for stdio and SSH" icon="workflow" related=["workspace"] %}
The local adapter no longer owns framing and cancellation logic. `runHostSessionFor` now owns that behavior for both adapters. Each adapter supplies only a process spawn function:

- local spawn sets the worktree as `cwd`, injects its redacted repository credential, and scrubs that credential from stderr;
- exe.dev spawn opens SSH, selects the remote worktree, and connects the same framed input queue to SSH stdin.

```mermaid
sequenceDiagram
  participant O as Orchestrator
  participant S as Shared session
  participant H as Run host
  O->>S: launch(prepared, sink)
  S->>H: Start frame
  H-->>S: Started and events
  S-->>O: Persist envelopes
  H-->>S: Final / Failed / Interrupted
  S-->>O: Result or typed failure
```

The shared session strictly decodes each newline-delimited envelope, applies `AttemptChannel.admit` for attempt identity and sequence rules, appends accepted envelopes to the transcript sink, and requires both a terminal envelope and a successful process exit for success.

{% code file="packages/executor/src/run-host-session.ts" from=162 to=240 expect="    const launch = Effect.fn(\"RunHostSession.launch\")(function* (" collapsed=true /%}

Cancellation is idempotent. The first call records and sends an `Interrupt` frame. If the process does not exit within the grace period, the session hard-kills it. The orchestrator then runs adapter cleanup in an `ensuring` block, regardless of the launch outcome.

{% callout tone="key" %}
The implementation does not always kill the SSH process immediately, as the linked issue text states. It first uses the protocol interrupt and kills only after delivery failure or grace expiry. This matches the two-stage cancellation rule in ADR 0006.
{% /callout %}

{% code file="packages/orchestrator/src/scheduler.ts" from=174 to=201 expect="          return yield* executor.launch(prepared, io).pipe(" /%}
{% /section %}
{% /group %}

{% group label="Verification" %}
{% section id="proof" title="Executor and live-VM proof" icon="beaker" %}
The fake SSH suite checks the adapter at the process boundary. The opt-in integration test checks the complete local-orchestrator to remote-VM path.

{% tests %}
{% test name="Remote completion and secret boundary" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["preserves protocol-v1 Start and outbound envelopes", "quotes an adversarial revision as one remote argument", "does not put GitHub token variables in SSH environments", "cleans the worktree and detaches the integration idempotently"] %}A fake SSH process exercises preflight, prepare, launch, transcript append, and repeated cleanup.{% /test %}
{% test name="Concurrent grant sharing" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["refreshes the grant for each prepare", "keeps the integration attached after the first cleanup", "detaches after the final cleanup"] %}Two Attempts share one Worker and integration.{% /test %}
{% test name="Typed skew and process outcome" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["reports protocol skew as a run-host capability error", "rejects a non-zero SSH exit after Final"] %}The tests keep readiness errors separate from runtime infrastructure failures.{% /test %}
{% test name="Cooperative and forced cancellation" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["sends one Interrupt across repeated cancel calls", "accepts remote Interrupted without a kill", "kills a stalled SSH session after the grace period"] %}The test clock covers both branches of the shared cancellation state machine.{% /test %}
{% test name="Live exe.dev Attempt" kind="tour" ref="packages/orchestrator/test/integration/exe-dev-worker.test.ts" asserts=["finishes a submitted Run on the configured VM", "persists Started, AgentMessage, and Final", "retains the bare cache", "removes the Attempt worktree"] %}This environment-gated test uses a real baked VM and native integration.{% /test %}
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
{% /files %}
{% /section %}
{% /group %}
