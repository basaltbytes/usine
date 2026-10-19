---
"@usine/orchestrator": minor
---

An accepted reload ends the schedule sleep, so a schedule Loop that the reload adds or changes is evaluated at once instead of up to a minute later. `ScheduleTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance, as `PollingTriggers.run` does.
