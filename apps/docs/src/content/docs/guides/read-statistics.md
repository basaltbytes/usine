---
title: Read instance statistics
description: Inspect completed tasks, loop timing, usage, and worker capacity.
---

Inspect task throughput and the time and usage spent on completed work.

## Prerequisites

A signed-in session with access to the projects you want to inspect; instance admin access for worker statistics.

## Procedure

1. Open **Overview** and select a statistics window: 7 days, 30 days, or all stored runs.
2. Inspect **Tasks done**, **Time per task**, **First time right**, and **Tokens per task**. Select a task dot to open its task page.
3. Open **Details** for run outcomes, attempt duration, loop and agent totals, queue wait, worker utilization, and machine starts by UTC day.

## Check the result

The selected window updates the counts and charts. Missing timing or pricing is explained below the statistics instead of contributing an incomplete value.

A completed task has a merged pull request in the window and at least one usine run. Task time starts at its first run and ends at its last closed run, capped at merge for an open run. It excludes the later wait for a human merge. Days use UTC; windows longer than 62 days group by week.

**First time right** counts tasks without the same loop succeeding twice on one item. Operator actions include approvals, retries, resolutions, and budget resets. Subscription cost has an estimate marker. Worker utilization divides occupied attempt time by available slot-time using configuration revisions. Machine-start counts survive machine deletion and restarts.
