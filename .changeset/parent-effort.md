---
"@usine/core": minor
"@usine/config": minor
"@usine/agents": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/run-host": patch
---

Author the Pi parent's reasoning effort: `settings.parent_effort` in `usine.yaml` sets the instance default and `parent_effort` in an agent file overrides it; unset keeps the parent at its child's effort. A parent model that cannot run the resolved effort fails the Attempt with `UnsupportedEffortError` before the session starts.
