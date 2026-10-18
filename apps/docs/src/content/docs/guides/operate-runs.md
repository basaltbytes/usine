---
title: Operate Runs
description: Follow Runs in the web UI, approve, retry, cancel, and edit them, steer a live Attempt, answer Needs you, stop the orchestrator cleanly, and back up the runtime store.
sidebar:
  order: 3
---

A Run is the work that a Loop does for one Event, and each try of its Step is an Attempt. This page explains how to manage Runs in the web UI at `http://127.0.0.1:7331`, and the CLI commands that back up and export their history. Every UI action is also available as an HTTP endpoint of the operator API.

## Follow a Run

**Projects** lists the registered repositories with their Item and lane counts and a status: **needs you**, **active** while a Run can still be canceled, or **clear**. Opening a project shows its Board, where each card is a task: an issue and the pull requests linked to it, with the history of their Runs. A card shows when one of its Runs is waiting for approval or for a free Worker. The Board lists Runs without an Item, such as schedule Runs, below the lanes under **Runs without a card**.

Selecting a Run in a card's history, or in **Needs you**, opens the Run drawer. The URL gets `?run=<run id>`, so you can share or reload it. The drawer has:

- a header with the Loop, the Run's state, a **Loop paused** badge when that applies, the repository, and links to the Item and to the pull request the Run produced;
- a row of the actions the Run's state allows;
- **Conversation**: the parent's messages and one collapsible section per child, with **Everything**, **Messages**, and **Tools** filters, **Load earlier** for older activity, and a message box while the Attempt runs;
- **Task**: the task the Run currently uses;
- **Event**: the Event's identity and the Item payload it was recorded with;
- **Attempts**: the Run id, the rate windows the providers reported for each billing pool, and for each Attempt its Agent, Worker, harness, model, effort, the task it actually ran, its failure, and where its unfinished work was saved.

The drawer refreshes every second while the Run can be canceled, and the rest of the UI every 2 seconds while some Run can be canceled, or every 15 seconds otherwise.

## Run states

| State       | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `Pending`   | Opened. No Attempt has started, and the Run waits for a Worker slot unless its Loop requires approval. |
| `Waiting`   | Waits for your approval.                                                                      |
| `Queued`    | Approved, and waits for a Worker slot. The drawer says **Waiting for a free worker**.          |
| `Running`   | An Attempt is running, or the next one is about to start.                                     |
| `Succeeded` | The Step's result is stored: the commits and pull requests the Attempt produced.              |
| `Failed`    | The last Attempt failed, and the engine doesn't retry it automatically.                       |
| `Canceled`  | Canceled by you, superseded by a newer Event on the same Item, or revoked because the Item no longer matches. |

The actions you see in the drawer move a Run between these states:

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Pending: a Loop matches an Item
  Pending --> Waiting: the Loop requires approval
  Pending --> Running: a Worker slot is free
  Waiting --> Queued: Approve
  Queued --> Running: a Worker slot is free
  Running --> Running: infrastructure failure, next Attempt
  Running --> Succeeded: the Attempt succeeds
  Running --> Failed: the Attempt fails
  Failed --> Running: Retry, or Edit and retry
  Failed --> Failed: Mark resolved
  Pending --> Canceled: Cancel Run, superseded, or revoked
  Waiting --> Canceled: Cancel Run, superseded, or revoked
  Queued --> Canceled: Cancel Run, superseded, or revoked
  Running --> Canceled: Cancel Run
  Succeeded --> [*]
  Failed --> [*]
  Canceled --> [*]
