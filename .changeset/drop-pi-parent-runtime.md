---
"@usine/agents": minor
---

Removes the Pi parent runtime, which runs in `@usine/durable`: `@usine/agents/pi/live`, `AgentRuntime`, `LaunchRequest`, `ChildSessions`, `piParentLayer`, the subagents extension, and the `typebox` dependency. Removes `PiStartOptions.toolMode`, makes `PiStartOptions.model` a required `ModelId`, and removes `requiredPool` from the `AuthenticationUnavailable` and `UnsupportedAuthentication` start results.
