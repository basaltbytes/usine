---
title: "Operator surfaces"
description: "Every HTTP endpoint, the web UI pages, the CLI, logs and spans."
sidebar:
  order: 5
---

:::note
This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.
:::
The operator works with usine through four things: a local HTTP API, the web UI built on it, the `usine` CLI, and the process logs. Apart from what the agents write, usine writes to a repository in three cases: it creates the labels `usine.yaml` declares, it applies Board moves, and it pushes salvage branches `usine/salvage/<run>/<number>`.

## The HTTP server

`usine up` serves on `127.0.0.1`, port 7331 unless `--port` or `USINE_PORT` sets another (`apps/server/src/cli.ts:10`). The server (`apps/server/src/http.ts:243`) has three kinds of routes:

- `/api/*`: the operator API below.
- `GET /` and `GET /assets/*`: the built web UI, from the `web` folder next to the server's `main.js`.
- Any other `GET` path without a file extension: `index.html`, so client routes load on refresh.

There is no authentication. A request whose `Origin` header is present and not a loopback host is refused with 403 `CrossSiteRequestError` before its handler runs (`http.ts:68`). JSON bodies are accepted whatever the `Content-Type`. Without GitHub App credentials the server runs in setup mode: the overview and Run detail work, and every action answers 503 `BackendUnavailableError` (`apps/server/src/backend.ts:77`).

## Endpoints

The contract is `OperatorApi` (`packages/orchestrator/src/operator/http.ts:149`), an Effect `HttpApi` that both the server and the web client use (`apps/web/src/api.ts`). Every action answers `{ "ok": true }` once accepted; the result appears in later reads.

| Method | Path | Body or query | Does |
| --- | --- | --- | --- |
| GET | `/api/overview` | | `Ready` or `NeedsSetup` overview: each Project's status, Runs, Board, labels, and label preflight findings; each Loop's trigger, Agent, and paused flag; the Needs you list. |
| GET | `/api/agents` | | The roster's Agent names. |
| GET | `/api/runs/:runId` | none, `after=<seq>`, or `before=<seq>&attempt=<id>` | The Run with its Attempts, Event dedup key and payload, and a transcript window: the newest 500 rows of each Attempt, the rows after a sequence (at most 500 across all Attempts), or one earlier page of an Attempt (`packages/orchestrator/src/operator/projection.ts:37`). |
| POST | `/api/runs/:runId/approve` | | Records the approval Event; `Waiting` becomes `Queued`. 409 in any other state. |
| POST | `/api/runs/:runId/retry` | | `Failed` becomes `Running`; a new Attempt starts when a Worker slot is free. |
| POST | `/api/runs/:runId/edit-and-retry` | `{ task, agent }` | Replaces the Run's task text and Agent, then retries. 404 for an Agent outside the roster. |
| POST | `/api/runs/:runId/cancel` | | Cancels an open Run and stops its Attempt. |
| POST | `/api/runs/:runId/resolve-failure` | `{ attemptId }` | Marks the latest failed Attempt as handled, which removes it from Needs you. |
| POST | `/api/runs/:runId/intervene` | `{ attemptId, target, action }` | Sends `Steer`, `Interrupt`, `OperatorMessage`, or `Release` to the parent or a child ([`execution.md`](/architecture/execution/)). |
| POST | `/api/cycle-budgets/reset` | `{ askId }` | Answers a cycle-budget Ask and grants the Item a new allowance. |
| POST | `/api/projects/:owner/:repository/items/:item/lane` | `{ toLane }` | Writes the label swap of a Board move to GitHub, then queues a Hint for that Item. 409 for a read-only lane. |
| POST | `/api/loops/:loop/pause` | | Sets the Loop's paused flag. |
| POST | `/api/loops/:loop/unpause` | | Clears it. |

Failures return `{ error, message }`, where `error` is the domain error's tag (`http.ts:19`). Request decoding errors are 400; `CrossSiteRequestError` 403; Run, Attempt, Project, Item, lane, and Agent not found 404; rejected operations, rejected interventions, rejected resets, and read-only lanes 409; persistence and cancellation failures 500; GitHub API failures 502; setup mode, installation problems, and GitHub rate limits 503.

### Calling the API by hand

`curl` sends no `Origin` header, so the cross-site guard lets it through. The bodies below follow the request schemas (`packages/orchestrator/src/operator/run.ts:20`); they were not run against a live server for this page.

```sh
curl -s http://127.0.0.1:7331/api/overview
curl -s -X POST http://127.0.0.1:7331/api/runs/<runId>/approve
curl -s -X POST http://127.0.0.1:7331/api/loops/review-pr/pause
curl -s -X POST http://127.0.0.1:7331/api/runs/<runId>/intervene \
  -d '{"attemptId":"<runId>/<step>/<n>","action":{"_tag":"OperatorMessage","message":"Stop after the tests pass."}}'
```

Without `target`, an intervention goes to the parent (`run.ts:30`); a child is `{"_tag":"Child","sessionId":"<id>"}`.

### Needs you

The Needs you list contains seven kinds (`packages/orchestrator/src/operator/need.ts`): `ApprovalNeed`, `RunFailureNeed`, `PollFailureNeed`, `PreflightFindingNeed`, `BoardProjectionNeed`, `ScheduleFailureNeed`, and `CycleBudgetNeed`.

## The web UI

`apps/web` is a React app with TanStack Router and Query, built with Vite. `apps/web/README.md` describes each screen's behaviour in detail.

