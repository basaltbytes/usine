# @usine/executor

Worker execution for [usine](https://github.com/basaltbytes/usine). The platform-free package root defines Worker preflight, scoped Attempt preparation, and cancellation. Each prepared Attempt launches its own run host and releases its resources at completion or when its scope closes. It also owns the credential provider, Worker capability errors, and adapter-neutral request types.

## Attempt lifetime

Call `Executor.prepare(request)` inside `Effect.scoped`, then call `prepared.launch(io)`
once. The returned `PreparedAttempt` owns the checkout and repository access. Its
`workspace` is an `AttemptWorkspace` descriptor containing the Worker, RunSpec, and
worktree path; it can be serialized without exposing credentials or live handles.

```ts
const result = yield* Effect.scoped(
  Effect.gen(function* () {
    const prepared = yield* executor.prepare(request)
    return yield* prepared.launch(transcriptSink)
  }),
)
```

Preparation remains interruptible during clone, fetch, credential requests, and lock
waits. A failed prepare releases partial acquisitions immediately. An unlaunched
Attempt releases its resources when the surrounding scope closes. Launch finishes
cleanup before returning on success, failure, or interruption; closing the owner
scope also stops a launch running in another fiber. Each Attempt launches at most
once. Cleanup failures are logged without replacing a successful agent result with
a retryable failure. Set `CheckoutRequest.maxAttemptMinutes` to bound live run-host
execution; preparation and resource cleanup are outside that time budget. Both
ceilings are optional; an absent one leaves that half of the runaway guard unarmed,
and an armed one steers the parent session once at 80% of its limit.

An Attempt that ends without a successful result is salvaged before its worktree is
removed: uncommitted changes are committed as `wip(usine): salvage attempt <id>` and
HEAD is pushed to `CheckoutRequest.salvageRef` with the Worker's credentials. The
result reaches the engine through `Sink.salvage`. A failed push keeps the worktree
on disk and reports its path and the failure: git's exit code followed by git's own
stderr, so a deleted remote reads differently from a revoked App; a push that stalls
past two minutes is named as such. The local adapter scrubs the Attempt's token from
that stderr first, and an exe.dev VM never holds one. The startup sweep leaves such a
worktree alone. Every later startup retries the salvage with fresh credentials, for
open and closed Runs alike, and rewrites the record from `Retained` to `Pushed` once
the push succeeds; until then the record carries the latest failure for the run
drawer. A request whose `resume` names a pushed salvage checks that ref out instead
of the bare revision; a missing ref falls back to the revision.

`cancel(attemptId)` applies from the start of preparation: harness probes, credential
acquisition, repository lock waits, and checkout creation. Cancellation stops
preparation before releasing acquired resources and prevents a prepared Attempt from
launching later. Both `cancel` and the canceled `prepare` or `launch` return only after
those resources are released. Once the channel is live, cancellation sends the Cancel
envelope and uses the configured grace period before forced termination. Repeated
cancellation after release is a no-op.

Recognizable Effect log lines on run-host stdout are dropped with a warning that records safe shape metadata. Invalid JSON, schema-invalid frames, and protocol sequence violations still fail the Attempt.

This replaces the 0.x `Executor.launch(prepared, io)` and `Executor.cleanup(prepared)`
methods. Consumers supply a scope instead of coordinating cleanup. The engine's
`StepExecutor` reservation, execution, and interruption contract remains unchanged.

## Worker preflight

Call `executor.preflight(worker, brains)` with the instance roster’s `BrainSpec` values before scheduling Attempts. Both adapters invoke `usine-run-host --preflight '<brain-json>'` on the Worker. The run host checks each selected harness’s executable and authentication; Codex requires supported CLI 0.144.0 or 0.153.4 and a ChatGPT login, Claude requires its CLI and subscription login, and Pi children require API keys for their selected models.

`prepare` repeats the assigned brain’s probe before acquiring credentials or creating a checkout. This checks roster changes and logouts after startup. A reported capability gap returns `WorkerCapabilityError` and requires operator action. Transport failures and probe timeouts remain infrastructure failures eligible for retry. Custom run hosts must implement the credential-free `HarnessReadiness` response from `@usine/core/agent/capability`.

This replaces exe.dev’s `HarnessLoginCheck` and `harnessLoginChecks` options. Pass the roster to `preflight` so readiness follows the agents the instance actually uses.

## Local Worker

The Node adapter at `@usine/executor/local` does the following for each Attempt:

- checks Git, the installed run-host protocol, and the assigned harness before accepting work;
- updates a per-repository bare cache, then creates a detached worktree at the resolved revision;
- renews repository credentials before expiry; Git reads an Attempt token file and `gh` reads its private `GH_CONFIG_DIR` on each invocation, so the salvage push at the end of a multi-hour Attempt uses the credential renewed last, and startup reconciliation issues a fresh one;
- exchanges protocol-v7 envelopes with `@usine/run-host` over newline-delimited standard input and output, including immutable payload, agent context, child-session budget, and normalized session events;
- interrupts cooperatively before a hard kill, then removes the worktree and wipes the credential.

`LocalExecutorOptions.runHost` can override the child command for another compatible host. The adapter otherwise launches the executable shipped by `@usine/run-host` and rejects a protocol-version mismatch during preflight.

The adapter sets `TURBO_CACHE_DIR` to `.usine/workers/<worker>/turbo` for the run host. Startup cache sweeps prune only the `*.git` cache directories the adapter itself creates under `repos/`; every other entry is skipped and logged at debug level, and each sweep ends with an info log of pruned, skipped, and failed counts.

The local layer requires Effect `FileSystem`, `Path`, and `ChildProcessSpawner` services plus a `CredentialProvider`. Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

## exe.dev Worker

`@usine/executor/exe-dev` runs the same contract on a persistent exe.dev VM. The configured Worker name must match the VM name. The VM image must already contain Git, Node.js 22 or later, the compatible `usine-run-host` executable, and every coding-agent login used by the instance.

Preflight creates no checkouts or credential grants. It reads VM metadata through `ssh exe.dev ls --json`, checks Git and Node.js over SSH, compares the run-host protocol version, probes the supplied roster through the remote run host, and asks exe.dev to test each native GitHub integration.

Prepare attaches the repository's integration to the VM with a bounded `--for` grant. It then fetches a bare cached clone from `github.int.exe.xyz` and creates a detached worktree for the Attempt. Launch keeps one SSH process open and exchanges protocol-v7 frames on that process's standard input and output. Cleanup removes the worktree, prunes its cache registration, and detaches the integration after the last concurrent Attempt using it finishes.

Startup reconciles unsuccessful Attempts before registering their durable workflows. Each existing checkout is snapshotted and pushed, and its salvage is recorded before removal. Failed pushes and unknown crash leftovers remain on disk. Cache sweeps prune registrations for missing directories; they never delete existing checkouts. One-shot lobby and SSH commands carry a ten-minute timeout, and the SSH client sends keepalives so a dead link fails the operation instead of parking it. Cancellation also bounds interrupt persistence and delivery before escalating to a hard kill, so a parked store or remote process cannot stall shutdown; before removing a workspace, cleanup reads the run host's recorded pid on the VM and confirms the process is dead, because killing the local SSH client alone says nothing about the remote side.

Concurrent Attempts against different repositories leave their integrations attached to the VM simultaneously; each grant renews at half its lifetime for as long as its Attempt runs, a failed renewal is retried every minute until it succeeds, and the refcounted release detaches an integration only after its last Attempt finishes. The grant length (`credentialGrantMinutes`, 65 by default) is a renewal window, not an Attempt bound: it does not depend on `max_attempt_minutes`, and an Attempt with no ceiling keeps its grant for its whole life. A failed detach is logged and left to lapse with its time-box. If remote termination cannot be confirmed, cleanup retains the checkout and its Git registration for recovery, logs its location, and still releases the credential grant. Partial preparation rolls back without requiring remote-process confirmation because no run host has launched.

```ts
import { RepositoryName } from "@usine/core/repository"
import { layer } from "@usine/executor/exe-dev"
import { GitHubIntegration, IntegrationName } from "@usine/executor/exe-dev"

const executorLayer = layer({
  githubIntegrations: [
    new GitHubIntegration({
      repository: RepositoryName.make("acme/widget"),
      name: IntegrationName.make("usine-acme-widget"),
    }),
  ],

})
```

The native integration holds the GitHub credential at exe.dev's network edge. No GitHub token enters the RunSpec, the Attempt channel, the local SSH environment, or the VM. Git pushes from this Worker use `exe-dev-github-integration[bot]`; agent-authored PRs and comments should carry the Agent signature used by the run.

Salvage inspection, staging, or snapshot failures retain the checkout, including uncommitted files. Restart recovery uses freshly issued credentials and records the recovered ref before releasing the worktree.
