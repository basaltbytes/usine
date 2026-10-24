---
"@usine/engine": minor
---

The engine drives runs instead of an Effect workflow: each open run has one fiber in the orchestrator, and usine's run tables are the only durable state. Approval, retry, cancel, supersede, and revoke behave as before.

On the next start after the upgrade, the orchestrator drops `usine_workflow_commands`, `cluster_messages`, `cluster_replies`, and `cluster_migrations` from `.usine/runtime.sqlite`. A run that was running at shutdown goes through normal startup recovery, and run ids keep their values. `layerWithDatabase` takes a layer that provides only `RunDatabase`; the deployment still provides `Crypto`, which hashes dedup keys into run ids.
