---
title: Add a local worker
description: Run child sessions on the orchestrator machine.
---

Add local capacity for attempts that can use the orchestrator machine and Unix account.

## Prerequisites

Instance admin access, an instance using local workers, Git and the rostered harnesses on the orchestrator user’s `PATH`, and credentials for those harnesses. Local agents must be trusted with that user’s files and credentials.

## Procedure

1. Check the machine has enough memory for all simultaneous attempts. Preflight requires 1.5 GiB per slot and warns below 3 GiB; repository builds can require more.
2. Open **Configuration > Workers > New** and enter a kebab-case name, such as `local-two`.
3. Choose kind `local` and set **Maximum concurrent attempts** to the capacity the machine can support. Save.
4. If preflight fails, fix the displayed capability or credential error and save again.

## Check the result

The worker appears in **Overview** and **Configuration > Workers** with passing preflight and its slot count. Waiting runs can use the added slots.

Local children run as the orchestrator user. Their checkout is under `.usine/workers/<name>/attempts/`. For another machine, [add an SSH worker](/guides/add-an-ssh-worker/). [Workers](/reference/configuration/workers/) lists connection fields and cache behavior.
