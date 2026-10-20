# @usine/executor

Worker execution for [usine](https://github.com/basaltbytes/usine). The platform-free package root defines Worker preflight, scoped Attempt preparation, and cancellation. Each prepared Attempt runs its Pi parent in this process as a durable task, tells it where the Worker runs its children (as local processes, or over SSH on an exe.dev VM or any Linux machine), and releases its resources at completion or when its scope closes. It also owns the credential provider, Worker capability errors, and adapter-neutral request types.

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
a retryable failure. Set `CheckoutRequest.maxAttemptMinutes` to bound live
execution; preparation and resource cleanup are outside that time budget. Both
ceilings are optional; an absent one leaves that half of the runaway guard unarmed,
and an armed one steers the parent session once at 80% of its limit.

`CheckoutRequest.permissions` is the Attempt's Loop permission level. A `read`
Attempt's credential is minted with `contents: read`, so it cannot push; an exe.dev
Worker, whose integration cannot grant that, refuses the Attempt with a `credentials`
`WorkerCapabilityError` before it attaches the integration. A `read` checkout also
gets a pre-push hook that stops `git push` with a message naming the Loop, so the
Agent reads why instead of GitHub's 403; `git push --no-verify` skips it, and the
token is what refuses the push. A `read` Attempt is never salvaged.

An Attempt that ends without a successful result is salvaged before its worktree is
removed: uncommitted changes are committed as `wip(usine): salvage attempt <id>` and
HEAD is pushed to `CheckoutRequest.salvageRef` with the Worker's credentials. The
result reaches the engine through `Sink.salvage`. A failed push keeps the worktree
on disk and reports its path and the failure: git's exit code followed by git's own
stderr, so a deleted remote reads differently from a revoked App; a push that stalls
past two minutes is named as such. The local and SSH adapters scrub the Attempt's token
from that stderr first, and an exe.dev VM never receives one. The startup sweep leaves such a
worktree alone. Every later startup retries the salvage with fresh credentials, for
open and closed Runs alike, and rewrites the record from `Retained` to `Pushed` once
the push succeeds; until then the record carries the latest failure for the run
drawer. A request whose `resume` names a pushed salvage fetches the revision again
and applies the salvage on top of it: a salvage whose fork point is the fetched
commit is checked out as it is, and one made on an older base is rebased onto it,
so a retry of an issue Run after a fix on the default branch works from that fix.
A salvage with no changes beyond the revision is dropped. A salvage that does not
rebase cleanly is left out: the worktree starts from the revision,
`RunSpec.conflictingSalvage` names the salvage, and its branch keeps the work. A
missing ref falls back to the revision.

Startup reconciliation lists each Worker's `attempts/` directory once per executor
instance. Every adapter skips historical Attempts absent from that listing without
inspecting individual checkout paths. Failed listings remain cached
for that startup and are retried after restart. Existing checkouts still follow the
record-before-remove salvage order; succeeded Attempts only need checkout removal.

`cancel(attemptId)` applies from the start of preparation: harness probes, credential
acquisition, repository lock waits, and checkout creation. Cancellation stops
preparation before releasing acquired resources and prevents a prepared Attempt from
launching later. Both `cancel` and the canceled `prepare` or `launch` return only after
those resources are released. Once the Attempt is live, cancellation cancels its parent
task and uses the configured grace period before forced termination. Concurrent and
repeated cancellation wait for cleanup and preserve the launch's typed failure.
Repeated cancellation after release is a no-op.

This replaces the 0.x `Executor.launch(prepared, io)` and `Executor.cleanup(prepared)`
methods. Consumers supply a scope instead of coordinating cleanup. The engine's
`StepExecutor` reservation, execution, and interruption contract remains unchanged.

## Worker preflight

Call `executor.preflight(worker, brains, maxConcurrentAttempts)` with the instance roster’s `BrainSpec` values and the Worker's `max_concurrent_attempts` before scheduling Attempts.

Every adapter compares the memory of the Worker's machine with `maxConcurrentAttempts`: the local adapter reads `/proc/meminfo` on Linux and the physical memory on macOS, where swap grows on demand, and the exe.dev and SSH adapters read `/proc/meminfo` over SSH. Less than 1.5 GiB per concurrent Attempt, or no swap with more than one concurrent Attempt, is a `WorkerCapabilityError` with the `memory` capability; less than 3 GiB per concurrent Attempt logs a warning. Two Attempts at once thrashed a 4 GB Worker without swap until sshd stopped answering ([#270](https://github.com/basaltbytes/usine/issues/270)).

Every adapter runs the `@usine/agents/preflight` checks where the Worker runs children: the local adapter on this machine (override with `LocalExecutorOptions.harnessReadiness`), the exe.dev and SSH adapters over SSH on the Worker's machine (override with `SshExecutorOptions.harnessReadiness`). They check each selected harness’s executable and authentication; Codex requires supported CLI 0.144.0 or 0.153.4 and a ChatGPT login, Claude requires its CLI and subscription login, and Pi children require API keys for their selected models. Pi children run their tools in the orchestrator process, so exe.dev and SSH Workers report a Pi brain as unavailable.

`prepare` repeats the assigned brain’s probe before acquiring credentials or creating a checkout. This checks roster changes and logouts after startup. A reported capability gap returns `WorkerCapabilityError` and requires operator action. Transport failures, including an SSH client that cannot reach the VM, and probe timeouts remain infrastructure failures eligible for retry.

This replaces exe.dev’s `HarnessLoginCheck` and `harnessLoginChecks` options. Pass the roster to `preflight` so readiness follows the agents the instance actually uses.

## Local Worker

The Node adapter at `@usine/executor/local` does the following for each Attempt:

- checks Git and the assigned harness before accepting work;
- updates a per-repository bare cache, then creates a detached worktree at the resolved revision;
- renews repository credentials before expiry; Git reads an Attempt token file and `gh` reads its private `GH_CONFIG_DIR` on each invocation, so the salvage push at the end of a multi-hour Attempt uses the credential renewed last, and startup reconciliation issues a fresh one;
- runs the Attempt's Pi parent as a durable task in this process through `AttemptRuntime` (`@usine/durable`), passing the Attempt's environment: the allowlisted variables, the credential configuration, and `TURBO_CACHE_DIR`, never the orchestrator's own environment;
- harvests commits and pull requests from the worktree, and the comments and reviews the Attempt posted on its Run's Item, with `@usine/core/step/harvest`, running `git` and `gh` in that same environment; an Attempt that fails or is canceled, other than by this process stopping, has only its comments harvested, after its parent task stops, and they reach the engine through `Sink.comments`;
- cancels the parent task before forced interruption, then removes the worktree and wipes the credential.

When the orchestrator stops while an Attempt runs, the parent task stays live in durable storage and the worktree stays on disk. After a restart, `recover` leaves a live open Attempt alone, `isLive` lets the engine reattach it, and `prepare` with `reattach` takes over the existing worktree with freshly issued credentials instead of checking out a new one, reading the RunSpec and its base commit from the parent task's stored request (`AttemptRuntime.request`). A parent that reported success before its worktree was harvested counts as live too, so the reattachment harvests it. Once the harvest is done, the result is recorded in durable storage before the worktree is released, and `outcome` returns it, or the parent's failure, to an engine that stopped before recording the Attempt. Every other end of an Attempt leaves no live parent task behind: a failure, a cancel, or a tripped ceiling cancels it, and recovery cancels the live task of an Attempt the engine already closed.

`TURBO_CACHE_DIR` points at `.usine/workers/<worker>/turbo`. Startup cache sweeps prune only the `*.git` cache directories the adapter itself creates under `repos/`; every other entry is skipped and logged at debug level, and each sweep ends with an info log of pruned, skipped, and failed counts.

The local layer requires Effect `FileSystem`, `Path`, and `ChildProcessSpawner` services, a `CredentialProvider`, and an `AttemptRuntime`. Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

## exe.dev Worker

`@usine/executor/exe-dev` runs the same contract on a persistent exe.dev VM. The configured Worker name must match the VM name. The VM image must already contain Git, the `claude` and `codex` CLIs the roster uses, and every coding-agent login used by the instance.

Preflight creates no checkouts or credential grants. It reads VM metadata through `ssh exe.dev ls --json`, checks Git and the VM's memory over SSH, probes the supplied roster on the VM, and asks exe.dev to test each native GitHub integration.

Prepare attaches the repository's integration to the VM with a bounded `--for` grant. It then fetches a bare cached clone from `github.int.exe.xyz` and creates a detached worktree for the Attempt. Launch runs the Attempt's Pi parent in this process as a durable task through `AttemptRuntime`, with a `RemoteShell` child host: every Claude Code or Codex child is one SSH command that changes into the worktree, exports `GH_HOST=github.int.exe.xyz` on top of the VM's own environment, and runs the harness there. Harvesting runs `git` and `gh` in the worktree the same way. Cleanup removes the worktree, prunes its cache registration, and detaches the integration after the last concurrent Attempt using it finishes.

An SSH client that exits does not prove its remote command has stopped, so each remote child records its pid at `<worktree>.child-<n>.pid` while it runs. Before a workspace is removed or kept, cleanup stops every recorded child on the VM and confirms it is dead; cancel, recovery, and reattach do the same.

When the orchestrator stops while an Attempt runs, the parent task stays live in durable storage and the worktree stays on the VM. After a restart, `recover` leaves a live open Attempt alone, `isLive` lets the engine reattach it, and `prepare` with `reattach` checks that the parent task's stored request names this worktree and that the worktree still exists on the VM, stops any child left from before the restart, and takes the worktree over with a fresh credential grant. A reattachment whose VM or worktree is gone fails and cancels the parent task, so the engine retries on a new Attempt.

Startup reconciles unsuccessful Attempts before the engine recovers their Runs. Each existing checkout is snapshotted and pushed, and its salvage is recorded before removal. Failed pushes and unknown crash leftovers remain on disk. Cache sweeps prune registrations for missing directories; they never delete existing checkouts. One-shot lobby and SSH commands carry a ten-minute timeout, and the SSH client sends keepalives so a dead link fails the operation instead of parking it.

Concurrent Attempts against different repositories leave their integrations attached to the VM simultaneously; each grant renews at half its lifetime for as long as its Attempt runs, a failed renewal is retried every minute until it succeeds, and the refcounted release detaches an integration only after its last Attempt finishes. The grant length (`credentialGrantMinutes`, 65 by default) is a renewal window, not an Attempt bound: it does not depend on `max_attempt_minutes`, and an Attempt with no ceiling keeps its grant for its whole life. A failed detach is logged and left to lapse with its time-box. If stopping the remote children cannot be confirmed, cleanup retains the checkout and its Git registration for recovery, logs its location, and still releases the credential grant. Partial preparation rolls back without stopping remote children because none has started.

The exe.dev layer requires a `ChildProcessSpawner` and an `AttemptRuntime`.

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

The native integration holds the GitHub credential at exe.dev's network edge. No GitHub token enters the RunSpec, the Attempt's durable request, the local SSH environment, or the VM. Git pushes from this Worker use `exe-dev-github-integration[bot]`; agent-authored PRs and comments should carry the Agent signature used by the run.

Salvage inspection, staging, or snapshot failures retain the checkout, including uncommitted files. Restart recovery uses freshly issued credentials and records the recovered ref before releasing the worktree.

## SSH Worker

`@usine/executor/ssh` runs the same contract on any Linux machine the orchestrator connects to over SSH ([ADR 0026](../../docs/adr/0026-eu-ssh-worker.md)); `infra/hetzner` creates one on Hetzner Cloud. Each Worker names its machine: an SSH destination, an optional identity file and port, and a root directory under which it keeps `workers/<name>/repos`, `attempts`, and `credentials`. The machine must already contain Git, gh, the `claude` and `codex` CLIs the roster uses, and their logins for the SSH user.

Preflight changes nothing on the machine. It checks that SSH connects to it, that the root is a writable directory, that Git runs, that its memory carries `maxConcurrentAttempts`, and the roster's harnesses where the children run.

Prepare mints the Attempt's single-repository token through the `CredentialProvider`, writes it into `<root>/workers/<name>/credentials/<attempt>` with a gh `hosts.yml`, and fetches the bare cached clone from `https://github.com/<repository>.git` with git's credential helper reading that token file. The token is sent on the standard input of the command that writes it, so it never appears in a command line or a process environment and is not written to any log, and git and gh output is scrubbed of it. Each git and harvesting command renews the token first when it expires within five minutes, as on the local Worker. Children, harvesting, and the salvage push export the same file paths, so they all read the token renewed last. Cleanup stops the Attempt's children, removes the checkout, then removes the credential directory. The first use of a Worker by a process, for an Attempt or for startup reconciliation, removes the credentials an earlier process left; a reattached Attempt receives a fresh one.

Children, pid files, the kill script, sweeps, salvage, recovery, and reattachment are the exe.dev Worker's, through the same shared code.

### Behind a Gateway

A Worker whose address has a `gateway` sits on a private network behind a Gateway ([ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md)), and no GitHub token is written on its machine. Prepare mints the same token, attaches it to the Gateway's admin API for the Worker and the repository (`POST /v1/attachments` with the token's expiry), and keeps the attachment id and the caller token the Gateway answers with. Renewal replaces the token on the same attachment (`PUT /v1/attachments/<id>`) before it expires, and every two minutes the same request stores the attachment again with the current token, so a restarted Gateway has it back. Cleanup detaches it after the checkout is cleaned up; a failed detach is logged as a warning, since the attachment expires with its token. Each admin request gives up after 30 seconds. The first use of a Worker by a process detaches every attachment the Gateway holds for that Worker, each on its own, so a reattached Attempt attaches again with a new caller token.