```

Workers take Runs in the order their Events arrived, and each Worker runs up to its `max_concurrent_attempts` at a time.

## Approve

A Loop with `approval: required` keeps each new Run in `Waiting`. The Run appears in **Needs you** as **Approval required**, and its card shows that a Run is waiting for approval. Open the Run, read its **Task** and **Event**, and select **Approve**. The Run becomes `Queued` and starts when a Worker slot is free.

If the Item changes before you approve and still matches the Loop, a new waiting Run replaces this one, and usine cancels this one as superseded. If the Item no longer matches, usine cancels the waiting Run as revoked.

## Retry and Mark resolved

The engine retries an Attempt automatically only after an `InfraFailure`, such as an unreachable Worker or a failed checkout, and only up to three Attempts per Run. Every other failure leaves the Run `Failed` and lists it in **Needs you** under the failure's name:

| Failure                     | Cause                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `InfraFailure`              | Infrastructure failed around the Agent, and the Run has used its three automatic Attempts.                 |
| `AgentFailure`              | The Agent reported a blocker with `[usine:blocked]`, a harness isn't ready on the Worker, or the parent's model, effort, or credential is unusable. |
| `QuestionFailure`           | The Agent needs a decision from you and asked it with `[usine:question]`. See [Answer a question](#answer-a-question). |
| `DefectFailure`             | A defect in usine at the execution boundary.                                                               |
| `RunawayFailure`            | The Attempt reached `max_attempt_minutes` or `max_attempt_tokens`.                                         |
| `ChildSessionBudgetFailure` | The parent tried to start more children than `max_children` allows.                                       |

**Retry** starts a new Attempt of the same Run, and you can retry any number of times. When an Attempt ends without success, usine commits its uncommitted changes and pushes its worktree to the branch `usine/salvage/<run>/<attempt number>` of the repository; the next Attempt starts from the newest salvage branch, and its prompt says so. If that push fails, the worktree stays on the Worker and the Attempt shows its path. usine never deletes a salvage branch.

A later Event on the same Item can open a new Run of the Loop while the failed one waits for you. usine refuses to retry the failed Run while that other Run is open, so that one Loop never runs twice on one Item; the drawer names the open Run. Retry after it closes, or cancel it first. **Edit and retry** follows the same rule.

**Mark resolved** removes a failure you have handled from **Needs you** and from the project's status. The Run stays `Failed`, and you can still retry it. If a later Attempt fails, the Run appears in **Needs you** again.

## Answer a question

An Agent that can't continue without your decision posts its question on the Item and ends its Attempt with `[usine:question]`. The Run fails with `QuestionFailure`, and **Needs you** lists it as **\<loop\> asks a question**, with the question. usine doesn't retry it.

While the question waits, the Loop holds the Item. The Agent's own comment changed the Item, but the Loop opens no Run for that state, so a new Run doesn't ask the same question again and use up the cycle budget. The state the Loop holds is the first one polling sees after the question. The Loop acts on the Item again when one of these happens:

- the Item changes again, for example through your reply on the issue or pull request, an edit, or a pushed commit: the new state opens a Run, and its Agent reads your reply;
- the Item stops matching the Loop and comes back, for example when you remove and add the Loop's label;
- you **Retry** the Run, or **Edit and retry** it with your answer in the task;
- you select **Mark answered** in the Run drawer: the Loop takes the newest state it saw after the question, checks the trigger against the Item again, and opens a Run for it.

An answer on GitHub only counts when it changes the Item after polling has seen the Agent's question. If the Agent asked without posting anything, or you answer within the same poll, use **Mark answered** or **Retry** instead.

## Edit and retry

**Edit and retry** opens an editor with the Run's task and a list of the roster's Agents. **Save and retry** replaces the task, the Agent, and the parent model that usine picks for that Agent, then retries. The change persists: every later Attempt of the Run uses it, including automatic retries, until you edit again. Each Attempt records the task and Agent it actually ran, and the Event doesn't change.

## Cancel

Select **Cancel Run**, then **Confirm cancel**, to close any open Run as `Canceled`. usine stops a running Attempt and pushes its unfinished work to a salvage branch, as on a failure. The cancel holds while the Item stays as it is: polling sees the same content again and starts nothing.

To run the Loop on the Item again, make it leave the Loop and come back: remove the Loop's label, wait until usine sees the Item without it (one poll, or right away for a Board move), then add the label again. The same content then opens a new Run with a new id. A Run that usine superseded or revoked behaves the same way when the Item returns to its content. A `Failed` Run is different: it keeps its Event, and you retry it instead.

## Steer a live Attempt

While a Run is `Running`, the drawer has a message box under the parent's conversation, **Message the parent**, and one in each live child's section, **Message this child**. usine sends your message to the session through the Attempt's live channel and adds it to the transcript, with the `operator` login from `usine.yaml`, or `local operator`, as the sender. It never becomes an Event, and the Attempt gets an **Operator intervened** badge.

| UI control              | To the parent                                                                       | To a child                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Send** a message      | Goes into the current turn while the parent works, or resumes a paused parent with the message. | Goes into the child's conversation and places a Hold: the parent receives the child's answer only after you release it. |
| **Pause session**       | Stops the current turn. The parent waits until you send a message.                  | Pauses the child at its next tool or model call, until you send a message.                    |
| **Release child**       | not shown                                                                            | Ends the Hold, so the parent receives the child's answer once the child is idle.               |

To take over a live session, send it messages: you work in the session as a user would, and the parent waits for a held child until you release it. You can hold several children at once. While a child is held, the `max_attempt_minutes` clock stops; tokens still count toward `max_attempt_tokens`.

The API has one more action, `Steer`, which adds guidance to the parent or a child without a Hold. The runaway guard sends one `Steer` from the operator `engine` when an Attempt reaches 80% of a ceiling. All four actions use `POST /api/runs/<run id>/intervene`. usine refuses an action when the Run isn't `Running`, when the Attempt is no longer the Run's latest, or when the session isn't live in this process (for example, before a restarted orchestrator reattaches the Attempt). The drawer shows the error. When the session itself refuses an action, such as a message to a child that has already returned, the refusal appears in the conversation. usine delivers a message to a parent that is waiting for a child only after the child returns, and the parent might then end the Attempt with its answer to you as the result ([#159](https://github.com/basaltbytes/usine/issues/159)). Message the child instead when the parent is delegating.

For a Claude Code or Codex child, the expanded child section also shows its saved session id, its worktree on the Worker, and a **Resume on worker** command, `claude --resume <id>` or `codex resume -- <id>` from that worktree. Run it on the same Worker, under the same login, to continue the conversation yourself. This works only while the worktree exists; Attempt cleanup removes it.

## Needs you

**Needs you**, at the top of every page, lists the items that are waiting for you. Selecting an entry about a Run opens its drawer.

| Entry                                  | Meaning                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Approval required**                  | A Run is in `Waiting`. Approve or cancel it.                                                                         |
| A failure name, such as `AgentFailure` | A Run is `Failed`. Read the Attempt, then **Retry**, **Edit and retry**, or **Mark resolved**.                       |
| **\<loop\> asks a question**           | An Agent asked you a question and its Loop holds the Item. [Answer it](#answer-a-question).                          |
| **Cycle budget exhausted**             | An Item reached a Loop's `max_cycles`. Inspect it, then **Reset cycle budget**.                                      |
| An error name from polling             | A repository's poll failed, for example on a GitHub error, a missing App permission, or an `if:` that fails to evaluate. |
| **Label preflight failed**             | usine couldn't create a label that `usine.yaml` declares.                                                            |
| **Item projection quarantined**        | usine couldn't place an Item on its Board.                                                                           |
| A schedule error                       | A schedule Loop couldn't evaluate or submit a tick.                                                                  |
| **Loop quarantined**                   | A Loop file failed to load and opens no Runs. Fix the file and restart `usine up`.                                   |
| **Agent file not loaded**              | An Agent file failed to load and isn't in the roster. Fix the file and restart `usine up`.                          |

## Cycle budgets

Each Loop can open `max_cycles` Runs on one Item between your resets, 3 by default. When a Loop is about to open one more, usine opens an Ask instead: **Cycle budget exhausted** in **Needs you**, with the Item, the number of completed rounds, and the Runs of each Loop that took part. From then on, no Loop opens a Run on that Item, and the Runs already open continue. Restarts and label changes don't clear the Ask.

Look at the Item, then select **Reset cycle budget**. usine gives the Item a new allowance and polls its repository again from the start, so each active Loop that matches the Item's current state can open a Run. A paused Loop stays paused. usine doesn't post anything about the Ask on GitHub ([#36](https://github.com/basaltbytes/usine/issues/36)). [Bounded review and fix Loops](/guides/review-fix-loops/) explains how to write Loops around the budget.

## Ceilings

Two optional ceilings in `usine.yaml` stop an Attempt that runs too long, and both are off by default:

```yaml title="usine.yaml"
settings:
  max_attempt_minutes: 120
  max_attempt_tokens: 5000000
