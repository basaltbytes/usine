---
"@usine/orchestrator": minor
---

Loops, agents, and the `labels`, `repos`, `settings`, and `operator` keys of `usine.yaml` reload without a restart; new runs use the new configuration, and an open run keeps its agent. An invalid `usine.yaml` fails the reload with `FactoryConfigError`, a changed `workers` or `webhooks` block fails it with `RestartRequiredError`, and both keep the running configuration.

`@usine/orchestrator/current-instance` exports `CurrentInstance`, whose `reload` returns an `InstanceReload` of what changed, and the operator API adds `POST /api/instance/reload`. `Orchestrator.run`, `PollingTriggers.run(current)`, `ScheduleTriggers.run(current)`, `runtimeLayer(instanceDirectory)`, `triggerConditionLayer`, `gitHubCredentialLayer`, and the worker layers read the instance through `CurrentInstance` instead of taking a loaded instance.