The cached clone fetches `http://git.<domain>/<repository>.git`. Children, harvesting, and the executor's own git commands export the configuration that points git, gh, and package managers at the Gateway: git sends the caller token only to `git.<domain>` and rewrites `https://github.com/` there, gh uses `git.<domain>` through the Worker's socket with gh's configuration in `<root>/workers/<name>/gh`, and `HTTPS_PROXY` is the Gateway's forward proxy. When the Gateway holds the Anthropic credential, Claude Code calls `llm.<domain>/anthropic`, and preflight checks only its binary. Otherwise Claude Code, and Codex always, use the operator's login on the machine and reach their provider through the forward proxy: preflight checks the login as on a Worker without a Gateway, then that the machine gets an HTTP answer from each of the login's hosts through the proxy (`api.anthropic.com` and `platform.claude.com`, or `chatgpt.com` and `auth.openai.com`). A host the proxy refuses is a `gateway` capability error that names the host to add to the Gateway's egress allowlist. The caller token itself is in no command line: each SSH command for the Attempt sends `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN` from the SSH client's own environment (`SendEnv`), and the machine's sshd must accept them (`AcceptEnv`).

The admin API listens on the Gateway's loopback interface. With the first Worker behind a Gateway, the executor opens its own forward to it, `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<adminPort> <destination>` with the same SSH command and environment as its other SSH clients, on a local port the kernel picks, and Workers behind the same Gateway share it. When the SSH client exits, the executor starts another one after a pause of one second that doubles up to one minute, and logs each open, exit, and reopen with the Gateway's destination. An admin request that finds the forward closed, or gets no answer through it, has the forward reopened at once and is sent once more; a second failure fails the request, and its message says since when the forward has been closed, or, when the forward opens but the admin API does not answer, since when the admin API has answered no request through it. The forward closes when the last Worker behind the Gateway is removed, or with the layer.

