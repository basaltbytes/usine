---
"@usine/orchestrator": minor
---

An accepted reload evaluates new or changed schedule loops at once instead of up to a minute later. `ScheduleTriggers.run` takes the `get` and `changes` of a `CurrentInstance`, like `PollingTriggers.run`.
