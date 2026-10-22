---
title: Operate Runs
description: Follow Runs in the web UI, approve, retry, cancel, edit, and run them again, steer a live Attempt, answer Needs attention, stop the orchestrator cleanly, and back up the runtime store.
sidebar:
  order: 3
---

A Run is the work that a Loop does for one Event, and each try of its Step is an Attempt. This page explains how to manage Runs in the web UI at `http://127.0.0.1:7331`, and the CLI commands that back up and export their history. Every UI action is also available as an HTTP endpoint of the operator API.

## Overview

The page at `/`, which `usine up` opens, is **Overview**. It shows, in this order:

- **Needs attention**: everything that waits for you, described [below](#needs-attention). When nothing does, it says so, and the right of its heading says when usine last finished polling each repository.
- **Running**: one row per Attempt in flight across the Projects, with the Item, Loop, Agent, Worker, start time, and last activity. A Worker that stopped answering or a child that cannot reach its provider shows as a yellow line under the Item ([Connectivity warnings](#connectivity-warnings)). When nothing runs, it says how many Worker slots are free.
- **Stalled**: each Item a Loop's trigger matches now that has no Attempt running on it, with the reason and the one action that moves it again. See [Why an Item is stalled](#why-an-item-is-stalled).
- **Recent runs**: the 10 Runs that closed last, newest first, with their outcome and pull request.
- **Workers**: one line with each Worker's slots in use and its last preflight, at startup or at a reload.

A row about a Run opens its Run page.

### Why an Item is stalled

| Reason                                                                     | Action                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| **Waiting for approval**                                                   | **Approve**                                     |
| **Question from the agent** or **Blocked by the agent**                    | **Mark answered** or **Mark resolved**          |
| **Cycle budget used, \<n\> rounds**                                        | **Reset cycle budget**                          |
| **Failed \<time\> ago**, with the failure's reason                         | **Retry**                                       |
| **Canceled \<time\> ago, unchanged since** or **Succeeded \<time\> ago, unchanged since**. A Loop opens one Run per state of an Item. | **Run again**                                   |
| **\<loop\> paused**                                                        | **Resume**                                      |
| **Waiting for a free worker slot**                                         | None; it starts when a slot frees.              |
| **Waiting for the next poll**                                              | None; the next poll acts on the Item's current state. |

A change to the Item, such as a new label or comment, is a new state, and the Loop acts on it at the next poll.

## Follow a Run

The sidebar lists the Projects. Opening one shows its Board, where each lane names the labels and Item states that route Items to it, and each card is a task: an issue and the pull requests linked to it. While a task has an open Run, or a `Failed` Run you have not resolved, its card shows that Run's Loop, state, time, and Agent, so you can see when the Run is `Waiting` for your approval or `Queued` for a free Worker. The time counts from when the Run opened, from when its current Attempt started while it is `Running`, and from the failure once it is `Failed`; hover it for the full timestamp. While a Run is `Running`, its card stays in the lane whose label triggered it, even after the Loop removes that label. When the Run ends, the card moves to the lane of the labels the Item has then, on the next poll. This also applies to a card you move while its Run runs: the labels change at once, and the card reaches its new lane when the Run ends. The card's menu button lists only what applies: it opens the task's Items on GitHub and its Run, lists the task's other Runs under **Run history**, approves, retries, or cancels the Run when its state allows, runs the task's latest Run again when it succeeded or was canceled, and moves the card to another lane under **Move to**. The Board lists Runs without an Item, such as schedule Runs, below the lanes under **Runs without a card**.

A stalled task's card says why in one line, with the same reason as **Stalled** on Overview, and shows the one action that moves it again, such as **Run again** for a Run that was canceled on an Item that has not changed since. A `Failed` Run keeps its failure note with **Retry**; for an Agent's question or blocker, the note offers **Mark answered** or **Mark resolved** instead.

The arrow between two authored label lanes names the Loops whose `if:` matches a task in the left lane now, whether or not they have a Run there, with `paused` after a paused Loop. It is blue while one of those Loops has a `Queued` or `Running` Run on the lane's tasks, and orange while their open Runs all wait for your approval. An arrow without a name means no Loop picks up work from that lane.

Every lane is in one row, empty or not: the lanes you can drag cards into first, then the read-only lanes, with **Done**, the lane of closed Items, and **Unmapped**, the lane of Items no lane routes, last. Done and Unmapped open folded into narrow rails with their name and count; select a rail to open the lane, and fold it again from its heading. **Unmapped** is where you find an issue to drag into a lane.

Clicking a card opens its task page at `/projects/<owner>/<name>/tasks/<number>`, whether or not the task has a Run. The number is the task's originating issue, or its first pull request when it has no issue; the number of any of its Items opens the same page. The page shows:

- a header with the issue's number, which links to GitHub, its title, the state of the Item that places the task in its lane, the lane, that Item's labels, and **Move to**, which moves the card as on the Board;
- **Runs**: every Run on the task's Items, newest first, `Succeeded` and `Canceled` ones included, with its state, Loop, the Item it works on, Agent, Attempts, how long its Attempts ran, when it opened, the pull request it produced, the typed reason of a failure, and who approved it or ran it again. Clicking a row opens the Run page. A Run that needs you shows **Approve** or **Retry** in its row, and the row's menu lists the other actions its state allows;
- **Pull requests**: the task's pull requests, each with its state and whether it conflicts with its base;
- **Comments and reviews**: what the Runs' Agents posted on the task's Items, with the Run that posted it and when that Run's Attempt ended. A comment appears once its Attempt succeeds.

Like the Board, the page covers the Project's 500 newest Items.

Choosing **Open run** in a card's menu, or selecting a Run in **Needs attention**, opens the Run drawer. The URL gets `?run=<run id>`, so you can share or reload it. The drawer has:

- a header with the Item and its title, the Run's state, its pull request or **No pull request**, its Loop and Agent, and a **Loop paused** note when that applies;
- once an Attempt has started, a line with the Worker the newest Attempt runs or ran on and the **Duration** of all the Run's Attempts, which counts on while one runs;
- the actions the Run's state allows;
- one summary: what an open Run waits for, what a running Attempt is doing and its latest message, or how the Run ended;
- **Open run page**, which opens the whole Run.

The drawer refreshes every second while the Run can be canceled, and the rest of the UI every 2 seconds while some Run can be canceled, or every 15 seconds otherwise.

### Read the Run page

The Run page has the same header as the drawer, and its second line adds **Tokens**: what the Run's sessions used so far, output plus uncached input, as each harness reports it. Select the number to see it per billing pool and per session under each Attempt. A pool with a dollar rate also shows the price its harness put on that usage: API keys at Pi's catalog price, and the Claude plan at the Agent SDK's price, marked **estimate** because the plan bills no dollars per token. The ChatGPT plan has no dollar rate, so it shows **No dollar rate** and never a price. A pool shows no price when one of its sessions was recorded before usine kept prices.

Beside the outline of the Task, the Event, and the Attempts sits the conversation. Each Attempt in the outline shows why it began, its start time, and how long it took:

| Line                                         | The Attempt began because                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| **From the event**                           | the Run's Event opened it; every Run's first Attempt starts this way.          |
| **Retried by \<login\>**                     | you selected **Retry**; the login is the `operator` in `usine.yaml`.           |
| **Edited and retried by \<login\>**          | you used **Edit and retry**.                                                   |
| **Retried after an infrastructure failure**  | the engine retried on its own after the previous Attempt's `InfraFailure`.     |
| **Started again after a restart**            | a restart interrupted the previous Attempt and its parent task did not survive. |

An Attempt that a restart reattached also says **Reattached after a restart**. Attempts begun before usine recorded the reason, other than a Run's first, show no line.

The Attempt being read opens to its sessions, then its checkpoints in order. Consecutive messages of one session fold into one entry, such as **developer, 14 messages**; select it to list each message by its first sentence. Blockers, questions, your messages, Worker and provider warnings, and the Attempt's outcome stay entries of their own, so they are never hidden in a fold.

Under the outline, a red count such as **2 errors** steps through what the Run ended with or what you must read: each failed Attempt's outcome, the last of which is the Run's failure, every blocker and question, a message a session refused, and a connectivity warning that is still open. Tool calls that failed while the Agent went on are counted apart in grey, such as **12 recovered**, and step through the same way. A count with **loaded** or **+** covers only the history loaded so far.

## Run states

| State       | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `Pending`   | Opened. No Attempt has started, and the Run waits for a Worker slot unless its Loop requires approval. |
| `Waiting`   | Waits for your approval.                                                                      |
| `Queued`    | Approved, and waits for a Worker slot. The drawer says **Approved, waiting for a free worker**. |
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
  Pending --> Canceled: Cancel run, superseded, or revoked
  Waiting --> Canceled: Cancel run, superseded, or revoked
  Queued --> Canceled: Cancel run, superseded, or revoked
  Running --> Canceled: Cancel run
  Succeeded --> [*]
  Failed --> [*]
  Canceled --> [*]
```

Workers take Runs in the order their Events arrived, and each Worker runs up to its `max_concurrent_attempts` at a time.

## Approve

A Loop with `approval: required` keeps each new Run in `Waiting`. The Run appears in **Needs attention** as **\<loop\>: approval needed**, and its card shows that a Run is waiting for approval. Open the Run, read its **Task** and **Event**, and select **Approve**. The Run becomes `Queued` and starts when a Worker slot is free. On the Run page, the **Event** then shows who approved the Run, when, and from where, such as **Approved by octocat · 15 Oct 19:30 · from the UI**, where the name is the `operator` login in `usine.yaml`. A Run approved before usine recorded approvers shows **Approved** without a name.

If the Item changes before you approve and still matches the Loop, a new waiting Run replaces this one, and usine cancels this one as superseded. If the Item no longer matches, usine cancels the waiting Run as revoked.

## Retry and Mark resolved

The engine retries an Attempt automatically only after an `InfraFailure`, such as an unreachable Worker or a failed checkout, and only up to three Attempts per Run. Every other failure leaves the Run `Failed` and lists it in **Needs attention** under the failure's name:

| Failure                     | Cause                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `InfraFailure`              | Infrastructure failed around the Agent, and the Run has used its three automatic Attempts.                 |
| `AgentFailure`              | A harness isn't ready on the Worker, a child's harness failed during its turn, or the parent's model, effort, or credential is unusable. |
| `BlockedFailure`            | The Agent hit a blocker it can't resolve and reported it with `[usine:blocked]`. See [Clear a blocker](#clear-a-blocker). |
| `QuestionFailure`           | The Agent needs a decision from you and asked it with `[usine:question]`. See [Answer a question](#answer-a-question). |
| `DefectFailure`             | A defect in usine at the execution boundary.                                                               |
| `RunawayFailure`            | The Attempt reached `max_attempt_minutes` or `max_attempt_tokens`.                                         |
| `ChildSessionBudgetFailure` | The parent tried to start more children than `max_children` allows.                                       |

**Retry** starts a new Attempt of the same Run, and you can retry any number of times. When an Attempt ends without success, usine commits its uncommitted changes and pushes its worktree to the branch `usine/salvage/<run>/<attempt number>` of the repository. If that push fails, the worktree stays on the Worker and the Attempt shows its path. usine never deletes a salvage branch.

The next Attempt fetches the Run's revision again: for an issue Run, the default branch as it is now, so a fix you merged after the first Attempt is in it. usine then rebases the newest salvage onto it, and the Agent's prompt names the salvage it continues from. A salvage without changes is dropped. A salvage that conflicts with the new base is left out: the Attempt starts from the base, and the first line of its conversation, **Attempt started**, names the salvage branch that keeps the earlier work.

A later Event on the same Item can open a new Run of the Loop while the failed one waits for you. usine refuses to retry the failed Run while that other Run is open, so that one Loop never runs twice on one Item; the drawer names the open Run. Retry after it closes, or cancel it first. **Edit and retry** follows the same rule.

**Mark resolved** removes a failure you have handled from **Needs attention** and from the project's status. The Run stays `Failed`, and you can still retry it. If a later Attempt fails, the Run appears in **Needs attention** again.

## Answer a question

An Agent that can't continue without your decision posts its question on the Item and ends its Attempt with `[usine:question]`. The Run fails with `QuestionFailure`, and **Needs attention** lists it as **Question from \<loop\>**, with the question. usine doesn't retry it.

While the question waits, the Loop holds the Item. The Agent's own comment changed the Item, but the Loop opens no Run for that state, so a new Run doesn't ask the same question again and use up the cycle budget. The state the Loop holds is the first one polling sees after the question. The Loop acts on the Item again when one of these happens:

- the Item changes again, for example through your reply on the issue or pull request, an edit, or a pushed commit: the new state opens a Run, and its Agent reads your reply;
- the Item stops matching the Loop and comes back, for example when you remove and add the Loop's label;
- you **Retry** the Run, or **Edit and retry** it with your answer in the task;
- you select **Mark answered** in the Run drawer: the Loop takes the newest state it saw after the question, checks the trigger against the Item again, and opens a Run for it.

An answer on GitHub only counts when it changes the Item after polling has seen the Agent's question. If the Agent asked without posting anything, or you answer within the same poll, use **Mark answered** or **Retry** instead.

## Clear a blocker

An Agent that hits a blocker it can't resolve, such as a failing baseline check or a missing permission, records the blocker on the Item and ends its Attempt with `[usine:blocked]`. The Run fails with `BlockedFailure`, and **Needs attention** lists it as **\<loop\>: blocked**, with the blocker. usine doesn't retry it.

The Loop holds the Item as it does for a question: the Agent's blocker comment opens no Run, so a new Run doesn't meet the same blocker and post it again. Once you have removed the blocker, the Loop acts on the Item again when the Item changes again, when it stops matching and comes back, when you **Retry** or **Edit and retry** the Run, or when you select **Mark resolved**, which checks the trigger against the Item's newest state and opens a Run for it.

## Edit and retry

**Edit and retry** opens an editor with the Run's task and a list of the roster's Agents. **Save and retry** replaces the task, the Agent, and the parent model that usine picks for that Agent, then retries. The change persists: every later Attempt of the Run uses it, including automatic retries, until you edit again. Each Attempt records the task and Agent it actually ran, and the Event doesn't change.

## Cancel

Select **Cancel run**, then **Confirm cancel**, to close any open Run as `Canceled`. usine stops a running Attempt and pushes its unfinished work to a salvage branch, as on a failure. The cancel holds while the Item stays as it is: polling sees the same content again and starts nothing.

To run the Loop on the Item again, make it leave the Loop and come back: remove the Loop's label, wait until usine sees the Item without it (one poll, or right away for a Board move), then add the label again. The same content then opens a new Run with a new id. A Run that usine superseded or revoked behaves the same way when the Item returns to its content. A `Failed` Run is different: it keeps its Event, and you retry it instead.

If you remove and add the label within one poll interval, polling sees only the end state and starts nothing. Use **Run again** instead.

## Run again

A `Succeeded` or `Canceled` Run has **Run again** and **Edit and run again** in its drawer, on its Run page, and in its row's menu on the task page. When it is the task's latest Run, the Board card's menu offers **Run again** too, with the Loop's name, and the card says **Opening a run…** until the new Run's drawer opens. **Run again** opens a new Run of the same Loop on the same Item content, with the Run's task and Agent, and shows the new Run. **Edit and run again** opens the task and Agent editor first; **Save and run again** starts the new Run with your changes. The Run you ran again stays as it ended, and both Runs are in the Item's Run history.

The new Run follows the Loop file as it is now: it waits for your approval when the Loop requires approval, and it counts against the Item's cycle budget. When the budget is used up, no Run opens, the drawer or the card says so, and the Item's cycle budget appears in **Needs attention**. usine refuses to run a Run again while another Run of the Loop is open on the Item. The Event section of the new Run's page shows who ran it again, when, and from which Run; that Run's short id opens its page.

After a Run again, polling the unchanged Item still starts nothing. A Run again works on a paused Loop too.

## Steer a live Attempt

While a Run is `Running`, the drawer has a message box under the parent's conversation, **Message the parent**, and one in each live child's section, **Message this child**. usine sends your message to the session through the Attempt's live channel and adds it to the transcript, with the `operator` login from `usine.yaml`, or `local operator`, as the sender. It never becomes an Event, and the Attempt gets an **Operator intervened** badge.

| UI control              | To the parent                                                                       | To a child                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Send** a message      | Places a Hold. A waiting or paused parent starts its next turn with the message. A parent waiting on a child reads it when the child returns. After it answers, the parent waits for you instead of ending the Attempt. | Goes into the child's conversation and places a Hold: the parent receives the child's answer only after you release it. |
| **Pause session**       | Stops the current turn, children included. The parent waits until you send a message or release it. | Pauses the child at its next tool or model call, until you send a message.                    |
| **Release parent** / **Release child** | Shown while the parent is held or paused. Ends the Hold and the pause: a waiting parent continues the task, and a working parent ends the Attempt with its next answer. | Ends the Hold, so the parent receives the child's answer once the child is idle.               |

To take over a live session, send it messages: you work in the session as a user would. A held child returns to the parent only after you release it, and a held parent ends the Attempt only after you release it. You can hold several sessions at once. While a session is held, the `max_attempt_minutes` clock stops; tokens still count toward `max_attempt_tokens`.

A message to a parent that is waiting on a child shows **Queued until the current delegation returns** under it, in the conversation and in the drawer, until the parent reads it. If you pause the parent first, the message shows **Not delivered**; send it again to resume the parent with it.

A message to a child that is working shows **Queued until the child's current step ends** until the child reads it, and the child is not shown as resumed, since it never stopped. A Pi child reads it before its next model request, a Codex child before its next model request in the same turn, and a Claude Code child when a tool call returns or as its next turn. If the child stops before it reads the message, the message shows **Not delivered**.

The API has one more action, `Steer`, which adds guidance to the parent or a child without a Hold. The runaway guard sends one `Steer` from the operator `engine` when an Attempt reaches 80% of a ceiling. All four actions use `POST /api/runs/<run id>/intervene`. usine refuses an action when the Run isn't `Running`, when the Attempt is no longer the Run's latest, or when the session isn't live in this process (for example, before a restarted orchestrator reattaches the Attempt). The drawer shows the error. When the session itself refuses an action, such as a message to a child that has already returned, the refusal appears in the conversation. When the parent's last turn answered you and the Attempt has no commit, pull request, or comment to show, the Attempt fails with the parent's answer instead of succeeding, so you decide what happens next.

For a Claude Code or Codex child, the terminal icon beside the child in the outline shows its saved session id, its worktree, and a **Resume this session** command to run in your own terminal. For a local worker, the command is `cd -- '<worktree>' && claude --resume '<id>'`, or `codex resume -- '<id>'` for Codex. For an ssh worker, the same command runs over `ssh -t <destination>`, with `-p <port>` when the worker's entry in `usine.yaml` sets `port`, and the worktree line names the worker. When `usine.yaml` no longer declares the attempt's worker, the block shows the local form and says so. The command resumes the session under the harness login the attempt used, and works only while the worktree exists. Attempt cleanup removes the worktree.

## Needs attention

**Needs attention**, first on Overview and at the top of every other page, lists what is waiting for you. Selecting an entry about a Run opens its drawer. While you approve or cancel a waiting Run from any page, its entry's buttons are disabled and show the action in progress, such as **Approving…**. An entry about a Run leaves as soon as usine accepts an action on that Run. If the Run had already moved on, for example because you approved it in the drawer first, the entry's **Approve** shows no error and the entry leaves when the page refreshes; the drawer and the Run page say why usine refused the action.

| Entry                                  | Meaning                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **\<loop\>: approval needed**          | A Run is in `Waiting`. Approve or cancel it.                                                                         |
| A failure name, such as `AgentFailure` | A Run is `Failed`. Read the Attempt, then **Retry**, **Edit and retry**, or **Mark resolved**.                       |
| **Question from \<loop\>**             | An Agent asked you a question and its Loop holds the Item. [Answer it](#answer-a-question).                          |
| **Cycle budget exhausted**             | An Item reached a Loop's `max_cycles`. Inspect it, then **Reset cycle budget**.                                      |
| An error name from polling             | A repository's poll failed, for example on a GitHub error, a missing App permission, or an `if:` that fails to evaluate. |
| **Label preflight failed**             | usine couldn't create a label that `usine.yaml` declares.                                                            |
| **Item projection quarantined**        | usine couldn't place an Item on its Board.                                                                           |
| A schedule error                       | A schedule Loop couldn't evaluate or submit a tick.                                                                  |
| **Loop quarantined**                   | A Loop file failed to load and opens no Runs. Fix the file and reload the configuration.                             |
| **Agent file not loaded**              | An Agent file failed to load and isn't in the roster. Fix the file and reload the configuration.                    |
| **Worker not configured**              | Attempts are recorded on a Worker that `usine.yaml` no longer declares, so startup doesn't reconcile them. Declare the Worker again and restart `usine up`, or **Discard leftovers**. While Attempts still run on a Worker a reload removed, the entry says how many and offers **Discard leftovers** once they end. |

## Cycle budgets

Each Loop can open `max_cycles` Runs on one Item between your resets, 3 by default. When a Loop is about to open one more, usine opens an Ask instead: **Cycle budget exhausted** in **Needs attention**, with the Item, the number of completed rounds, and the Runs of each Loop that took part. From then on, no Loop opens a Run on that Item, and the Runs already open continue. Restarts and label changes don't clear the Ask.

Look at the Item, then select **Reset cycle budget**. usine gives the Item a new allowance and polls its repository again from the start, so each active Loop that matches the Item's current state can open a Run. A paused Loop stays paused. usine doesn't post anything about the Ask on GitHub ([#36](https://github.com/basaltbytes/usine/issues/36)). [Bounded review and fix Loops](/guides/review-fix-loops/) explains how to write Loops around the budget.

## Ceilings

Two optional ceilings in `usine.yaml` stop an Attempt that runs too long, and both are off by default:

```yaml title="usine.yaml"
settings:
  max_attempt_minutes: 120
  max_attempt_tokens: 5000000
```

At 80% of a ceiling the parent gets one warning. At 100% the Attempt stops with `RunawayFailure`, which the engine never retries automatically. The minutes clock stops while a child is held, and the token count includes the parent and every child. The **Tokens** figure on the Run page counts the same way, added up over all the Run's Attempts.

## Connectivity warnings

When an Attempt's Worker stops answering, or one of its children can't reach its model provider, the Run page's conversation shows a yellow line and the orchestrator logs a warning. Nothing stops the Attempt: it keeps running until it finishes, you cancel it, or a ceiling you set trips.

- **\<worker\> silent since \<time\>**: while Attempts run on an `ssh` or `exe.dev` Worker, usine runs `true` on the Worker's machine over a new SSH connection every minute, one probe for all of them, and this probe got no answer within 45 seconds. The line appears in the conversation of every Attempt on that Worker. The line says when the Worker last answered and what the probe saw. **\<worker\> answering again** follows when a probe gets through. An Attempt that starts while the Worker is silent gets the line as soon as it starts, with what the last probe saw, and never gets **answering again** without it.
- **Provider unreachable**: a Codex child reported `Reconnecting...`, or a Claude Code or Pi child reported an API retry. A child's consecutive retries share one line, with the count so far and the harness's latest message. **Provider reachable again** follows when the child's turn goes on.

While a warning is open, the current activity at the end of the conversation and in the Run drawer says what hasn't answered and since when. Needs attention doesn't list these warnings.

## Reload the configuration

Select **Reload configuration** on any **Configuration** page to apply edits to Loops, Agents, and `usine.yaml` without stopping the orchestrator. `POST /api/instance/reload` and `SIGHUP` do the same. Running Attempts continue, and an open Run keeps the Agent it was opened with, also when you retry it. **Edit and retry** offers the Agents of the reloaded roster. New Runs use the new configuration. Some `workers` changes and any `webhooks` change still need a restart. [Run a factory](/guides/#change-the-configuration) describes what a reload applies.

## Restarts

When the orchestrator stops, a running Attempt's Pi parent task stays in `.usine/durable.sqlite`, and its worktree stays on its Worker. The next `usine up` reattaches the same Attempt with the same worktree, and this doesn't count as a retry. The reattached Attempt keeps the time and tokens it used toward `max_attempt_minutes` and `max_attempt_tokens`, so the restart gives it no new allowance and no second 80% warning. If you lowered a ceiling below what it already used, it stops as soon as it's reattached, and if it already used 80% of the lowered ceiling, the parent gets its warning once it's reattached. The time the orchestrator was stopped doesn't count. Each time it stops without shutting down, for example on a crash, up to the last 30 seconds the Attempt ran before then don't count either, so the Attempt can run up to 30 seconds past its ceiling per crash. If usine can't read the time or tokens the Attempt already used, it doesn't reattach the Attempt with a new allowance: it stops the parent task, salvages the worktree, and fails the Attempt with an `InfraFailure` that says what couldn't be read, and the Run retries with a new Attempt that starts from the salvage. If the parent task or the worktree no longer exists, the Attempt fails with an `InfraFailure`, and the Run retries with a new Attempt, starting from the newest salvage branch if there is one. When the parent task stops after the start but before its Run gets a Worker, or usine can't read whether it's still live then, usine stops it and salvages the worktree first, so the new Attempt starts from that salvage. If usine can't confirm that the parent task stopped, it leaves the worktree alone and starts no new Attempt, and the log shows `Could not confirm that the parent task of an Attempt its Run does not reattach stopped`. It tries again at its next reconcile, every three minutes, and reattaches the Attempt instead if the parent task is still live. Canceling a Run whose Attempt waits for its reattachment also salvages the worktree and removes it, as long as usine hasn't taken the worktree over again. If the reattachment fails before then, for example because the Attempt's credential can't be issued, usine salvages the worktree before the new Attempt starts, and that Attempt starts from the salvage.

At each start, usine also checks every Worker that `usine.yaml` declares for checkouts that earlier Attempts left: it salvages the unfinished work of a failed or canceled Attempt and removes the checkout of a succeeded one. It skips the Attempts recorded on a Worker that `usine.yaml` no longer declares, for example after you replace the `local` Worker with an SSH Worker. The log has one warning per start with their count and the Workers, and **Needs attention** shows **Worker not configured** for each such Worker. Their checkouts stay where they are. Declare the Worker again and restart `usine up` to reconcile them, or select **Discard leftovers**, then **Confirm discard**, to stop tracking them. Discarding changes nothing on the Worker, so remove its checkouts yourself if you no longer need them. A Worker you declare again later only reconciles the Attempts recorded after the discard. After a reload removes a Worker, its running Attempts finish first: until they end, the entry says how many still run, such as `2 attempts still run on it; discard its leftovers once they end`, and usine refuses a discard with that count.

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

`usine export-run` writes one Run to a JSON file: its Event, its approval, effective task and Agent, revision, Step result, every Attempt, and the whole transcript, read in one transaction.

```sh title="Instance folder"
usine export-run <run id>
usine export-run <run id> --output /evidence/run.json
```

Without `--output`, the file is `run-<run id>.json` in the current directory, with characters such as `/` percent-encoded. The command opens the runtime store read-only and never overwrites a file. The Run id is at the top of the drawer's **Attempts** tab and in the URL after `?run=`. Transcripts contain repository content and tool output, so read the file before you share it.
