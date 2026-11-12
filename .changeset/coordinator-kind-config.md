---
"@usine/core": minor
"@usine/config": minor
"@usine/durable": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Configuration selects what coordinates an attempt. The `coordinator` setting in `usine.yaml` takes `session`, the default, where a Pi parent session coordinates the attempt, or `events`, where the event-driven coordinator applies rules to the attempt's lifecycle events with no parent session. An agent file's `coordinator` overrides the instance setting, and the scheduler resolves it when each attempt launches. Startup, reloads, and saved edits check the parent brain only of agents that resolve to `session`, so an instance whose agents all resolve to `events` starts without a Pi credential and quarantines no agent. Imports, reloads, and saved edits refuse `parent_model` or `parent_effort` in the same agent file or `settings` block as `coordinator: events`, with the field path in the problem. An agent file also accepts an optional `decision` with a `model` and an `effort` for its decision sessions, which run on the agent's own harness; no behavior reads it yet.

`ParentKind` (`pi` or `none`) is now `CoordinatorKind` (`session` or `events`), and `RunSpec.parent` is now `RunSpec.coordinator`, which decodes as `session` for attempts stored without it. A fourth attempt journal migration rewrites a stored `RunSpec.parent` of `pi` or `none` as `session` or `events`. `Agent` adds the optional `coordinator` and `decision` (`DecisionBrain`), and `resolveCoordinator` returns the agent's kind, else the instance setting. `CheckoutRequest.coordinator` carries the resolved kind into the `RunSpec`. In the operator API, `SettingsView.coordinator`, `AgentFileView.coordinator`, and `AgentFileView.resolvedCoordinator` report the setting. The web configuration pages show the coordinator of the instance and of each agent and edit it in the settings and agent forms; an agent on `events` shows no parent model or effort.
