# @usine/executor

Worker execution for [usine](https://github.com/basaltbytes/usine). The platform-free package root defines five operations: preflight, prepare, launch, cancel, and cleanup. It also owns the credential provider, Worker capability errors, and adapter-neutral request types.

## Local Worker

The Node adapter at `@usine/executor/local` does the following for each Attempt:

- checks Git and the installed run-host protocol without changing worker state;
- updates a per-repository bare cache, then creates a detached worktree at the resolved revision;
- mints one repository credential and passes it only through the child process environment;
- exchanges protocol-v1 envelopes with `@usine/run-host` over newline-delimited standard input and output;
- interrupts cooperatively before a hard kill, then removes the worktree and wipes the credential.

`LocalExecutorOptions.runHost` can override the child command for another compatible host. The adapter otherwise launches the executable shipped by `@usine/run-host` and rejects a protocol-version mismatch during preflight.

The local layer requires Effect `FileSystem`, `Path`, and `ChildProcessSpawner` services plus a `CredentialProvider`. Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

## exe.dev Worker

`@usine/executor/exe-dev` runs the same contract on a persistent exe.dev VM. The configured Worker name must match the VM name. The VM image must already contain Git, Node.js 22 or later, the compatible `usine-run-host` executable, and every coding-agent login used by the instance.

Preflight changes no remote state. It reads VM metadata through `ssh exe.dev ls --json`, checks Git and Node.js over SSH, compares the run-host protocol version, runs the configured harness login checks, and asks exe.dev to test each native GitHub integration.

Prepare attaches the repository's integration to the VM with a bounded `--for` grant. It then fetches a bare cached clone from `github.int.exe.xyz` and creates a detached worktree for the Attempt. Launch keeps one SSH process open and carries the protocol-v1 frames on that process's standard input and output. Cleanup removes the worktree, prunes its cache registration, and detaches the integration after the last concurrent Attempt using it finishes.

The first prepare on each VM after orchestrator startup sweeps abandoned Attempt worktrees and prunes cached worktree registrations left by a crash. One-shot lobby and SSH commands carry a ten-minute timeout. Cancellation also bounds interrupt persistence and delivery before escalating to a hard kill, so a parked store or remote process cannot stall shutdown.

```ts
import { Repository } from "@usine/core"
import {
  GitHubIntegration,
  HarnessLoginCheck,
  IntegrationName,
  layer,
} from "@usine/executor/exe-dev"

const executorLayer = layer({
  githubIntegrations: [
    new GitHubIntegration({
      repository: Repository.Name.make("acme/widget"),
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
