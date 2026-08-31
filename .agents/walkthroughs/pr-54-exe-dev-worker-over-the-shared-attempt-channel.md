---
walkthrough: 1
title: exe.dev Worker over the shared Attempt channel
pr: 54
commit: 6073e33974a9338cb8d346ac3c63e15bf4bbd834
meta:
  pr: "54"
  commit: 6073e33974a9
  scope: executor and orchestrator
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Remote Worker execution through the existing seam" icon="cloud" %}
This change adds an exe.dev Worker adapter behind the existing five executor operations. The orchestrator and SQLite store stay local. A persistent exe.dev VM keeps repository caches and runs one run host per Attempt over SSH.

The main review points are:

- preflight verifies the baked VM before the scheduler creates capacity;
- prepare attaches a bounded native GitHub integration grant and creates an isolated worktree;
- local stdio and remote SSH now use one framing and cancellation implementation, and one shared provisioning choreography, process runner, and per-key lock;
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

{% code file="packages/executor/src/index.ts" from=123 to=137 expect="/** The five-operation worker contract from ADR 0006. Preflight verifies only — it never installs. */" /%}

At layer construction, the scheduler first validates all configured Workers against that adapter kind. It then runs every preflight concurrently and creates capacity slots only after all checks succeed.

{% code file="packages/orchestrator/src/scheduler.ts" from=82 to=102 expect="/** Configured FIFO worker scheduler and Executor-to-engine adapter. */" /%}

The new composition supplies Node process services to the exe.dev adapter, connects it to the scheduler, and provides that scheduler to the local SQLite engine. Unless the caller overrides it, the grant window is `maxAttemptMinutes + 5`.

{% code file="packages/orchestrator/src/exe-dev.ts" from=13 to=27 expect="/** Complete local-orchestrator / exe.dev-Worker engine composition. */" /%}
{% /section %}

{% section id="preflight" title="Preflight proves the baked VM is ready" icon="shield-check" related=["worker-kind","remote-workspace"] %}
Preflight resolves the configured Worker name from exe.dev metadata. It requires a running VM, and both the SSH destination and the remote home directory are branded value objects — an unvalidated address or path cannot be carried in a `VmState` at all. It then checks Git, Node.js 22 or later, the current Attempt protocol version, each configured harness login, and each configured native GitHub integration.

A failed check becomes `WorkerCapabilityError` with one of five capability values: `machine`, `toolchain`, `run-host`, `harness-login`, or `credentials`. This moves VM image skew to scheduler startup instead of an active Attempt. Preflight does not install or attach anything.

Every refusal is also logged with its worker and capability, so a scheduler that never came up is explainable from logs alone.

{% code file="packages/executor/src/exe-dev/preflight.ts" from=89 to=177 expect="  const preflight = Effect.fn(\"ExeDevExecutor.preflight\")(function* (worker: Worker.Name) {" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Remote Attempt lifecycle" %}
{% section id="remote-workspace" title="Bounded grants and isolated remote worktrees" icon="git-branch" related=["preflight","attempt-channel"] %}
Prepare maps the managed repository to one native exe.dev integration. Before repository access, it sweeps crash leftovers once per Worker; each sweep removal is isolated and logged, and a partial sweep never blocks later prepares. The grant is acquired inside the same compensated, per-repository-locked region as the clone, so an interrupt parked on the lock cannot leak an attachment. The cached-clone-to-worktree choreography itself — staging clone, promote, fetch, detached worktree — is the shared `provisionWorktree`, the same code the local adapter runs; only the primitives (SSH commands versus the filesystem) differ. The per-repository lock is a real keyed mutex: `PartitionedSemaphore`'s permit count is one shared pool, so the previous `permits: 1` construction serialized every repository behind one global permit.

{% code file="packages/executor/src/exe-dev/index.ts" from=77 to=195 expect="    const prepare = Effect.fn(\"ExeDevExecutor.prepare\")(function* (request: CheckoutRequest) {" collapsed=true /%}

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

{% code file="packages/executor/src/exe-dev/grants.ts" from=19 to=65 expect="  const locks = yield* keyedLockFor<string>();" /%}

Every remote command becomes one quoted shell string after the SSH `--` boundary. The quoting handles embedded single quotes, so repository revisions and paths cannot add a second command — and `Repository.Revision` itself now rejects whitespace and a leading dash, so git can never parse a revision as an option either. The SSH process receives only an environment allowlist and sends keepalives, turning a dead link into a failed operation instead of a forever-park. The run host receives the public integration host selector, not a GitHub credential, and records its pid beside the worktree so cleanup can confirm the remote process is dead before removing the workspace under it. **Credential values are intentionally omitted from this walkthrough.**

{% code file="packages/executor/src/exe-dev/shell.ts" from=1 to=20 expect="const quote = (value: string): string => `'${value.replaceAll(\"'\", `'\"'\"'`)}'`;" /%}

Cleanup attempts worktree removal and grant release independently and logs both failures — but the prepared state drops exactly once, whatever the outcome. A partially failed cleanup therefore cannot be retried into a second grant release that would detach a running sibling Attempt's credentials. The scheduler runs cleanup in `ensuring`, so launch success, failure, and interruption all enter this path without letting cleanup change the Attempt outcome; the scheduler also bounds every launch at `max_attempt_minutes`, interrupting through the normal cancel handshake and reporting a typed infrastructure failure before the credential grant lapses.
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

{% code file="packages/executor/src/run-host-session.ts" from=222 to=351 expect="    const launch = Effect.fn(\"RunHostSession.launch\")(function* (" collapsed=true /%}

Cancellation is idempotent. The first call persists and sends one `Interrupt` envelope. If delivery fails, delivery times out, or the process does not exit during the grace period, the session sends `SIGKILL`. Hard-kill has its own five-second bound and never propagates its failure over the error that forced it. The exe.dev grace defaults to ten seconds — an SSH round trip, not a local pipe — and killing the local SSH client is not trusted as proof of remote death: cleanup separately confirms the recorded run-host pid on the VM.

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
{% test name="Grant sharing and crash recovery" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["refreshes the grant for each prepare", "detaches only after the final cleanup", "sweeps abandoned worktrees", "contains an invalid sweep boundary without touching it or blocking prepare"] %}Concurrent Attempts share one Worker integration without releasing it early.{% /test %}
{% test name="Cleanup and interruption stay grant-safe" kind="unit" ref="packages/executor/test/exe-dev.test.ts" asserts=["drops prepared state exactly once when cleanup partially fails", "never re-releases a grant on a second cleanup", "releases the grant when prepare is interrupted mid-clone"] %}The regression pair for the shared-grant hazards: a failed cleanup and an interrupted prepare both leave the refcount balanced.{% /test %}
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
