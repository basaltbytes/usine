---
title: "Run lifecycle"
description: "Polling and content-hashed Events, Run and Attempt states, approval, retry, cancel, revoke, cycle budgets, drain, one Run from trigger to pull request."
sidebar:
  order: 1
---

:::note
This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.
:::
A GitHub change becomes work in four steps: polling fetches the changed Item and hashes its payload, a Loop whose `if:` matches turns that hash into an Event, the engine gives the Event a Run, and the Run's fiber tries the Run's one Step as Attempts until the Run closes. Paths are relative to the repository root.

## From a GitHub change to an Event

`PollingTriggers.run` (`packages/orchestrator/src/polling/polling.ts:468`) repeats `poll` (`:312`) every `poll_interval` seconds, or later when GitHub asks for a longer wait. Each cycle reads the paused Loops from `LoopControl` (`:315`), resolves every Loop to its roster Agent, and keeps the issue and pull request Loops whose selector matches each repository. Up to four repositories are polled at once (`:56`). Every registered repository is polled, even one without an active Loop, because the Board reads the same projection.

`pollRepository` (`polling.ts:191`) does this for one repository:

1. Label preflight first: `synchronizeLabels` (`packages/orchestrator/src/polling/repository-sync.ts:162`) reads the label catalog under its ETag and creates the labels `usine.yaml` declares that the repository lacks.
2. Change detection: `GitHubPolling.changes` (`packages/github/src/polling/polling.ts:333`) sends `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc&since=<watermark - 5 s>` with `If-None-Match`; [ADR 0007](https://github.com/basaltbytes/usine/blob/main/docs/adr/0007-polling-triggers-content-hashed-events.md) relies on GitHub not counting an authenticated 304 against the rate limit. The walk stops after ten pages (`:48`) and the next cycle continues from the watermark.
3. Every open pull request the stored cursor knows is fetched again on every cycle, changed or not, because mergeability can change without an `updated_at` change ([ADR 0007](https://github.com/basaltbytes/usine/blob/main/docs/adr/0007-polling-triggers-content-hashed-events.md), #155).
4. `observeItem` (`repository-sync.ts:215`) reads the Item's cycle generation, fetches its GraphQL payload slice (`GitHubPolling.snapshot`, `packages/github/src/polling/polling.ts:442`), and stores it as the Item's projection. The content hash is the SHA-256 of the payload as canonical JSON with `createdAt`, `updatedAt`, `closedAt`, `mergedAt`, and `submittedAt` removed (`packages/github/src/polling/content.ts:7`, `polling.ts:549`).
5. `evaluateItem` (`packages/orchestrator/src/polling/loop-evaluation.ts:52`) evaluates each Loop of the Item's stream. When `if:` is false it calls `RunEngine.revoke` (`:109`). When it is true it renders the prompt (`:128`) and submits (`:148`).
6. The cursor is written only after every Item of the cycle finished (`polling.ts:265`). A failure of the repository poll itself, in change detection, an Item fetch, an `if:` evaluation, or a submission, leaves the old cursor, so the next cycle sees the same Items again. A prompt that fails to render is scoped to its Loop (`loop-evaluation.ts:125`): it is reported as a poll failure in Needs you, and the sibling Loops and the cursor still advance.

The dedup key of an issue or pull request Event is the JSON array `[loop, repository, number, contentHash]`, with the cycle generation appended once it is above zero (`loop-evaluation.ts:29`). The Event id is the dedup key (`packages/orchestrator/src/trigger-submission.ts:101`). The ledger keeps every key forever, so the same Loop never acts twice on the same Item content.

A Board move gives a Hint: `Operator.moveBoardItem` calls `PollingTriggers.hint` after its label write (`packages/orchestrator/src/operator/operator.ts:556`). `refreshHint` (`polling.ts:395`) fetches that one Item through the same `observeItem` and `evaluateItem` path and never advances the cursor. The Hint queue has room for 128 entries, drops the rest, and merges duplicates (`packages/orchestrator/src/polling/hints.ts:14`). Board moves are the only Hint source in the code.

Schedule Loops have their own service. `ScheduleTriggers` (`packages/orchestrator/src/schedule-triggers.ts:297`) wakes at the next due Tick or after 60 seconds (`:50`), takes the latest Tick at or before now (`:159`), evaluates `if:` against `{ tick: { scheduledAt, scheduledAtLocal, cron, tz } }`, and submits one Event per selected repository. Its dedup key is `[loop, repository, scheduledAt]` (`:184`) and its Item key is `["github", repository]` (`:181`). The map of fired Ticks is in memory (`:229`), so after a restart the latest missed Tick fires once and the ledger drops repeats.

## Identities

| Identity | Value | Code |
| --- | --- | --- |
| Item key | JSON `["github", "<owner/name>", number]`, lowercase repository | `packages/orchestrator/src/polling/repository-sync.ts:41` |
| Event id | the dedup key | `packages/orchestrator/src/trigger-submission.ts:101` |
| Run id | hex of the first 16 bytes of SHA-256 of `@usine/engine/DurableRun-<dedup key>` | `packages/engine/src/engine/submission.ts:50` |
| Attempt id | `<runId>/<step>/<number>` | `packages/engine/src/store/store.ts:308` |
| Approval Event | dedup key `["operator-approval", runId]` | `packages/orchestrator/src/operator/operator.ts:426` |
| Cycle reset Event | dedup key `cycle-budget-reset:<askId>` | `packages/orchestrator/src/operator/operator.ts:587` |

## Submission and the claim

`RunEngine.submit` (`packages/engine/src/engine/engine.ts:52`) calls `RunStore.recordAndClaim` (`packages/engine/src/store/store.ts:103`), one transaction:

1. Insert the Event, ignoring a duplicate dedup key.
2. A Run already exists for the Event: return `Claimed` with that Run, whatever its state. A canceled Run keeps its Event, so the same content cannot open a new Run (#267).
3. The Event is in `usine_ignored_events`, or belongs to an older cycle generation: return `Ignored`.
4. Find the open Run of the same Loop and Item and decide with `claimRun` (`packages/engine/src/engine/lifecycle.ts:225`). A `Running` Run queues the Event. A `Pending`, `Waiting`, or `Queued` Run is superseded: it becomes `Canceled` with reason `Superseded` and a new Run opens. When there is no open Run, a new one opens.
5. Opening a Run first checks the Item's cycle budget (`packages/engine/src/cycle-budget/queries.ts:84`). An exhausted budget returns `CycleBlocked` and opens nothing.

After the transaction, `submit` stops the superseded Run's fiber and starts the new one.

## States

Run states are tagged classes in `packages/core/src/run/state.ts`. Each transition function accepts only its legal source states.

| State | Meaning | Set by |
| --- | --- | --- |
| `Pending` | created, no Attempt, no gate passed | `recordAndClaim` |
| `Waiting` | parked on `approval: required` | `parkForApproval` (`store.ts:169`) |
| `Queued` | approved, waiting for a Worker slot | `approve` (`store.ts:414`) |
| `Running` | an Attempt runs, or the next one is about to start | `beginAttempt` (`store.ts:249`), operator `retry` |
| `Succeeded` | the Step result is stored | `finishAttempt` (`store.ts:362`) |
| `Failed` | the last Attempt failed and no auto-retry applies | `finishAttempt` |
| `Canceled` | with reason `OperatorCanceled`, `Superseded`, or `Revoked` | `cancel`, `recordAndClaim`, `revoke` |

```
pending ---------------------------------> running ----> succeeded
   |                                        ^  |  ^
   | approval: required                     |  |  | infra failure, attempt < 3:
   v                                        |  |  | next Attempt, same Run
waiting --(operator approve)--> queued -----+  |--+
                                               v
                                             failed --(operator retry or
                                                        edit-and-retry)--> running

pending | waiting | queued | running --> canceled (operator cancel)
pending | waiting | queued           --> canceled (superseded, revoked)
```

An Attempt ends as `Succeeded`, `Failed` with a typed failure, or `Canceled` (`packages/core/src/attempt/outcome.ts`). The failures are `InfraFailure`, `DefectFailure`, `AgentFailure`, `RunawayFailure`, and `ChildSessionBudgetFailure` (`packages/core/src/attempt/failure.ts`). Only `InfraFailure` retries without the operator, up to three Attempts in total (`lifecycle.ts:12`). A Worker capability error at preparation becomes an `AgentFailure` (`packages/orchestrator/src/scheduler.ts:51`), so a logged-out harness waits for the operator.

## The Run fiber

`RunDriver` (`packages/engine/src/engine/run-driver.ts`) keeps one fiber per open Run in a `FiberMap`. `drive` (`:341`) does this:

1. Read the Run's Submission. With `approval: required`, park the Run as `Waiting` and end the fiber. The approval starts a new one.
2. Reserve a Worker slot. `StepExecutor.reserve` (`packages/orchestrator/src/scheduler.ts:131`) serves reservations in order of Event receipt time, one slot per `max_concurrent_attempts`.
3. Enter Attempt admission (`packages/engine/src/engine/admission.ts:58`) and run `executeAttempt` (`run-driver.ts:288`): ask the executor whether an open Attempt is still live (`openAttempt`, `:234`), then `beginAttempt` starts a new Attempt or reattaches the live one, then `execute`, then `finishAttempt`.
4. Repeat while the decision is `RetryAttempt`.
5. Give the newest queued Event of the same Loop and Item its turn (`continueWithNewest`, `:179`). `TriggerCondition.holds` fetches the Item again and evaluates `if:` (`packages/orchestrator/src/trigger-condition.ts:23`); a failure or a five-second timeout answers true. A false answer marks the queued Events as revoked.

A store write that fails is retried four times with exponential backoff from 100 ms (`run-driver.ts:47`). A fiber that stops on an engine failure is started again by `reconcile`, which runs at engine start and every three minutes (`packages/engine/src/engine/engine.ts:37`, `:181`). Before the first reconcile, `recoverWorkspaces` (`engine.ts:286`) asks the executor to salvage or remove every checkout an earlier process left.

## Operator actions

Each action is an HTTP endpoint ([`operator-surfaces.md`](/architecture/operator-surfaces/)) that calls `Operator`, then `RunEngine`.

| Action | Code | Effect |
| --- | --- | --- |
| Approve | `operator.ts:411`, `store.ts:414` | Records the approval Event in `usine_approvals`, moves `Waiting` to `Queued`, starts the fiber. Any other state is rejected with 409. |
| Retry | `operator.ts:439`, `store.ts:435` | Moves `Failed` to `Running` with no limit on the Attempt count. The next Attempt starts from the newest pushed salvage, if there is one. |
| Edit and retry | `operator.ts:445`, `packages/engine/src/store/queries.ts:400` | The same retry, after replacing the Run's task text, Agent, and parent model. Every later Attempt uses the amendment ([ADR 0018](https://github.com/basaltbytes/usine/blob/main/docs/adr/0018-takeover-and-edit-and-retry.md)). |
| Cancel | `engine.ts:92`, `store.ts:471` | Any open state becomes `Canceled`; an open Attempt closes as `Canceled`. Then the executor stops the Attempt, the fiber stops, and the queued Events get their turn. |
| Resolve failure | `store.ts:378` | Marks the latest failed Attempt as handled in `resolved_failure_attempt_id`. The state does not change. |
| Intervene | `engine.ts:120` | Requires a `Running` Run whose latest Attempt is the one addressed; the action goes to the live session ([`execution.md`](/architecture/execution/)). |
| Pause, unpause | `operator.ts:498` | Writes `usine_loop_runtime`. A paused Loop opens no Run; existing Runs continue. |
| Reset cycle budget | `operator.ts:583`, `packages/engine/src/cycle-budget/cycle-budget.ts:83` | See below. |

The engine revokes on its own: when an Item stops matching a Loop's `if:`, `revoke` (`store.ts:497`) cancels that Loop's unstarted Runs on the Item with reason `Revoked` and marks its queued Events as ignored. A running Attempt is never revoked or superseded.

## Cycle budgets

A Loop may open `max_cycles` Runs on one Item between operator resets, three by default (`packages/core/src/cycle-budget.ts:20`). Schedule Loops have no budget (`trigger-submission.ts:111`). `admit` (`cycle-budget/queries.ts:84`) counts the Loop's reserved Runs in the current generation. When the count is at the limit, it stores a `CycleBudgetAsk` in `usine_item_cycle_budgets.ask_json`, and from then on every Loop's submission on that Item returns `CycleBlocked`. A Run canceled before its first Attempt gives its reservation back.

The Ask appears only in the UI's Needs you list; nothing is posted to GitHub (#36). The reset (`cycle-budget.ts:83`) records the answer Event, increments the generation, clears the Ask, moves unstarted Runs' reservations into the new generation, and sets `reset_pending`. The next poll of that repository starts from an empty cursor (`polling.ts:195`), so current state produces fresh Events whose dedup key includes the new generation. [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) explains why the budget is per Item.

## Drain

The first SIGINT or SIGTERM completes the `RunEngineShutdown` latch (`apps/server/src/shutdown.ts:5`), which closes Attempt admission at once. The process then waits for admitted Attempts to record their outcome, bounded by `max_attempt_minutes` when set and unbounded otherwise (`apps/server/src/up.ts:171`). A second signal ends the wait. An Attempt interrupted this way keeps its parent task live in durable storage, and the next `usine up` reattaches it (`packages/executor/src/durable-session.ts:193`). [ADR 0023](https://github.com/basaltbytes/usine/blob/main/docs/adr/0023-graceful-attempt-drain.md) records why admission belongs to the engine.

## One Run from trigger to pull request

The `start-dev` Loop of the dogfood instance ([`loops-shipped.md`](/architecture/loops-shipped/)), on an SSH Worker behind a Gateway:

```
GitHub             PollingTriggers        RunEngine, RunDriver    Executor, durable, Worker
  |                       |                        |                          |
  | operator labels issue #N ready-for-agent       |                          |
  |<-- GET /issues?since -|                        |                          |
  |-- 200: #N changed --->|                        |                          |
  |<-- GraphQL slice -----|                        |                          |
  |                       | if: true; key [start-dev,                         |
  |                       | repo, N, hash]         |                          |
  |                       |-- submit ------------->| recordAndClaim: Pending  |
  |                       |                        | approval required:       |
  |                       |                        | Waiting                  |
  |                       | operator approves ---->| Queued; fiber starts     |
  |                       |                        | reserve slot;            |
  |                       |                        | beginAttempt: Running,   |
  |                       |                        | Attempt 1                |
  |                       |                        |-- execute -------------->| attach token to Gateway,
  |                       |                        |                          | clone, worktree --detach,
  |                       |                        |                          | Pi parent task starts,
  |                       |                        |                          | subagent: Codex child
  |<-- git push, gh pr create, through the Gateway ---------------------------|
  |                       |                        |<-- envelopes ------------| transcript rows
  |                       |                        |<-- StepResult -----------| harvest: commits, PR #M
  |                       |                        | Attempt and Run          | detach, remove worktree
  |                       |                        | Succeeded;               |
  |                       |                        | continueWithNewest       |
```

The Codex child also adds `ready-for-review` to PR #M. The next poll sees #M changed, `review-pr` matches it, and a new Run opens for the pull request.
