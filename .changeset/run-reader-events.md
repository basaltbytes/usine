---
"@usine/engine": minor
---

Adds `RunReader.events(runIds)`, which reads the event each run was opened for as `RunEvent` records, in one batch. The event's payload is the item as the trigger saw it.
