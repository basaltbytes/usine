---
"@usine/durable": minor
---

The event-driven coordinator commits each `ToolStarted` and `ToolFinished` of a child together with the change to the child's in-flight tool calls, in one journal write instead of two. `AttemptJournal` adds `reserveWithProgress`, which reserves envelopes and applies a delegation's progress change in one transaction, and the `Outbox`'s `relay` takes the journal write to commit its envelopes with. `DelegationJournal.toolEvent` replaces `toolStarted` and `toolFinished`: it relays the tool event and records the change.
