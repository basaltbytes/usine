---
"@usine/agents": patch
---

A Pi child gets only Pi's default tools: `read`, `bash`, `edit`, and `write`. Before, the global Pi `defaultTools` setting could add tools such as `grep` and `find`, which run `rg` and `fd` with the orchestrator's environment and its secrets. `bash` still runs with exactly `ChildRequest.environment`.

The `Started` result of `PiSdk.start` adds `tools`, the names of the session's active tools, which the Pi child backend logs at debug level.
