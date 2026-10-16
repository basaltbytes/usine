This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.

# usine architecture

usine is one long-running Node process, the orchestrator, that watches the GitHub issues and pull requests of the repositories an operator registers. When an issue or pull request matches a Loop, the orchestrator opens a Run and has a coding agent work on it. Loops and Agents are Markdown files in the operator's instance folder, and the engine contains no built-in Loop. The operator follows the work, approves it, and steers it in a web UI that the same process serves on `127.0.0.1`.

Each try of a Run is an Attempt. The Attempt's Pi parent runs inside the orchestrator as a pi-durable task and delegates the coding to Claude Code, Codex, or Pi children. The children run on a Worker: the orchestrator's own machine, or a Linux machine the orchestrator connects to over SSH. An SSH Worker can be on a private network behind a Gateway VM, which adds the GitHub token to the Worker's requests so that no token is on the Worker. [`CONTEXT.md`](../../CONTEXT.md) defines the vocabulary, and [`docs/adr/`](../adr) records why the design is what it is.

## The system in one picture

```
  browser: apps/web
      | HTTP 127.0.0.1:7331 (/api/* and the built web assets)
      v
+---------------------------------------------------------------+
| orchestrator process: `usine up` (apps/server)                |
| working directory: the instance folder                        |
|                                                               |
|  Operator API ......... orchestrator/src/operator             |
|  PollingTriggers ...... orchestrator/src/polling              |
|  ScheduleTriggers ..... orchestrator/src/schedule-triggers.ts |
|        | RunEngine.submit(Submission)                         |
|        v                                                      |
|  RunEngine ............ engine, one fiber per open Run        |
|    RunStore ---------> .usine/runtime.sqlite                  |
|  StepExecutor ......... orchestrator/src/scheduler.ts         |
|  Executor ............. executor: local, ssh, exe.dev         |
|  AttemptRuntime ....... durable: Pi parent, `subagent` tool   |
|    pi-durable -------> .usine/durable.sqlite                  |
|  child backends ....... agents: Claude Code, Codex, Pi        |
+-----+------------------+------------------+--------------+----+
      |                  |                  |              |
      | local            | SSH, one         | SSH through  | polls (REST and
      | processes        | command per      | the Gateway  | GraphQL), label
      |                  | child            | (ssh -J)     | writes, token
      v                  v                  v              | minting
+------------+   +----------------+   +---------------+    |
| local      |   | SSH Worker     |   | SSH Worker    |    |
| Worker     |   | without a      |   | behind a      |    |
| .usine/    |   | Gateway: token |   | Gateway: no   |    |
| workers/   |   | file per       |   | token, caller |    |
|            |   | Attempt        |   | token sent    |    |
|            |   |                |   | with SendEnv  |    |
+-----+------+   +-------+--------+   +-------+-------+    |
      |                  |                    | private    |
      |                  |                    v network    |
      |                  |            +---------------+    |
      |                  |            | Gateway VM    |    |
      |                  |            | :80 git, llm  |    |
      |                  |            | :3128 proxy   |    |
      |                  |            | :7070 admin   |    |
      |                  |            +-------+-------+    |
      | git and gh with the Attempt's         | adds the   |
      | one-repository token                  | token      |
      v                  v                    v            v
+---------------------------------------------------------------+
| GitHub: github.com, api.github.com, uploads.github.com        |
+---------------------------------------------------------------+
```

Three paths are left out of the picture. The executor calls the Gateway's admin API on `127.0.0.1:7070` through an SSH local forward that the operator keeps open. The Gateway's `llm.<domain>` host forwards to Anthropic or OpenAI when the Gateway has that provider's key. The forward proxy on port 3128 opens tunnels to package hosts and to the hosts of the harness logins. [`workers-and-gateway.md`](workers-and-gateway.md) describes each path.

The run host of ADR 0006 no longer exists. The `@usine/run-host` package and its byte protocol were deleted in #176 ([ADR 0006](../adr/0006-executor-contract-run-host-attempt-channel.md), amendment of 2026-10-11), so no usine package is installed on a Worker. The Attempt channel envelopes remain as the transcript format.

## Packages and apps

The last column lists workspace dependencies only. `effect` is a peer dependency of every published library and a direct dependency of the two apps.

