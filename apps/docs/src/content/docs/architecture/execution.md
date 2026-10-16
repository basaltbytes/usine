---
title: "How an Attempt runs"
description: "The executor contract, the durable layer, the live channel for interventions, transcripts, the three harnesses."
sidebar:
  order: 2
---

:::note
This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.
:::
An Attempt passes through six layers. All of them run inside the orchestrator process except the children, and the table lists them from the engine down.

| Layer | Code | Does |
| --- | --- | --- |
| Run fiber | `packages/engine/src/engine/run-driver.ts:288` | Starts or reattaches the Attempt, gives the executor a transcript sink, records the outcome. |
| `StepExecutor` | `packages/orchestrator/src/scheduler.ts:163` | Builds a `CheckoutRequest` from the Run and the settings, then calls `prepare` and `launch` in one scope. |
| `Executor` | `packages/executor/src/executor.ts:172` | Checkout, credentials, guard, salvage, harvest on one Worker kind. |
| Durable session | `packages/executor/src/durable-session.ts:73` | Shared by every Worker kind: runs the parent task, stops it, routes interventions, answers `isLive`. |
| `AttemptRuntime` | `packages/durable/src/attempt-runtime.ts:70` | The Pi parent as a pi-durable task, its `subagent` tool, the envelope relay. |
| Child backends | `packages/agents/src/pi/children.ts` | Claude Code, Codex, or Pi, on the Worker the executor chose. |

