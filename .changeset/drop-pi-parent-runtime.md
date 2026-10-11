---
"@usine/agents": minor
---

Remove the Pi parent runtime, which only the run host used; the Pi parent runs in `@usine/durable`. `@usine/agents/pi/live`, `AgentRuntime`, `LaunchRequest`, `ChildSessions`, `piParentLayer`, and the subagents extension are removed. `PiStartOptions.toolMode` is removed and `PiStartOptions.model` is a required `ModelId`, since only children and preflight start Pi sessions; the `AuthenticationUnavailable` and `UnsupportedAuthentication` start results no longer carry `requiredPool`. The `typebox` dependency is dropped.
