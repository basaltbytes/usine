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
4. Read the attempt details for the worker, the parent model, and each child's harness, model, and effort. An attempt that runs without a parent session shows **No parent session** instead of a parent model.
5. Expand **Prompt received by** in the attempt details to read the exact initial prompt sent to a child. Each child receives the rendered loop task unchanged, followed by the standard completion instructions; parent context appears separately. These disclosures appear for attempts recorded with child prompts.
6. Inspect **Task** and **Event** to compare the rendered task with its saved trigger payload. Select **Tokens** for per-session and per-pool usage and cost.

## Check the result

The selected run has a shareable drawer URL with `?run=<id>`. The run page shows its attempts, conversation, and current activity. Schedule runs appear under **Runs without a card** on the board.

The conversation follows new activity until you scroll away or inspect a tool. Scroll to the latest row or select **Jump to latest** to resume following. Scrolling past a tool output's end resumes following when the conversation reaches the latest row, including when the browser delays scrolling. Other interactions and incoming activity preserve a paused reading position.

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

Polling retries GitHub HTTP 502, 503, and 504 responses and GraphQL server errors up to twice, with jittered delays of approximately one and three seconds. This includes CI check runs, commit statuses, job metadata, and log archives. Each retry logs a warning with the operation and error tag. HTTP failures also include the response status. Other HTTP errors return immediately, and rate-limit responses delay polling as before.

Open-issue checks retry GraphQL server errors even when the same response reports deleted issues as `NOT_FOUND`. Permission and validation errors fail immediately, including in responses that also contain server errors.

GitHub request failures appear in **Needs attention** after three consecutive failed repository poll cycles in the running process. This includes snapshot requests that exhaust their retries: the affected items retry in the next cycle while other items continue. Persisted CI waits continue to report observation failures after you remove their repository from configuration. A successful cycle clears the entry and resets the count; rate-limit pauses do not increment or reset it. Configuration, expression, and persistence failures appear immediately. GitHub poll failures include the failed operation, such as `poll-repository-changes`. Invalid responses also show the decode detail, limited to 500 characters. The corresponding error log includes structured `operation` and `detail` fields when available. Use these diagnostics to identify the GitHub call and the response field that failed to decode.

Open-issue checks run at most once every 10 minutes after a successful check. Failed checks retry on the next poll cycle, respecting GitHub's backoff, so repeated failures appear in **Needs attention** until the check succeeds. A rate-limited open-issue check preserves the failure count and any existing entry until polling resumes.

A GitHub server error (HTTP 5xx) for one item's snapshot doesn't fail the poll. usine logs a warning with the item, operation, and status, processes the other items, and fetches that item again in the next poll.

Memory warnings below an attempt's outcome show the total processes killed across its containers and the last affected container's memory limit. Available process details list kernel task names and host PIDs, up to 20 per attempt. These names can be truncated and exclude command-line arguments. A separate count identifies kills without process details, including older records and workers without readable kernel logs. A successful attempt can still have memory kills when its build or test subprocesses died.
