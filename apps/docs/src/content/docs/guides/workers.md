---
title: Manage workers
description: Add capacity, connect gateways, and check or remove workers.
---

Workers run the child sessions of attempts. Choose where they run, configure their connections, and verify their capabilities before assigning work.

## Remote child recovery

On Linux workers, Claude Code and Codex run under a shared process owner. An SSH interruption reconnects to the running child and replays unacknowledged input. The owner deduplicates that input and keeps output in journals beside the checkout. An environment change replaces the retained child after confirming that it stopped.

Child environment values, including gateway caller tokens, travel over SSH stdin. SSH and container command arguments exclude those values during launch, reconnection, and cleanup. The worker stores only a hash of the exported environment for reattachment checks.

Orchestrator heartbeats renew a two-minute lease. When the lease expires, the worker stops the child with TERM, then KILL if it has not exited within five seconds. Boot IDs and process start times prevent stale PID files from identifying an unrelated process after a worker restart. The worker programs ship with usine; workers need Node.js and their harness binaries.

## Add capacity

1. [Add a local worker](/guides/add-a-worker/)
2. [Add an SSH worker](/guides/add-an-ssh-worker/)
3. [Add a Boat worker](/guides/add-a-boat-worker/)
4. [Add a Hetzner worker](/guides/add-a-provisioned-worker/)
5. [Run attempts in Cloudflare sandboxes](/guides/cloudflare-sandboxes/)

## Connect and maintain workers

1. [Configure a gateway](/guides/configure-a-gateway/)
2. [Connect Boat to a gateway](/guides/connect-boat-to-a-gateway/)
3. [Run worker preflight](/guides/run-worker-preflight/)
4. [Remove a worker](/guides/remove-a-worker/)
