---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

The `coordinator`, `parent_model`, and `parent_effort` keys are removed from agent files and from `settings` in `usine.yaml`. Every new attempt runs on the event-driven coordinator. An attempt that an earlier version started with a Pi parent session keeps that parent when an orchestrator restart reattaches it, and its transcript still shows its parent model.

usine ignores the three keys when an imported agent file or `usine.yaml` still has them, and logs a warning that names them. When usine opens the configuration store, it removes them from the stored settings and agents in one revision with the message `Removed coordinator, parent_model, and parent_effort, which usine ignores`, so no agent is quarantined because of them. Reverting a revision reads the values of earlier revisions without these keys.

Configuration saves, reloads, and startup no longer check a parent model, effort, or credential, so the `coordinator-brains` step and `ValidationTimeoutError` are removed. The configuration pages, the agent and settings forms, and the operator API's `AgentFileView` and `SettingsView` no longer show a coordinator, parent model, or parent effort.

`Agent` drops `parentModel`, `parentEffort`, and `coordinator`, and `resolveParentModel`, `resolveParentEffort`, `resolveCoordinator`, and `DEFAULT_COORDINATOR` are removed. `AttemptContext`, `Submission`, `StepExecution`, and the run snapshot drop `parentModel`, and `CheckoutRequest` drops `parentModel`, `parentEffort`, and `coordinator`. `@usine/orchestrator` removes the `/parent-admission` and `/parent-models` subpaths, `checkCoordinatorBrains`, `coordinatorBrainTimeout`, `registerParentAdmission`, and `ValidationTimeoutRefusal`.