| Package | Responsibility | Public subpaths | Depends on |
| --- | --- | --- | --- |
| `@usine/core` 0.3.0, `packages/core` | Domain model: Event, Run and its state machine, Step, Attempt, failures, salvage, the Attempt channel envelopes, Worker and repository identities. | `/agent`, `/agent/brain`, `/agent/capability`, `/agent/session`, `/attempt`, `/attempt/channel`, `/attempt/failure`, `/attempt/outcome`, `/attempt/salvage`, `/cycle-budget`, `/event`, `/instance`, `/item`, `/loop`, `/repository`, `/run`, `/run/state`, `/step`, `/step/harvest`, `/step/result`, `/worker` | none |
| `@usine/expression` 0.2.0, `packages/expression` | Checks and evaluates CEL expressions with `@marcbachmann/cel-js` 8.0.0. | `/expression-engine`, `/marcbachmann-cel` | none |
| `@usine/config` 0.2.1, `packages/config` | Parses and validates `usine.yaml`, Loop files, and Agent files, and loads an instance folder with per-file quarantine. Contains a YAML writer that no production code calls. | `/agent`, `/board`, `/factory`, `/file`, `/instance`, `/instance-folder`, `/label`, `/loop`, `/parser`, `/payload-slices`, `/selector`, `/trigger`, `/yaml/writer` | core, expression |
| `@usine/github` 0.1.2, `packages/github` | GitHub App authentication and token minting, change detection, GraphQL payload slices, label writes. | `/github-app`, `/item-writer`, `/label-writer`, `/local-secrets`, `/polling` | core |
| `@usine/engine` 0.3.0, `packages/engine` | Event ledger, the claim of a Run for each Event, supersede and revoke, one fiber per open Run, cycle budgets, Attempt admission and drain, the SQLite store. | `/cursor`, `/cycle-budget`, `/database`, `/engine`, `/item-projection`, `/local-sqlite`, `/loop-control`, `/repository-label-projection`, `/run-reader`, `/step-executor`, `/transcript`, `/trigger-condition` | core |
| `@usine/agents` 0.3.0, `packages/agents` | The Claude Code, Codex, and Pi child backends, where children run (`ChildHost`), prompt assembly, harness preflight. | `/child-host`, `/children`, `/claude`, `/codex`, `/pi`, `/pi/authentication`, `/preflight`, `/prompt`, `/runtime` | core |
| `@usine/durable` 0.0.0, `packages/durable` | Runs each Attempt's Pi parent as a pi-durable task in the orchestrator, relays its activity as envelopes, resumes it after a restart. | `/attempt-runtime`, `/backup`, `/harness`, `/live`, `/testing` | agents, core |
| `@usine/executor` 0.2.1, `packages/executor` | The Worker contract for local, SSH, and exe.dev Workers: preflight, checkout, credentials, launch, cancel, interventions, salvage, harvest, recovery. | `.`, `/local`, `/ssh`, `/exe-dev` | agents, core, durable, gateway |
| `@usine/gateway` 0.0.0, `packages/gateway` | The Gateway service: reverse proxy for GitHub and LLM providers, forward proxy with an allowlist, admin API for attachments. Binary `usine-gateway`. | `.`, `/admin`, `/node` | core |
| `@usine/orchestrator` 0.2.1, `packages/orchestrator` | The composition: polling and schedule triggers, Worker scheduling, the operator service and its HTTP contract, the Board projection, the runtime layer. | `/board/projection`, `/credentials`, `/exe-dev`, `/idle-triggers`, `/label-reconciler`, `/local`, `/operator`, `/operator/http`, `/orchestrator`, `/polling-triggers`, `/runtime`, `/schedule-triggers`, `/scheduler`, `/ssh` | config, core, durable, engine, executor, expression, github |
| `@usine/server` 0.2.1, `apps/server` | The `usine` CLI (`up`, `backup`, `export-run`); serves the operator API and the web build. | none, binary `usine` | config, core, durable, engine, expression, github, orchestrator |
| `@usine/web`, `apps/web`, private | The React web UI: projects, Boards, the Run drawer, Loop pause controls. | none | core, orchestrator |

`packages/run-host` does not exist at this commit.

## How one change moves through the tree

1. `usine up` (`apps/server/src/up.ts:104`) loads the instance folder and the GitHub App credentials, then builds `runtimeLayer` (`packages/orchestrator/src/runtime.ts:37`).
2. `PollingTriggers` and `ScheduleTriggers` turn GitHub state and clock ticks into `Submission`s and call `RunEngine.submit` (`packages/engine/src/engine/engine.ts:52`).
3. The engine records the Event, opens or queues a Run, and starts the Run's fiber (`packages/engine/src/engine/run-driver.ts:341`).
4. The fiber reserves a Worker slot from `StepExecutor` (`packages/orchestrator/src/scheduler.ts:131`) and calls `Executor.prepare`, then `launch`.
5. The executor prepares a checkout on the Worker and passes the Attempt to `AttemptRuntime.execute` (`packages/executor/src/durable-session.ts:120`).
6. The Pi parent delegates to children with its `subagent` tool. Their activity comes back as envelopes, which the engine appends to the transcript.
7. When the parent finishes, the executor harvests commits and pull requests from the checkout, and the engine closes the Attempt and the Run.

## Pages in this folder

| Page | Contents |
| --- | --- |
| [`run-lifecycle.md`](run-lifecycle.md) | Polling and content-hashed Events, Run and Attempt states, approval, retry, cancel, revoke, cycle budgets, drain, one Run from trigger to pull request. |
| [`execution.md`](execution.md) | How an Attempt runs: the executor contract, the durable layer, the live channel for interventions, transcripts, the three harnesses. |
| [`workers-and-gateway.md`](workers-and-gateway.md) | Worker kinds in `usine.yaml`, preflight, the Hetzner Gateway VM, how credentials move, cloud-init. |
| [`storage-and-config.md`](storage-and-config.md) | The SQLite runtime store and its tables, the durable storage, `usine.yaml`, Loop and Agent files, files on disk. |
| [`operator-surfaces.md`](operator-surfaces.md) | Every HTTP endpoint, the web UI pages, the CLI, logs and spans. |
| [`loops-shipped.md`](loops-shipped.md) | The five Loops and three Agents of the dogfood instance, with their labels. |
| [`gaps.md`](gaps.md) | What the code does not do yet, grouped by area, with the open issues. |
