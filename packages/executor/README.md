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
a retryable failure.

This replaces the 0.x `Executor.launch(prepared, io)` and `Executor.cleanup(prepared)`
methods. Consumers supply a scope instead of coordinating cleanup. The engine's
`StepExecutor` reservation, execution, and interruption contract remains unchanged.

## Local Worker

The Node adapter at `@usine/executor/local` does the following for each Attempt:

- checks Git and the installed run-host protocol without changing worker state;
- updates a per-repository bare cache, then creates a detached worktree at the resolved revision;
- mints one repository credential and passes it only through the child process environment;
- exchanges protocol-v4 envelopes with `@usine/run-host` over newline-delimited standard input and output, including immutable payload, agent context, child-session budget, and normalized session events;
- interrupts cooperatively before a hard kill, then removes the worktree and wipes the credential.

`LocalExecutorOptions.runHost` can override the child command for another compatible host. The adapter otherwise launches the executable shipped by `@usine/run-host` and rejects a protocol-version mismatch during preflight.

The adapter sets `TURBO_CACHE_DIR` to `.usine/workers/<worker>/turbo` for the run host. Startup cache sweeps prune only the `*.git` cache directories the adapter itself creates under `repos/`; every other entry is skipped and logged at debug level, and each sweep ends with an info log of pruned, skipped, and failed counts.

The local layer requires Effect `FileSystem`, `Path`, and `ChildProcessSpawner` services plus a `CredentialProvider`. Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

## exe.dev Worker

`@usine/executor/exe-dev` runs the same contract on a persistent exe.dev VM. The configured Worker name must match the VM name. The VM image must already contain Git, Node.js 22 or later, the compatible `usine-run-host` executable, and every coding-agent login used by the instance.

Preflight changes no remote state. It reads VM metadata through `ssh exe.dev ls --json`, checks Git and Node.js over SSH, compares the run-host protocol version, runs the configured harness login checks, and asks exe.dev to test each native GitHub integration.

Prepare attaches the repository's integration to the VM with a bounded `--for` grant. It then fetches a bare cached clone from `github.int.exe.xyz` and creates a detached worktree for the Attempt. Launch keeps one SSH process open and exchanges protocol-v4 frames on that process's standard input and output. Cleanup removes the worktree, prunes its cache registration, and detaches the integration after the last concurrent Attempt using it finishes.

The first prepare on each VM after orchestrator startup sweeps abandoned Attempt worktrees and prunes cached worktree registrations left by a crash. Each sweep removal is isolated and logged: an immovable leftover never blocks its siblings or later prepares, and the sweep runs once per process regardless of partial failures. One-shot lobby and SSH commands carry a ten-minute timeout, and the SSH client sends keepalives so a dead link fails the operation instead of parking it. Cancellation also bounds interrupt persistence and delivery before escalating to a hard kill, so a parked store or remote process cannot stall shutdown; before removing a workspace, cleanup reads the run host's recorded pid on the VM and confirms the process is dead, because killing the local SSH client alone says nothing about the remote side.

Concurrent Attempts against different repositories leave their integrations attached to the VM simultaneously; each grant stays time-boxed, and the refcounted release detaches an integration only after its last Attempt finishes. A failed detach is logged and left to lapse with its time-box.

```ts
import { RepositoryName } from "@usine/core/repository"
import { layer } from "@usine/executor/exe-dev"
import { GitHubIntegration, HarnessLoginCheck, IntegrationName } from "@usine/executor/exe-dev"

const executorLayer = layer({
  githubIntegrations: [
    new GitHubIntegration({
      repository: RepositoryName.make("acme/widget"),
      name: IntegrationName.make("usine-acme-widget"),
    }),
  ],
  harnessLoginChecks: [
    new HarnessLoginCheck({
      harness: "codex",
      command: "codex",
      args: ["login", "status"],
    }),
  ],
})
```

The native integration holds the GitHub credential at exe.dev's network edge. No GitHub token enters the RunSpec, the Attempt channel, the local SSH environment, or the VM. Git pushes from this Worker use `exe-dev-github-integration[bot]`; agent-authored PRs and comments should carry the Agent signature used by the run.