| Route | Page |
| --- | --- |
| `/` | Projects: one row per registered repository with Item and lane counts and a status (`apps/web/src/routes/index.tsx`). |
| `/projects/$owner/$name` | The Board of one Project: lanes of Task cards, drag-and-drop moves on authored label lanes, each card's Run history (`apps/web/src/board/board.tsx`). |
| `/configuration` | Redirects to `/configuration/loops`. |
| `/configuration/loops` | Loops with their trigger, Agent, and a pause toggle (`apps/web/src/routes/configuration/loops.tsx`). |
| any route with `?run=<runId>` | The Run drawer over the current page (`apps/web/src/open-run.ts`). |

The root layout (`apps/web/src/routes/__root.tsx`) has the sidebar, the Needs you strip, and, in setup mode, a notice that lists the credential variables to set and says to restart `usine up`. The drawer has the conversation, plus Task, Event, and Attempts tabs. Its actions are Approve, Retry, Cancel Run (with a confirmation), Edit and retry, and resolve failure (`apps/web/src/run-drawer.tsx:93`). Its message box sends `OperatorMessage` to the parent or a child, Pause session sends `Interrupt`, and Release child sends `Release` (`apps/web/src/run-intervention/session-composer.tsx`). The drawer keeps each reader's position in browser storage ([ADR 0025](https://github.com/basaltbytes/usine/blob/main/docs/adr/0025-run-conversation-reader-bookmarks.md)).

The UI polls. The overview refreshes every 2 seconds while a Run can be canceled and every 15 seconds otherwise, and stops in setup mode (`apps/web/src/overview.ts:12`). An open drawer refreshes every second while its Run can be canceled (`run-drawer.tsx:91`). The Board refreshes every second while a move is pending (`apps/web/src/board/moves.ts:61`).

There is no page for editing configuration, for usage and cost, for Worker preflight on demand, or for creating the GitHub App.

## The CLI

`apps/server` publishes the `usine` binary (`apps/server/src/main.ts`). Commands, as `CLI_USAGE` lists them (`cli.ts:23`):

| Command | Does |
| --- | --- |
| `usine up [--port <port>] [--allow-volatile-instance]` | Runs the orchestrator in the foreground from the instance folder. |
| `usine backup <path>` | Copies the durable storage, then the runtime store, to new files ([`storage-and-config.md`](/architecture/storage-and-config/)). |
| `usine export-run <runId> [--output <path>]` | Writes the Run's snapshot and its whole transcript as JSON, by default to `run-<encoded runId>.json` (`apps/server/src/export-run.ts`). |
| `usine --help`, `usine --version` | Usage, and the installed `@usine/server` version. |

`usine up` (`apps/server/src/up.ts:104`) runs these steps in order:

1. Refuse a volatile instance folder.
2. Take the instance lock: an exclusive SQLite transaction on `.usine/instance.lock`, which the OS releases when the process exits.
3. Refuse a port that another process listens on, and print that process's pid when `lsof` can find it.
4. Load the instance folder.
5. Load the GitHub App credentials. When they are missing, start in setup mode and open the browser.
6. Otherwise build the runtime and run the HTTP server and the trigger streams together under graceful shutdown.

`@usine/gateway` publishes a second binary, `usine-gateway`, which runs on the Gateway VM ([`workers-and-gateway.md`](/architecture/workers-and-gateway/)).

## Logs and spans

Every service method is an `Effect.fn` span annotated with its domain ids (`runId`, `attemptId`, `repository`, `loop`, `worker`), and decision points log with `Effect.logInfo`, `logWarning`, or `logError` and structured fields. `apps/server` installs no logger or tracer layer, so logs go to the console through Effect's default logger and spans are not exported anywhere. The console format is not verified here. The Gateway installs `Logger.consoleJson`, one JSON object per line for journald (`packages/gateway/src/node/main.ts:7`).

These messages answer the usual questions:

| Question | Message | Code |
| --- | --- | --- |
| Did the poll run? | `Poll cycle complete` | `packages/orchestrator/src/polling/polling.ts:491` |
| Did an Item match a Loop? | `Submitted matching item state` | `packages/orchestrator/src/polling/loop-evaluation.ts:163` |
| What did the engine do with the Event? | `Event claim decided`, `Event joined its existing Run`, `Event remains ignored` | `packages/engine/src/store/store.ts:103` |
| Why does a Run not start? | `Run waits for a worker slot`, `Run waits for its approval`, `Attempt deferred until restart; the engine is draining` | `packages/orchestrator/src/scheduler.ts:142`, `packages/engine/src/engine/run-driver.ts:356`, `packages/engine/src/engine/admission.ts:37` |
| Did an Attempt start and end? | `Attempt started`, `Attempt completion decided` | `store.ts:249`, `store.ts:185` |
| Is a Worker ready? | `Worker preflight verified`, `SSH Worker preflight verified`, `Worker preflight failed` | `packages/executor/src/local/local.ts:271`, `packages/executor/src/ssh/preflight.ts:95`, `packages/executor/src/executor.ts:75` |
| Did operator input arrive? | `Operator input applied`, `Session refused operator input` | `packages/durable/src/attempt/runtime.ts:305` |
| What happened at restart? | `Runs recovered from the run tables`, `The open Attempt's parent task is live; reattaching it` | `run-driver.ts:386`, `run-driver.ts:234` |
