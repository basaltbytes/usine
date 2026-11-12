---
title: Read instance statistics
description: Inspect completed tasks, loop timing, usage, and worker capacity.
---

Inspect task throughput and the time and usage spent on completed work.

## Prerequisites

A signed-in session with access to the projects you want to inspect; instance admin access for worker statistics.

## Procedure

1. Open **Overview** and select a statistics window: 7 days, 30 days, or all stored runs.
2. Inspect **Tasks done**, **Time per task**, **First time right**, **Tokens per task**, and **Models**. Select a task dot to open its task page.
3. Open **Details** for run outcomes, attempt duration, loop and agent totals, queue wait, worker utilization, and machine starts by UTC day.

## Check the result

The selected window updates the counts and charts. Missing timing or pricing is explained below the statistics instead of contributing an incomplete value.

A completed task has a merged pull request in the window and at least one usine run. Task time starts at its first run and ends at its last closed run, capped at merge for an open run. It excludes the later wait for a human merge. Days use UTC; windows longer than 62 days group by week.

Open statistics refresh at UTC midnight, including expanded **Details**. The 7-day and 30-day windows advance automatically, so tasks and runs outside the selected window leave the counts and charts.

**First time right** counts tasks without the same loop succeeding twice on one item. Operator actions include approvals, retries, resolutions, and budget resets. Subscription cost has an estimate marker. Worker utilization divides occupied attempt time by available slot-time using configuration revisions. Machine-start counts survive machine deletion and restarts.

A review round is a loop's nth successful run on one of the task's items, as for cycle budgets. A task passes the first review when no loop succeeded twice on one of its items; that is the same test as **First time right**.

**Models** compares the models of the agent that ran the first attempt on the most tasks, usually the developer agent. It uses the same figures as the **Models** section of an agent page; see [Compare models](/guides/write-an-agent/#compare-models). `GET /api/statistics` returns the comparison for every agent in `agents`. Reviews that an operator overturns after a reviewer passed them are not recorded yet, so they are not counted.

Beside **First time right**, memory-kill statistics count killed processes, affected attempts, and attempts with more than one kill. The line is hidden when the window has no memory kill. They cover all attempts of tasks merged in the selected window, including successful attempts. Open tasks and tasks merged outside the window do not contribute. Open an affected task's run to inspect the killed processes.
