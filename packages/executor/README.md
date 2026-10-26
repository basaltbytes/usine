# @usine/executor

Worker execution for [usine](https://github.com/basaltbytes/usine). The platform-free root defines worker preflight, scoped attempt preparation, and cancellation, plus the credential provider, worker capability errors, and adapter-neutral request types. Each prepared attempt runs its Pi parent in this process as a durable task, tells it where the worker runs children (local processes, SSH on an exe.dev VM or any Linux machine, or a Cloudflare sandbox), and releases its resources at completion or when its scope closes. [Attempt execution](https://docs.usine.dev/architecture/execution/) and [Workers and the gateway](https://docs.usine.dev/architecture/workers-and-gateway/) cover the executors.

0.x APIs can change. Supply `effect` at the workspace's pinned version.

## Attempt lifetime

Call `Executor.prepare(request)` inside `Effect.scoped`, then `prepared.launch(io)` once. The `PreparedAttempt` owns the checkout and repo access. Its `workspace`, an `AttemptWorkspace` with the worker, run spec, and worktree path, serializes without credentials or live handles.

```ts
const result = yield* Effect.scoped(
  Effect.gen(function* () {
    const prepared = yield* executor.prepare(request)
    return yield* prepared.launch(transcriptSink)
  }),
)
```

Preparation stays interruptible during clone, fetch, credential requests, and lock waits. A failed prepare releases partial acquisitions at once, and an unlaunched attempt when the scope closes. Launch finishes cleanup before it returns on success, failure, or interruption, and closing the owner scope stops a launch in another fiber. Each attempt launches at most once. Cleanup failures are logged and never make a successful result retryable.

`CheckoutRequest.maxAttemptMinutes` bounds live execution, excluding preparation and cleanup. Both runaway ceilings are optional: an absent one leaves that half of the guard off, and an armed one steers the parent once at 80%. The clock starts once launch registers the session. The guard delivers its warning apart from its checks, once an `execute` relays the parent's channel (`AttemptRuntime.attached`): no trip waits for delivery, and the append that reaches the token warning returns before the steer is delivered, since the durable runtime records the steer in order with its envelopes.

`CheckoutRequest.commitAuthor` is the GitHub App's bot account. Every worker kind sets it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, and in the environment of the executor's own git commands on the checkout, which git prefers to any `user.name` and `user.email` config on the machine. On a remote worker they're exported in each command line, since they aren't secret.

`CheckoutRequest.permissions` is the loop's permission level. A `read` attempt's credential has `contents: read`, so it can't push. An exe.dev worker can't grant that, and refuses the attempt with a `credentials` `WorkerCapabilityError` before attaching the integration. A `read` checkout also gets a pre-push hook that stops `git push` with a message naming the loop, instead of GitHub's 403; `git push --no-verify` skips it, and the token still refuses. A `read` attempt is never salvaged.

### Salvage

An attempt that ends without success is salvaged before its worktree is removed: uncommitted changes are committed as `wip(usine): salvage attempt <id>` by `CheckoutRequest.commitAuthor`, and HEAD is pushed to `CheckoutRequest.salvageRef` with the worker's credentials. The result reaches the engine through `Sink.salvage`. A failed push keeps the worktree and reports its path and the failure: git's exit code and stderr, so a deleted remote reads differently from a revoked app, or a push stalled past two minutes. Local and SSH adapters scrub the token from that stderr; an exe.dev VM never has one. The startup sweep leaves such a worktree alone. Each later startup retries the push with fresh credentials, for open and closed runs, and rewrites the record from `Retained` to `Pushed` on success; until then the record shows the latest failure in the run drawer.

A request whose `resume` names a pushed salvage fetches the revision and applies the salvage on top. A salvage forked from the fetched commit is checked out as is; one from an older base is rebased onto it, with `commitAuthor` as the committer. A salvage with no changes beyond the revision is dropped. One that doesn't rebase cleanly is left out: the worktree starts from the revision, `RunSpec.conflictingSalvage` names it, and its branch keeps the work. A missing ref falls back to the revision.

Startup reconciliation lists each worker's `attempts/` once per executor instance, and adapters skip historical attempts missing from the listing without checking paths. A failed listing stays cached for that startup and is retried after a restart. Existing checkouts keep the record-before-remove salvage order; succeeded attempts only need removal. `recover` has no `CheckoutRequest`, so its caller passes the salvage commit's author as an effect, which runs only before a salvage: the orchestrator reads the App's bot account there.

### Cancel

`cancel(attemptId, reason)` applies from the start of preparation: harness probes, credential acquisition, repo lock waits, and checkout creation. It stops preparation before releasing acquired resources and blocks a later launch. `cancel` and the canceled `prepare` or `launch` return only after release. For a live attempt, it cancels the parent task and waits the configured grace before forcing termination. Concurrent and repeated cancels wait for cleanup and keep the launch's typed failure; after release, cancel does nothing.

This replaces the 0.x `Executor.launch(prepared, io)` and `Executor.cleanup(prepared)`; the engine's `StepExecutor` contract is unchanged.

## Worker preflight

Call `executor.preflight(worker, brains, maxConcurrentAttempts)` with the roster's `BrainSpec` values and the worker's `max_concurrent_attempts` before scheduling. It returns a `PreflightReport`, whose `degraded` gives the reason when the worker runs attempts without a capability that keeps them apart, such as an SSH worker without Docker; `fullPreflight` is the report without one.

Every adapter compares the machine's memory with `maxConcurrentAttempts`. The local adapter reads `/proc/meminfo` on Linux and physical memory on macOS, where swap grows on demand; exe.dev and SSH read `/proc/meminfo` over SSH. Under 1.5 GiB per concurrent attempt, or no swap with more than one, is a `memory` `WorkerCapabilityError`; under 3 GiB logs a warning ([#270](https://github.com/basaltbytes/usine/issues/270)).

Every adapter runs the `@usine/agents/preflight` checks where children run: local on this machine (override with `LocalExecutorOptions.harnessReadiness`), exe.dev and SSH over SSH (`SshExecutorOptions.harnessReadiness`). Codex needs CLI 0.153.4 or 0.159.0 through 0.159.3 and a ChatGPT login, Claude its CLI and subscription login, and Pi children API keys for their models. Pi children run tools in the orchestrator, so exe.dev and SSH workers report Pi brains unavailable.

`prepare` repeats the assigned brain's probe before acquiring credentials or a checkout, to catch roster changes and logouts. A capability gap returns `WorkerCapabilityError`, which needs the operator. Transport failures, such as an SSH client that can't reach the VM, and probe timeouts are retryable infrastructure failures.

A Claude check holds the worker's `ClaudeLoginLock` (`@usine/agents/runtime`) until it returns, so two preparing attempts, or a preparing attempt and a starting Claude child, never refresh the login at once. On a provisioned worker, each machine has its own login and lock, so attempts on different machines don't wait for each other. The local, exe.dev, and SSH layers need that service: build `claudeLoginLockLayer` from the root once and give it to the executor and the attempt runtime.

It replaces exe.dev's `HarnessLoginCheck` and `harnessLoginChecks` options.

## Local worker

For each attempt, `@usine/executor/local`:

- checks Git and the assigned harness before accepting work;
- updates a per-repo bare cache, then creates a detached worktree at the resolved revision;
- renews repo credentials before expiry. Git reads an attempt token file and `gh` its private `GH_CONFIG_DIR` on each call, so a salvage push after hours uses the latest credential; startup reconciliation issues a fresh one;
- runs the Pi parent here through `AttemptRuntime` (`@usine/durable`) with the attempt's environment: allowlisted variables, credential settings, `TURBO_CACHE_DIR`, and the request's `commitAuthor` as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, never the orchestrator's environment;
- harvests commits and pull requests from the worktree, and the attempt's comments and reviews on the item, with `@usine/core/step/harvest`, running `git` and `gh` in that environment. A failed or canceled attempt (unless this process stopped) gets only its comments harvested, after its parent task stops, through `Sink.comments`. `Sink.windows` reads the attempt windows after GitHub lists the comments, and the harvest keeps comments by the window rule of `@usine/core` (#429). If the windows can't be read, a finished attempt's harvest fails and a failed attempt records no comment;
- cancels the parent task before forced interruption, then removes the worktree and wipes the credential.

`TURBO_CACHE_DIR` is `.usine/workers/<worker>/turbo`. Startup cache sweeps prune only the `*.git` directories the adapter creates under `repos/`, skip and log anything else at debug, and end with an info log of pruned, skipped, and failed counts.

The local layer needs Effect `FileSystem`, `Path`, and `ChildProcessSpawner`, a `CredentialProvider`, and an `AttemptRuntime`.

### Restarts

If the orchestrator stops during an attempt, the parent task stays live in durable storage and the worktree on disk. After a restart, `isLive` lets the engine reattach, and `prepare` with `reattach` takes over the worktree with fresh credentials, reading the run spec and base commit from `AttemptRuntime.request`. A parent that reported success before its harvest also counts as live, so the reattachment harvests it.

The reattached launch resumes its runaway guard (#178) from `Sink.transcript`: each session's highest token report, finished children included; the parent's hold, if still placed; and the warnings already sent, which aren't resent. The guard checks the restored total at start, so a total past a lowered ceiling trips at once. A warning that the restored totals owe waits until `execute` relays the parent's channel.

Unsupervised time comes from `AttemptRuntime.unsupervised`. A wall-clock guard records it every 30 seconds while it grows and once when it stops, within a five-second grace. Only a running guard counts: quiet time before a restart counts, downtime doesn't. Each unclean stop loses at most the last 30 seconds, so a crash lets an attempt run that much past its ceiling.

A reattachment reads only what its armed ceilings use: the transcript for either, the unsupervised time for the clock. If one can't be read after the store's retries, the guard doesn't start over with a new allowance. The durable session cancels the parent task, the launch salvages the worktree through `Sink.salvage`, and the attempt fails with an `InfraFailure` naming what couldn't be read, so the next attempt starts from the salvage.

After the harvest, the result is recorded in durable storage before the worktree is released, and `outcome` returns it, or the parent's failure, to an engine that stopped before recording the attempt. If storage has the parent's failure, `recover` first records the open attempt's comments, harvested in its worktree with a fresh credential, through the `RecoverySink`'s `comments`, filtered by the windows that its `windows` reads after GitHub lists them. A missing worktree or credential, or unreadable windows, is logged and records none.

Every other end, whether failure, cancel, or tripped ceiling, cancels the parent task. The engine calls `recover` only for attempts that no run reattaches, so `recover` cancels a live parent task first and reconciles the worktree even if `isLive` still reports the attempt, as for an unharvested report. If the stop can't be confirmed (liveness unreadable, or the cancel fails or outlasts the interrupt grace), `recover` and `cancel` fail with a `cancel` `ExecutorOperationError`, and `recover` leaves the worktree, which the task might still write. A launch whose stop isn't confirmed also leaves the worktree, without salvage; the next `cancel` that confirms the stop salvages and removes it as `recover` does, and logs a failure without failing (#523). `cancel` logs the engine's reason for the stop: `cancel`, `failed`, or `startup`.

## exe.dev worker

`@usine/executor/exe-dev` runs the same contract on a persistent exe.dev VM whose name is the worker name. Its image must already have Git, the roster's `claude` and `codex` CLIs, and every coding-agent login the instance uses.

Preflight creates no checkouts or grants. It reads VM metadata with `ssh exe.dev ls --json`, checks Git and memory over SSH, probes the roster on the VM, and asks exe.dev to test each GitHub integration.

Prepare attaches the repo's integration to the VM with a bounded `--for` grant, fetches a bare cached clone from `github.int.exe.xyz`, and creates a detached worktree. Launch runs the Pi parent here through `AttemptRuntime` with a `RemoteShell` host: each Claude Code or Codex child is one SSH command that enters the worktree, exports `GH_HOST=github.int.exe.xyz` over the VM's environment, and runs the harness. Harvesting runs `git` and `gh` the same way. Cleanup removes the worktree, prunes its cache registration, and detaches the integration after the last concurrent attempt that uses it.

An exited SSH client doesn't prove its remote command stopped, so each remote child writes its pid to `<worktree>.child-<n>.pid`. Before a workspace is removed or kept, cleanup stops every recorded child on the VM and confirms it's dead; cancel, recovery, and reattach do the same.

After a restart, `prepare` with `reattach` checks that the stored request names this worktree and that it still exists on the VM, stops leftover children, and takes it over with a fresh grant. If the VM or worktree is gone, the reattachment fails and cancels the parent task, and the engine retries with a new attempt.

Startup reconciles unsuccessful attempts before the engine recovers their runs: each checkout is snapshotted and pushed, and its salvage recorded, before removal. Failed pushes and unknown crash leftovers stay on disk. Cache sweeps prune registrations of missing directories and never delete checkouts. One-shot lobby and SSH commands time out after ten minutes, and the SSH client sends keepalives, so a dead link fails the operation.

Concurrent attempts on different repos keep their integrations attached together. Each grant renews at half its lifetime while its attempt runs, a failed renewal retries every minute, and the refcounted release detaches an integration after its last attempt. The grant length, `credentialGrantMinutes` (65 by default), is a renewal window, unrelated to `max_attempt_minutes`; an attempt without a ceiling keeps its grant for its whole life. A failed detach is logged and lapses with its time-box. If stopping the remote children can't be confirmed, cleanup keeps the checkout and its Git registration, logs the location, and still releases the grant. Partial preparation rolls back without stopping children, since none started.

The exe.dev layer needs a `ChildProcessSpawner` and an `AttemptRuntime`.

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

The integration keeps the GitHub credential at exe.dev's network edge: no GitHub token enters the run spec, the durable request, the local SSH environment, or the VM. Pushes from this worker use `exe-dev-github-integration[bot]`; agent-authored PRs and comments should carry the run's agent signature.

Salvage inspection, staging, or snapshot failures keep the checkout, uncommitted files included. Restart recovery uses fresh credentials and records the recovered ref before releasing the worktree.

## SSH worker

`@usine/executor/ssh` runs the same contract on any Linux machine that the orchestrator reaches over SSH ([ADR 0026](../../docs/adr/0026-eu-ssh-worker.md)); `infra/hetzner` creates one on Hetzner Cloud. Each worker has an SSH destination, an optional identity file and port, and a root under which it keeps `workers/<name>/repos`, `attempts`, and `credentials`. The machine needs Git, Docker, and the roster's harness logins for the SSH user.

Preflight checks the SSH connection, a writable root, Git, memory for `maxConcurrentAttempts`, Docker, and the roster's harnesses where children run. With Docker, it pulls the attempt image, checks that the image's user has the SSH user's ID, and probes the harnesses in a container from the image that removes itself. Without Docker, it probes them over SSH and reports the worker as degraded. A Docker that doesn't answer the SSH user, the `docker` group or a writable socket without the `docker` CLI, an image that can't be pulled and isn't on the machine, or another user ID is a `container` `WorkerCapabilityError`: an SSH user that can use Docker never runs an attempt.

### Attempt containers

With Docker on the machine, each attempt runs in its own container from `SshWorkerAddress.container.image`, or `ATTEMPT_IMAGE`, the image of `infra/worker-image/Dockerfile` with this release's harness versions, with the address's CPU, memory, and process limits. The container mounts only the attempt's checkout and the SSH user's login files for the attempt's harness read-write, and its cached clone and credential directory read-only; behind a gateway, also gh's configuration directory and socket read-only. It uses the machine's network, and gets the attempt's variables, secrets included, on `docker run`'s standard input. Every command for the attempt runs in it through the shell's `container` (`docker exec -i <name> sh -c <command line>`): the children, the checkout's git, the harvest, the salvage, the pre-push hook, and the attempt's harness probe, which runs once the checkout exists. Only the container's start and removal and the cached clone's fetch run as the SSH user.

The checkout is a repository of its own whose objects come from the cached clone through an alternate, so commits never write the read-only clone. The container is named `usine-<attempt id>` and labeled with `SshExecutorOptions.instance`, `SshExecutorOptions.instanceId`, the worker, and the attempt. It's removed after the checkout's release, which salvages in it, and before the credential. If the container stopped before the release, for example because the kernel killed it for memory or a command signaled its init, the release starts it again and salvages in it, and logs the container's status, exit code, and whether it was killed for memory. The salvage never runs git in the checkout as the SSH user. A process's first use of a worker removes the containers with both its instance labels that belong to that worker, or to a worker that started no container in this process, so a running attempt's container on a shared machine stays. Instances that share a GitHub App, and so `instance`, have different `instanceId`s, so they don't remove each other's containers. Before its first container starts, the executor writes `<root>/workers/<name>/container-checkouts/<attempt>`, outside every container's mounts, and removes it with the checkout. A reattachment or recovery reads that marker, never the checkout, which the attempt can change: with it, commands run in a new container; without it, as the SSH user, on a machine without Docker only. A mismatch, such as a checkout from before Docker on a machine that now has it, fails with an `ExecutorOperationError` and leaves the checkout.

Prepare mints the attempt's single-repo token through the `CredentialProvider`, writes it with a gh `hosts.yml` to `<root>/workers/<name>/credentials/<attempt>`, and fetches the bare cached clone from `https://github.com/<repository>.git` with git's credential helper reading that file. The token goes over the writing command's stdin, so it's in no command line, process environment, or log, and git and gh output is scrubbed of it. As on the local worker, git and harvest commands renew a token that expires within five minutes; children, harvesting, and the salvage push export the same file paths, so they read the latest token. Cleanup stops the children, removes the checkout, then the credential directory. A process's first use of a worker, for an attempt or startup reconciliation, removes credentials an earlier process left; a reattached attempt gets a fresh one.

Children, pid files, the kill script, sweeps, salvage, recovery, and reattachment share the exe.dev worker's code; in a container, the pid files and the kill script are inside it.

### Behind a gateway

A worker whose address has a `gateway` is on a private network behind a gateway ([ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md)), with no GitHub token on its machine. Prepare mints the same token, attaches it through the gateway's admin API for the worker and repo (`POST /v1/attachments` with the expiry), and keeps the attachment id and returned caller token. Renewal replaces the token on that attachment (`PUT /v1/attachments/<id>`) before expiry, and every two minutes the same request stores the attachment again, so a restarted gateway gets it back. Cleanup detaches after the checkout is cleaned up; a failed detach logs a warning, since the attachment expires with its token. Admin requests time out after 30 seconds. A process's first use of a worker detaches each attachment the gateway has for it, one by one, so a reattached attempt attaches again with a new caller token.

The cached clone fetches `http://git.<domain>/<repository>.git`. Children, harvesting, and the executor's git commands export settings that point git, gh, and package managers at the gateway: git sends the caller token only to `git.<domain>` and rewrites `https://github.com/` there, gh uses `git.<domain>` through the worker's socket with its config in `<root>/workers/<name>/gh`, and `HTTPS_PROXY` is the forward proxy.

If the gateway has the Anthropic credential, Claude Code calls `llm.<domain>/anthropic`, and preflight checks only its binary. If it has the OpenAI credential, prepare writes Codex's `config.toml` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, children get that directory as `CODEX_HOME`, and Codex sends the Responses API to `llm.<domain>/openai/v1` with the caller token from `USINE_GATEWAY_TOKEN`; preflight checks only its binary and version. The file has a `model_provider` and no token. Codex also writes its sessions there, so an attempt's container mounts the directory read-write, and cleanup removes it after the container. Otherwise each harness uses the operator's login on the machine through the forward proxy: preflight checks the login as without a gateway, then that each of the login's hosts answers HTTP through the proxy (`api.anthropic.com` and `platform.claude.com`, or `chatgpt.com` and `auth.openai.com`). A refused host is a `gateway` capability error naming the host to add to the egress allowlist. The caller token is in no command line: each SSH command sends `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, and `USINE_GATEWAY_TOKEN` from the client's environment (`SendEnv`), and the machine's sshd must accept them (`AcceptEnv`). With Docker, only the cached clone's fetch sends them; the attempt's container gets them when it starts.

The admin API listens on the gateway's loopback. With the first worker behind a gateway, the executor opens its own forward, `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<adminPort> <destination>`, with the same SSH command and environment as its other clients, on a local port the kernel picks; workers behind that gateway share it. When the client exits, the executor starts another after a pause of one second, doubling up to one minute, and logs each open, exit, and reopen with the gateway's destination. An admin request that finds the forward closed, or gets no answer, reopens it at once and is sent once more. A second failure fails the request, with a message giving since when the forward has been closed, or, if it opens but the admin API doesn't answer, since when the API last answered through it. The forward closes when the last worker behind the gateway is removed, or with the layer.

Preflight also checks, without attaching, that the forward opens (giving the `ssh` command to run if it doesn't), that the admin API accepts the admin token, that sshd accepts the caller token variables, and that the machine reaches `git.<domain>`, which refuses requests without a caller token. A gap is a `gateway` `WorkerCapabilityError`.

If the worker's `llmProviders` lists a provider, preflight also reads the gateway's credential kinds (`GET /v1/providers`) and records them with the worker, and logs each provider's mode in `SSH Worker Gateway verified`: `gateway-api-key`, `gateway-subscription`, or `worker-login`. A gateway without a listed provider's credential is a `gateway` capability error, and so is one too old to report its credentials while `llmProviders` lists `openai`. Each child reads its provider's recorded kind as `AttemptRequest.gatewayCredential` when it starts: Anthropic's for Claude Code, OpenAI's for Codex, none for Pi. Its session records the credential, and usage counts a child on the gateway's API key in the API keys pool, and on a subscription in the Claude or ChatGPT plan pool ([ADR 0013](../../docs/adr/0013-cost-accounting-native-meters-guardrails.md)).

A gateway released before that endpoint answers 404: the worker's first such preflight logs `SSH Worker's Gateway does not report the kind of its Anthropic credential` at warning level, later ones at debug, and its Claude Code children count in the Claude plan pool. Each preflight asks again, so the first one after an upgrade records the kind. A gateway reload that changes the credential reaches the record at the worker's next preflight: at orchestrator start, or when a configuration reload adds the worker, gives it more slots, or adds a brain. A running attempt's next Claude Code child records the new kind; earlier children keep theirs. Local and exe.dev workers have no gateway, so their children record none.

### Provisioned machines

A worker whose address has `machine: { _tag: "Provisioned" }` has no machine of its own: it creates a Hetzner Cloud server or a Boat sandbox for each attempt and deletes it afterwards ([#550](https://github.com/basaltbytes/usine/issues/550)). The layer provides `WorkerMachines` for the scheduler:

- `create(worker, runId, brains)` creates the machine, tagged with `SshExecutorOptions.instance`, the worker, the run, and a random value of this process, and waits up to `machineReadyTimeout` (10 minutes by default) until it answers over SSH. It then waits for cloud-init, creates the root, and waits for Docker. The worker's first machine each day, and its first after the layer starts, also gets the machine preflight with `brains`, whose failure is a `WorkerCapabilityError`. A provider's refusal, no capacity or quota, no answer, or a timeout is a `MachineUnavailableError` with its `reason`. On failure or interruption, the machine is deleted.
- `assign(hold, attemptId)` tags the machine with a hash of the attempt ID; `prepare` uses it from then on.
- `adopt(worker, attemptId)` holds the machine of an attempt from an earlier process, found by that tag in one listing per worker. If the provider can't be read, the hold still keeps `sweep` from deleting the machine, and the next use looks it up again.
- `release(hold)` deletes the machine, unless it has the attempt's checkout: one kept for a reattachment, until its parent task's stop is confirmed, or with unpreserved work. That machine stays for the next process. A failed deletion is retried by `sweep`.
- `sweep` lists each provisioned worker's machines and deletes those that no hold or creation of this process has. The engine runs it after startup recovery and at each reconcile.

`recover` finds an earlier attempt's machine by its tag, reconciles the checkout there, and deletes the machine unless the checkout stays.

A Hetzner server is created from `image` with the project's SSH key, in `network` and with no public address behind a gateway, which the executor jumps through with `ssh -J <gateway.destination>`; without a gateway it has a public IPv4 address and `firewall`. Its `user_data` sets an Ed25519 host key that the executor generates for it. A Boat sandbox is created with `noEnv`, without snapshots or monitoring, and without automatic stop, and gets `<identity_file>.pub` through `POST /sandboxes/{id}/sshkey`, which returns its host key; a sandbox without one fails its creation. The executor writes each machine's host key to a file under `knownHostsDirectory` before the first connection, and connects with `StrictHostKeyChecking=yes`. A machine of an earlier process without a file there gets no connection. Boat has no labels, so the sandbox name carries the tags.

Preflight of a provisioned worker creates no machine: it checks the provider token, the image, SSH key, network, and firewall or the account's limits, the gateway's admin API, and that each harness has a credential outside the machine: Claude Code needs `anthropic` in the gateway's `llmProviders` or `apiKeys.anthropic`, which each attempt gets as `ANTHROPIC_API_KEY`; Codex needs `openai` there or `apiKeys.openai`, which each attempt gets as `OPENAI_API_KEY` with a `CODEX_HOME` whose `config.toml` reads it; and Pi is refused. Its report's `deferred` says that the harnesses are checked on the first machine each day.

The SSH layer needs a `ChildProcessSpawner`, a `CredentialProvider`, an `AttemptRuntime`, an `HttpClient` for admin and provider APIs, and a `FileSystem` and `Path` for host key and public key files. It provides `SshWorkers` and `WorkerMachines` beside the `Executor`, starting with the workers of `workers`. `addWorker(address)` adds a worker at runtime; behind a gateway, the worker shares that gateway's forward, or opens one if it's the first. `removeWorker(name)` removes a worker once no attempt runs on it, and closes its gateway's forward if no other worker uses it. Adding a worker the executor has with the same address changes nothing; with another address, it fails with a `machine` capability error until the worker is removed.

```ts
import { InstanceId } from "@usine/core/instance"
import {
  ContainerCpus,
  ContainerMemoryMib,
  ContainerPids,
  SshDestination,
  SshIdentityFile,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker"
import { layer } from "@usine/executor/ssh"
import { Option } from "effect"

const executorLayer = layer({
  instance: "github-app-123456",
  instanceId: InstanceId.make("0b4e7f3c-5a2d-4c1e-9f6b-8d7a2e1c3b4f"),
  workers: [
    {
      name: WorkerName.make("eu-one"),
      machine: { _tag: "Fixed", destination: SshDestination.make("usine@203.0.113.7") },
      identityFile: Option.some(SshIdentityFile.make("~/.ssh/usine_worker")),
      port: Option.none(),
      root: WorkerRoot.make("/home/usine/.usine"),
      gateway: Option.none(),
      container: {
        image: Option.none(),
        cpus: ContainerCpus.make(2),
        memoryMib: ContainerMemoryMib.make(4096),
        pids: ContainerPids.make(4096),
      },
    },
  ],
})
```

## Cloudflare worker

`@usine/executor/cloudflare` runs the same contract in Cloudflare sandboxes, through the Worker that the operator deploys from `@usine/cloudflare` ([#551](https://github.com/basaltbytes/usine/issues/551)). Each worker address has the Worker's origin, the Cloudflare Access service token, the image name, the instance type, and the provider API keys. The executor calls the Worker's sandbox API with `HttpApiClient` and the token's headers; a request fails with `SandboxRequestError`, whose message contains no credential.

Each attempt gets its own sandbox, named `<instance>.<worker>.<attempt>`, where `CloudflareExecutorOptions.instance` identifies the usine instance, so that instances that share a deployed Worker never use or remove each other's sandboxes. Prepare creates it without credentials and runs the assigned harness's version probe in it, as preflight does, so an unsupported Codex fails with a `WorkerCapabilityError` before any token is issued. Then it gives the sandbox the attempt's installation token and the provider keys, which only the Worker's outbound handlers hold, and clones and checks out under `/home/usine/workspace` in the sandbox. Renewal publishes a new token to the sandbox before each expiry. Each credential change carries the time the executor issued it, later than the change before even if the clock goes back, and the Worker refuses credentials older than the ones the sandbox holds, so a renewal that's still on its way can't undo the revocation that follows it. Every child, git, gh, and probe command runs through the sandbox shell, `cloudflare/shell/shell.js`: a stand-in for `ssh` that the executor gives `RemoteShell` as its SSH command. It opens the Worker's exec WebSocket, relays stdin, stdout, and stderr, and exits with the command's exit code, or 255 if it can't reach the sandbox. If the stream drops after the command started, it attaches to the command's process files from the bytes it already wrote, up to five times. The Worker's origin and the token reach it in its environment, never in its arguments.

Cleanup stops every command in the sandbox, with the processes that the commands left running (`POST .../stop`), salvages and removes the checkout, and destroys the sandbox. A checkout kept for reattachment, or with unpushed work, keeps its sandbox: the executor holds it (`POST .../hold`), so the Worker keeps its container running until usine reconciles or destroys it, and replaces its credentials with none, so its handlers refuse GitHub and every provider. A reattached attempt reads its stored request, checks that its checkout exists in the running sandbox, stops the commands left from before the restart, and publishes a new token. If the reattachment fails after that check, for example because no token can be issued, the executor holds the sandbox with its checkout, and the engine's `recover` salvages it. A process's first use of a worker lists the Worker's sandboxes for this instance and worker, and destroys each one that no attempt of this process uses and that holds no checkout; one with a checkout stays for `recover`.

While an attempt runs, the executor asks the Worker every 30 seconds (`CloudflareExecutorOptions.drainPollInterval`) whether the platform sent the sandbox's container SIGTERM, which it does up to 15 minutes before it stops the container. If it did, the executor drains the attempt through the durable session: the attempt fails with a retryable `InfraFailure`, and its release salvages the checkout and destroys the sandbox, so the next attempt resumes from the salvage on a new sandbox.

Preflight calls `GET /v1/health`, checks that the Worker has the image, that the worker has an API key for each harness in the roster (`anthropic` for Claude Code, `openai` for Codex; Pi can't run), and runs `claude --version` and `codex --version` in a preflight sandbox that it destroys afterwards. A refused token is a `credentials` capability error, a missing image a `toolchain` one, and a missing key a `harness-login` one. Each child's `gatewayCredential` is `api-key` when the worker holds its harness's key, so usage counts it in the API keys pool.

The Cloudflare layer needs a `ChildProcessSpawner`, a `CredentialProvider`, an `AttemptRuntime`, a `ClaudeLoginLock`, and an `HttpClient` for the sandbox API.

```ts
import { CloudflareImageName, WorkerName } from "@usine/core/worker"
import { layer } from "@usine/executor/cloudflare"
import { Redacted } from "effect"

const executorLayer = layer({
  instance: "github-app-123",
  workers: [
    {
      name: WorkerName.make("cf-one"),
      workerUrl: new URL("https://usine-sandboxes.acme.workers.dev"),
      accessClientId: Redacted.make(process.env.USINE_CF_ACCESS_CLIENT_ID ?? ""),
      accessClientSecret: Redacted.make(process.env.USINE_CF_ACCESS_CLIENT_SECRET ?? ""),
      image: CloudflareImageName.make("usine"),
      instanceType: "standard-4",
      providers: [
        { provider: "anthropic", apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? "") },
      ],
    },
  ],
})
```
