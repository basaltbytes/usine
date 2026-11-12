---
title: Retry a failed run
description: Retry a failed attempt, optionally changing its task or agent.
---

Start another attempt in an existing failed run after fixing its cause.

## Prerequisites

A failed run and project operator access or a higher role. Inspect its failure and worker preflight before retrying.

## Procedure

1. Open the failed run from **Needs attention** or its task’s run list.
2. Read the attempt outcome. Fix infrastructure, harness, or credential failures before continuing. A question or blocker needs [an operator answer](/guides/answer-an-agent/).
3. Select **Retry** to retain the effective task and agent. To change either, select **Edit and retry**, edit the task or choose a rostered agent, and select **Save and retry**. Selecting the same agent uses its current definition.
4. If **Cycle budget exhausted** prevents new work on the item, inspect the admitted rounds in **Needs attention** before selecting **Reset cycle budget**.

## Check the result

A new attempt appears in the same run. The event stays unchanged. Edited task and agent definitions apply to all later attempts until another edit. A salvage branch, when available, supplies the prior attempt’s work.

The engine automatically retries infrastructure failures up to three attempts per run. A CI wait that times out or ends with partly run CI also records an infrastructure failure, but isn't retried automatically: rerun or fix the CI, then retry the run. When CI didn't finish and a rerun on the same head passes, select **Apply CI labels** in **Needs attention** to apply the wait's completion labels without another attempt; see [Review and fix loops](/guides/review-fix-loops/#apply-the-completion-labels-after-a-rerun). Agent failures, internal encoding defects, runaway limits, child-session budget failures, questions, and blockers require operator action. A retry uses the existing run’s cycle-budget reservation.

If the parent task cannot be confirmed stopped, its checkout and worker slot remain reserved. Wait for reconciliation or restore access to the worker; starting duplicate work does not release that slot.
