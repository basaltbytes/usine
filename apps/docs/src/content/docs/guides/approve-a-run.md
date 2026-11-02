---
title: Approve a run
description: Inspect a waiting run and allow its first attempt to start.
---

Approve a run that a loop requires you to inspect before execution.

## Prerequisites

A run in the waiting state and project operator access or a higher role.

## Procedure

1. Open its approval entry in **Needs attention** or select the task’s waiting run.
2. Read **Task** and **Event**, including the approval decision and saved item state.
3. Select **Approve**. If the work should not run, use [Cancel run](/guides/cancel-a-run/) instead.

## Check the result

The run becomes queued and starts when a worker slot is free. Its event records the approver, time, and channel. If the item changes before approval, a matching new state supersedes the waiting run; an item that stops matching revokes it.