The Effect workflow and cluster modules of [ADR 0003](https://github.com/basaltbytes/usine/blob/main/docs/adr/0003-durable-execution-on-effect-workflow.md) are gone. A migration dropped their tables (`packages/engine/drizzle/20261011153856_drop_workflow_tables`), and the Run lifecycle is the fiber described in [`run-lifecycle.md`](/architecture/run-lifecycle/).

## The executor contract

`Executor` (`packages/executor/src/executor.ts:172`) is the seam of [ADR 0006](https://github.com/basaltbytes/usine/blob/main/docs/adr/0006-executor-contract-run-host-attempt-channel.md):

| Operation | Does |
| --- | --- |
| `preflight(worker, brains)` | Verifies Git and each rostered brain where the Worker runs children. Installs nothing. |
| `prepare(request)` | Needs a `Scope`. Checks the Attempt's brain again, gets repository access, creates or reattaches the checkout, and returns a `PreparedAttempt` with `workspace` and `launch(io)`. |
| `cancel(attemptId)` | Stops preparation, or cancels the live parent task, waits a grace period, then interrupts. |
| `intervene(attemptId, intervention)` | Delivers an operator action to the live session. |
| `isLive`, `outcome` | Tell a restarted engine whether to reattach an open Attempt or finish it with a stored result. |
| `recover(attempt, record)` | Salvages or removes a checkout an earlier process left. |

`CheckoutRequest` (`executor.ts:93`) has the Attempt id, Worker, repository, revision, Event payload, task text, Agent, parent model and effort, `maxChildren`, the two optional ceilings, the salvage ref, the salvage to resume from, and `reattach`. The revision is `HEAD` for issue and schedule Runs (`packages/orchestrator/src/trigger-submission.ts:17`) and the head commit for pull request Runs (`packages/orchestrator/src/polling/loop-evaluation.ts:78`).

### Preparing the checkout

`provisionWorktree` (`packages/executor/src/provision.ts:233`) is the same for every Worker kind. Under a per-repository lock it clones into a staging directory (`git clone --bare --filter=blob:none`) and renames it to the cache, or updates the cache's remote URL. Then it fetches the revision, records `FETCH_HEAD` as the base commit, fetches the previous Attempt's salvage when the request resumes one, and runs `git worktree add --detach`. The worktree is `<worker directory>/attempts/<attempt id>` and the cache is `<worker directory>/repos/<repository>`.

### Launch, guard, release

`launch` (`packages/executor/src/prepared-attempt.ts`) wraps the sink with the runaway guard (`:114`) and races the parent task against the guard's wall-clock trip. The guard (`packages/executor/src/guard.ts:139`) arms only the ceilings `usine.yaml` sets. The token meter sums the highest `SessionTokensUpdated` count per session (`guard.ts:32`). The wall clock pauses while any child is held (`guard.ts:64`). At 80% of either ceiling the guard sends the parent one `Steer` from operator `engine` (`prepared-attempt.ts:114`). A trip stops the Attempt and fails it with `RunawayFailure`.

When the parent reports success, the executor harvests the checkout with `harvestFacts` (`packages/core/src/step/harvest.ts:135`): the commits from the base commit to `HEAD`, then the pull requests whose head is the final commit, from `gh api repos/<repo>/commits/<head>/pulls`. Pull request discovery has a ten-second timeout and never fails the Attempt. `StepResult` also allows a `Comment` fact (`packages/core/src/step/result.ts:20`), but no code produces one.

Any end other than success runs `salvageWorktree` (`packages/executor/src/salvage.ts:56`) before the worktree is removed. Uncommitted changes become a `wip(usine): salvage attempt <id>` commit, and `git push --force` sends HEAD to `usine/salvage/<run>/<number>`. A failed push keeps the worktree on the Worker and records its path as `Retained`. The next Attempt of the Run checks out the newest pushed salvage ([ADR 0013](https://github.com/basaltbytes/usine/blob/main/docs/adr/0013-cost-accounting-native-meters-guardrails.md), amendment of 2026-09-18).

## The durable layer

`AttemptRuntime` (`packages/durable/src/attempt-runtime.ts:70`) runs the Pi parent as a pi-durable task called `usine.attempt` (`packages/durable/src/attempt/task.ts:46`). Its storage is `.usine/durable.sqlite` (`packages/durable/src/storage-path.ts:5`), opened by `@earendil-works/pi-durable` 1.1.0. Building the layer resumes every unfinished task (`packages/durable/src/live.ts:74`).

| Operation | Does |
| --- | --- |
| `execute(request, io)` | Creates the task, or finds it after a restart, relays its activity to `io`, and waits for the parent's report. |
| `isLive`, `finished` | Whether the task is still open, and what a finished task left: `ParentReported`, `ResultRecorded`, or `ParentFailed`. |
| `recordResult` | Stores the harvested `StepResult` with the task. |
| `request` | The stored request of a task, read for a reattachment. |
| `intervene` | Applies an operator action to the parent or a child. |
| `cancel` | Aborts children, then the parent conversation. |

The stored request contains the RunSpec, the Worker, and the worktree path (`attempt-runtime.ts:14`). The child host and the environment are not stored. Every `execute` call supplies them again, because the environment contains the Attempt's credential configuration ([ADR 0011](https://github.com/basaltbytes/usine/blob/main/docs/adr/0011-github-app-identity-scoped-worker-tokens.md)).

The parent's first turn is the prompt from `assemblePrompt` (`packages/agents/src/prompt.ts`): the repository, the salvage it resumes from, the Event payload as JSON, the Agent persona, the task text, completion rules, and GitHub rules (review with `COMMENT` only, and end every comment, issue, pull request, and review with the signature line from `githubSignature`, which ends in `usine agent: <name>`). The parent's only tool is `subagent` (`packages/durable/src/attempt/subagent.ts:31`). Each call starts one child of the Agent's harness in the checkout. The tool is declared `replay: "unsafe"` (`subagent.ts:271`): after a restart the interrupted call settles with the output committed so far, and the parent decides whether to delegate again. A final answer that starts with `[usine:blocked]` fails the Attempt with `AgentFailure` (`task.ts:58`). The `children` count in the Attempt record enforces `max_children`; one more spawn fails the Attempt with `ChildSessionBudgetFailure`.

The parent's billing pool follows its provider: a model from `openai-codex` uses the ChatGPT plan and every other model uses API keys (`packages/agents/src/pi/authentication.ts:30`, [ADR 0021](https://github.com/basaltbytes/usine/blob/main/docs/adr/0021-pi-parent-pool-follows-authentication.md)).

### Reattach after a restart

1. `RunDriver.openAttempt` (`run-driver.ts:234`) asks `isLive`. The durable session answers true when the task is live, or when it finished with `ParentReported` and nothing harvested it yet (`durable-session.ts:396`).
2. `beginAttempt` returns `ReattachAttempt`: same Attempt id and number, no retry spent (`packages/engine/src/engine/lifecycle.ts:132`).
3. `prepare` with `reattach` reads the stored RunSpec, issues fresh credentials, and takes over the existing worktree.
4. `execute` finds the task in storage and continues its relay from the stored sequence.

An Attempt whose task is gone fails as an `InfraFailure`, and the next Attempt starts from the newest pushed salvage. Interrupting a launch that nobody stopped means this process is stopping, so the task stays live and the worktree stays on disk (`durable-session.ts:193`).

## The Attempt channel and the transcript

The envelopes are defined in `packages/core/src/attempt/channel.ts`, protocol version 7. Outbound payloads are `Started`, `SessionEvent`, `Final`, `Failed`, `Interrupted`, `InterventionApplied`, and `InterventionRejected`. Inbound payloads are `Steer`, `Interrupt`, `OperatorMessage`, `Release`, and `Cancel`, each with a target: the parent or a child session id. `admit` (`channel.ts:221`) enforces the order: one `Started` or `Failed` first, contiguous sequences, nothing after the terminal envelope.

`relayAttempt` (`packages/durable/src/attempt/relay.ts:171`) sends `Started`, then the parent's committed entries and the children's session events in the order they happened, then one terminal envelope. The next sequence numbers are in the durable Attempt record, so a relay that restarts continues the same sequence.

The sink that the Run fiber hands to the executor calls `RunStore.appendTranscript` (`packages/engine/src/store/store.ts:546`). Each envelope becomes one row of `usine_attempt_transcripts`. A unique index on Attempt, direction, and channel sequence keeps the first copy when a reattached relay sends an envelope again. A `Started` envelope writes the parent model the SDK chose to the Attempt row, and an `InterventionApplied` envelope sets `operator_intervened`. Envelopes of protocol versions 3 to 6 still decode (`packages/engine/src/transcript.ts:21`).

```
child (Claude Code, Codex, Pi)
   | normalized AgentSessionEvent
   v
Pi parent task (pi-durable) --- relayAttempt: envelopes in order
   v
runaway guard sink (executor/src/guard.ts) --- meters tokens, tracks Holds
   v
RunStore.appendTranscript --- usine_attempt_transcripts in .usine/runtime.sqlite
   v
RunReader.transcript --- GET /api/runs/:runId (newest 500 rows per Attempt, tail, earlier pages)
   v
Run drawer (apps/web/src/run-drawer.tsx) --- polls every second while the Run can be canceled
```

The operator's first read returns the newest 500 rows of each Attempt (`packages/orchestrator/src/operator/projection.ts:37`, `:192`), later reads return the rows after a sequence, at most 500 rows across all Attempts (`:39`), and the drawer loads earlier pages of one Attempt on request.

## The live channel for interventions

Operator input never becomes an Event ([ADR 0018](https://github.com/basaltbytes/usine/blob/main/docs/adr/0018-takeover-and-edit-and-retry.md)). It takes this path:

1. `POST /api/runs/:runId/intervene` with the Attempt id, the target, and the action.
2. `Operator.intervene` (`packages/orchestrator/src/operator/operator.ts:471`) attributes it to `operator` from `usine.yaml`, or to `local operator`.
3. `RunEngine.intervene` (`packages/engine/src/engine/engine.ts:120`) refuses unless the Run is `Running` and the Attempt is its latest open one.
4. The executor's durable session (`durable-session.ts:312`) refuses with `AgentFailure` when the Attempt has no live session in this process, as before a reattachment.
5. `AttemptRuntime.intervene` (`packages/durable/src/attempt/runtime.ts:305`) records the inbound envelope, applies the action, and records `InterventionApplied` or `InterventionRejected`.

On the parent, `Interrupt` aborts the current turn and marks the parent paused in its `HoldDoc`. An `OperatorMessage` to a paused parent resumes it with the message, and an `OperatorMessage` to a busy parent is submitted as a steer (`runtime.ts:225`). `Release` resumes a paused parent. On a child, an `OperatorMessage` places a Hold and `Release` ends it, so the held child's result returns to the parent only after release (`runtime.ts:205`).

## Harnesses

| Harness | Driven by | Where it runs | Preflight | Pool |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.261, executable `claude`, `permissionMode: "bypassPermissions"`, user settings only (`packages/agents/src/pi/claude.ts:183`) | Locally, or one SSH command with a pid file through `spawnClaudeCodeProcess` (`claude.ts:160`) | `claude --version`; `claude auth status --json` must report a `claude.ai` first-party login (`packages/agents/src/preflight/preflight.ts:74`) | Claude plan |
| Codex | `codex app-server` JSON-RPC over stdio, `approvalPolicy: "never"`, sandbox `danger-full-access` (`packages/agents/src/pi/codex/codex.ts:132`) | Locally, or one SSH command with a pid file (`packages/agents/src/pi/codex/app-server.ts:116`) | `codex --version` must be 0.144.0 or 0.153.4; account check through the app-server (`preflight.ts:20`, `:51`) | ChatGPT plan |
| Pi | `@earendil-works/pi-coding-agent` 1.1.0 in the orchestrator process | Local Workers only; a remote host is refused (`packages/agents/src/pi/pi.ts:69`) | Starts a session to check the model and its API-key authentication (`preflight.ts:86`) | API keys |

`childDispatcherLayer` picks the backend from the Agent's `harness` (`packages/agents/src/pi/children.ts:31`). Every child gets exactly the Attempt's environment and nothing from the orchestrator's own (`packages/agents/src/runtime.ts:38`). On the local Worker that is `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, `USER`, the credential variables, and `TURBO_CACHE_DIR` (`packages/executor/src/local/local.ts:72`, `:280`). On a remote Worker the variables are exported on top of the machine's own environment. Before a remote checkout is kept or removed, `CHILD_KILL_SCRIPT` stops every process listed in a `<worktree>.child-*.pid` file (`packages/agents/src/child-host/child-host.ts:106`), because an SSH client that exits does not prove its remote command stopped.

Pi children on a local Worker run their tools in the orchestrator process. Their grep and find tools inherit the orchestrator's environment (#181).
