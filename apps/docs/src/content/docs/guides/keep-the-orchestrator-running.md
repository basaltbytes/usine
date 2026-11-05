---
title: Keep the orchestrator running
description: Start a detached instance and keep its machine awake.
---

Run an existing instance without keeping its terminal open.

## Prerequisites

An initialized instance on persistent storage, its credentials in the instance environment, and access as the Unix user that owns the instance.

## Procedure

1. Change to the instance folder and start the detached orchestrator:

   ```sh
   usine up --detach
   ```

2. Inspect its status and output:

   ```sh
   usine status
   tail -n 80 .usine/usine.log
   ```

3. On macOS, keep AC-powered system sleep off while work is open. Run `caffeinate -s` in another terminal, or configure the machine’s power settings. Closing a laptop lid can still cause sleep.

## Check the result

`usine status` reports the PID, version, uptime, listener, and open runs. The log updates as work proceeds. Use [a Linux server deployment](/guides/host-usine-on-linux/) for unattended operation.

Use `usine stop` to drain running attempts, and `usine restart` to restart an idle instance. `--force` interrupts the wait; the next start reattaches retained attempts. [CLI lifecycle commands](/reference/cli/) describe timeouts.

During a forced stop or upgrade restart, running attempts retain their checkouts for reattachment. Child backends treat the closing connection as an orderly stop. Codex leaves its remote supervisor and transport journals in place, and Codex and Claude Code defer session recovery to the next process. The next process resumes saved child conversations in their original checkouts and appends their events to the same attempt transcripts. A child under an operator hold remains addressable after its resumed turn ends; release the hold to return its report to the parent. Recovery uses the credential kind from the worker's latest preflight. If the saved conversation cannot be decoded, resume is unavailable, or recovery fails, the parent receives an interrupted call with its committed output. Codex, Claude Code, and Pi suppress child infrastructure failures caused by this shutdown. Unexpected connection losses while an attempt is attached retain their normal recovery and failure handling.

When a resumed child returns a report, that report replaces its pre-restart infrastructure failure. Infrastructure failures from other children still fail the attempt. When a reattached attempt delegates to a replacement child, including after a failed recovery, that child's report determines the outcome. Previous infrastructure failures remain in the transcript. If recovery fails and the parent finishes without another delegation, the stored infrastructure failure still fails the attempt.
