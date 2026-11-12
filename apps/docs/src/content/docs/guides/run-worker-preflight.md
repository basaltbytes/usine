---
title: Run worker preflight
description: Check worker tools, credentials, and capacity after a repair.
---

Recheck a running worker after fixing a connection, login, or package.

## Prerequisites

Instance admin access and a worker with no running attempt or other preflight.

## Procedure

1. Open **Configuration > Workers** and select the worker.
2. Read its last check results and fix each failing capability on the worker or in its stored connection.
3. Select **Run preflight** and inspect the updated checks and remediation messages.

## Check the result

A passing preflight restores scheduling and updates the recorded check time. A failed check blocks new attempts on that worker and appears in **Needs attention**. Other workers continue. **Preflight findings** lists gaps that don't block attempts, such as a kernel log that the SSH user can't read, which leaves memory kills without process names.

Preflight checks tools and credentials and pulls the SSH attempt image. It does not install harnesses. Provisioned workers defer machine and harness checks until a machine is available. [Workers](/reference/configuration/workers/) describes the checks and limits.

Codex preflight checks the worker's CLI version against the generated app-server protocol baseline, 0.164.0. Versions 0.159.0 through 0.159.3 remain accepted so existing worker images can upgrade. A newer Codex version fails the version check before any account request or agent work. Install a supported version on the worker to restore scheduling.