```

At 80% of a ceiling the parent gets one warning. At 100% the Attempt stops with `RunawayFailure`, which the engine never retries automatically. The minutes clock stops while a child is held, and the token count includes the parent and every child.

## Restarts

When the orchestrator stops, a running Attempt's Pi parent task stays in `.usine/durable.sqlite`. The next `usine up` reattaches the same Attempt with the same worktree, and this doesn't count as a retry. If the parent task or the worktree no longer exists, the Attempt fails with an `InfraFailure`, and the Run retries with a new Attempt, starting from the newest salvage branch if there is one.

## Stop the orchestrator

Press Ctrl+C once or send SIGTERM. usine stops starting Attempts and waits for the running ones to end: for at most `max_attempt_minutes` when that setting is present, and with no limit otherwise. The log shows `Orchestrator shutdown started`, then `Orchestrator exiting after graceful drain`.

A second Ctrl+C or SIGTERM stops the orchestrator without waiting. The Attempts still running stay recorded as open, and the next `usine up` reattaches them. Runs waiting for a Worker and pending automatic retries stay saved and continue at the next start. Start the next `usine up` only after the process has exited, because until then the instance lock prevents a second one.

## Back up and export

`usine backup` copies the runtime store and the durable storage while the orchestrator runs. Run it from the instance folder with a new file name:

```sh title="Instance folder"
usine backup /backups/factory-2026-10-16.sqlite
```

It copies `.usine/runtime.sqlite` to that path and `.usine/durable.sqlite` next to it, as `/backups/factory-2026-10-16.durable.sqlite`. Both copies have owner-only permissions. The command never overwrites a file. The target directory must exist and be on a file system that supports hard links. Keep backups outside the instance folder, and keep `usine.yaml`, the Loop and Agent files, and the credentials in their own backup.

To restore, stop the orchestrator, move `.usine/runtime.sqlite` and `.usine/durable.sqlite` aside with their `-wal` and `-shm` files, copy both files of one backup into their places, and start `usine up` with the same configuration and usine version. An older backup also contains an older record of Events, so work done after the backup can run again.

`usine export-run` writes one Run to a JSON file: its Event, effective task and Agent, revision, Step result, every Attempt, and the whole transcript, read in one transaction.

```sh title="Instance folder"
usine export-run <run id>
usine export-run <run id> --output /evidence/run.json
```

Without `--output`, the file is `run-<run id>.json` in the current directory, with characters such as `/` percent-encoded. The command opens the runtime store read-only and never overwrites a file. The Run id is at the top of the drawer's **Attempts** tab and in the URL after `?run=`. Transcripts contain repository content and tool output, so read the file before you share it.
