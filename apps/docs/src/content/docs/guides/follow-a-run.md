---
title: Follow a run
description: Find a task’s runs and read its attempts and conversation.
---

Find the work on an issue or pull request and inspect its progress.

## Prerequisites

A signed-in browser session with project viewer access or a higher role.

## Procedure

1. Open **Overview**. Select a running attempt, recent run, or Needs attention entry. Alternatively, open the project’s **Board** or **Tasks** and select its task.
2. On a task page, select a run under **Runs**. The drawer shows its item, loop, state, agent, worker, duration, and available actions. Select **Open run page** for the conversation.
3. In the attempt outline, select an attempt and expand grouped session messages. Errors, blockers, questions, operator messages, and outcomes stay visible. Error counts navigate failures; recovered counts navigate failed tool calls after which the agent continued.
4. Inspect **Task** and **Event** to compare the rendered task with its saved trigger payload. Select **Tokens** for per-session and per-pool usage and cost.

## Check the result

The selected run has a shareable drawer URL with `?run=<id>`. The run page shows its attempts, conversation, and current activity. Schedule runs appear under **Runs without a card** on the board.

## Run states

| State | Meaning |
| --- | --- |
| Pending | The run opened and is waiting for admission. |
| Waiting | An operator approval is required. |
| Queued | The run is approved and waiting for a worker slot. |
| Running | An attempt is active or another attempt is starting. |
| Waiting for CI | The session ended and checks on the recorded head are pending. |
| Succeeded | The run completed and its result is stored. |
| Handed off | A CI failure was accepted by a linked fix run. |
| Failed | The run requires an operator response. |
| Canceled | The run was canceled, superseded, or revoked. |

A task page combines its linked issues and pull requests, run history, agent comments, and reviews. In a multi-repository project, use the repository control to distinguish item numbers.

Usage includes output and uncached input tokens reported by harnesses. Subscription prices are estimates; an unavailable session price leaves the run without a complete price. [Read statistics](/guides/read-statistics/) covers task and run aggregates.

Connectivity warnings identify a silent worker or unreachable model provider and its recovery. They do not stop the attempt automatically. Inspect the warning, worker, and provider before [canceling](/guides/cancel-a-run/) or [messaging the agent](/guides/message-an-agent/).
