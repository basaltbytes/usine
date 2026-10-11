---
"@usine/engine": minor
---

Drive Runs from the engine instead of an Effect workflow. Each open Run has one fiber in the orchestrator process that parks it for approval, reserves a Worker, opens or reattaches its Attempt, and records the outcome, with usine's run tables as the only durable state. At startup the engine starts a fiber for every open Run, where a Run waiting for approval stays parked, and opens the queued Events of an Item whose Run closed before its continuation ran. Approval, retry, cancel, supersede, and revoke behave as before.

Upgrading an instance drops `usine_workflow_commands` and the `cluster_messages`, `cluster_replies`, and `cluster_migrations` tables from `.usine/runtime.sqlite` on the next start. No Run is driven by the workflow after the upgrade: a Run that was running when the orchestrator stopped goes through the same startup recovery as any restart, and reattaches its Attempt when the parent task is still live. Run ids keep their values, so an Event still joins the Run it opened before the upgrade.

`layerWithDatabase` takes a layer that provides `RunDatabase` alone; the Effect `SqlClient` was only for the cluster tables. The deployment still supplies `Crypto`, which now hashes dedup keys into Run ids.
