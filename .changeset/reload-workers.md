---
"@usine/orchestrator": minor
---

A reload applies `workers` changes without affecting running attempts. A higher `max_concurrent_attempts` preflights the new slots and lets them take waiting runs at once, a lower one retires extra slots as their attempts end, a new worker of the executor's kind takes attempts once preflight passes (the SSH composition re-adds only workers it started with), and a removed worker leaves the scheduler after its last attempt. A changed kind or setting, a renamed worker, or a new worker that the executor can't run still fails the reload with `RestartRequiredError`.

`RestartRequiredError` adds `fields` (such as `workers.build-1.destination`), `ReloadPreflightError` adds `workers` and allows empty `agents`, and `InstanceReload` adds `workers`. `CurrentInstance.registerWorkers`, which takes a `WorkerReload`, replaces `registerPreflight`, and `stepExecutorLayer` takes `StepExecutorOptions` with `startupWorkersOnly`.
