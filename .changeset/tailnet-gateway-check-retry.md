---
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

A provisioned machine on a tailnet checks that it reaches the gateway up to three times, 13 seconds each, with the machine poll interval between tries, before usine deletes the machine. A boxd machine reaches the gateway only through Tailscale's relays, so the first request after a join can time out while the relay path comes up.

When a check fails during machine creation, the worker's preflight shows the failure until a machine creation succeeds. That success now restores the worker's earlier preflight result on **Workers** and in `/api/desk`, instead of leaving the worker `Failed` while attempts run on it.
