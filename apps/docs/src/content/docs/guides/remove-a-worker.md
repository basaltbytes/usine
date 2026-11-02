---
title: Remove a worker
description: Stop admitting attempts and retire a worker safely.
---

Remove a worker from stored configuration before deleting its machine.

## Prerequisites

Instance admin access and another configured worker of the same kind.

## Procedure

1. Open **Configuration > Workers**, select the worker, choose **Delete**, and confirm.
2. Wait for its running attempts and retained recovery work to finish. Removal stops new admissions but keeps the attempts’ original connection for cleanup.
3. For a fixed machine, delete it at its provider after confirming no retained checkout needs recovery. Provisioned workers perform a final sweep using their retained provider credentials.

## Check the result

The worker leaves the scheduler after its last attempt ends. If **Worker not configured** reports retained attempts, restore the worker for recovery or use **Discard leftovers** only after checking the consequences. Failed remote deletion remains visible in logs.