Preflight also checks, without attaching anything, that the forward opens, giving the `ssh` command to run when it does not, that the admin API answers with the admin token, that the machine's sshd accepts those variables, and that the machine reaches `git.<domain>`, which refuses a request without a caller token. A gap is a `WorkerCapabilityError` with the `gateway` capability.

The SSH layer requires a `ChildProcessSpawner`, a `CredentialProvider`, an `AttemptRuntime`, and an `HttpClient` for Gateway admin APIs.

The layer provides `SshWorkers` beside the `Executor`. It starts with the Workers of `workers`, and `addWorker(address)` gives the executor another one while it runs: behind a Gateway, the new Worker shares the forward of the Workers behind the same Gateway, or opens one when it is the first. `removeWorker(name)` takes a Worker away once no Attempt runs on it, and closes its Gateway's forward when no other Worker is behind that Gateway. Adding a Worker the executor has with the same address changes nothing; with another address it fails with a `machine` capability error until the Worker is removed.

```ts
import { SshDestination, SshIdentityFile, WorkerName, WorkerRoot } from "@usine/core/worker"
import { layer } from "@usine/executor/ssh"
import { Option } from "effect"

const executorLayer = layer({
  workers: [
    {
      name: WorkerName.make("eu-one"),
      destination: SshDestination.make("usine@203.0.113.7"),
      identityFile: Option.some(SshIdentityFile.make("~/.ssh/usine_worker")),
      port: Option.none(),
      root: WorkerRoot.make("/home/usine/.usine"),
      gateway: Option.none(),
    },
  ],
})
```
