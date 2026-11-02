---
title: Cancel a run
description: Stop open work and preserve its changes for recovery.
---

Cancel an open run and stop its attempt.

## Prerequisites

An open run and project operator access or a higher role.

## Procedure

1. Open the run drawer or run page and inspect the active attempt.
2. Select **Cancel run**, then **Confirm cancel**.
3. If the response says the parent task could not be stopped, restore the worker connection and check **Needs attention**. Reconciliation retries the stop every three minutes.

## Check the result

The run closes as canceled after its attempt stops. Writable attempts push recoverable work to a salvage branch before cleanup. If a stop is unconfirmed, the checkout and slot remain reserved until reconciliation succeeds.

Polling unchanged item content starts no replacement run. Use [Run again](/guides/run-again/) for succeeded or canceled work, and **Retry** for failed work. Canceling a succeeded or failed run preserves its outcome and returns a conflict.
