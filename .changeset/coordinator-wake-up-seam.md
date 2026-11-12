---
"@usine/durable": patch
---

The event-driven coordinator gives its `WakeUp` handler the attempt ID, the event's journal sequence, the stored `RunSpec`, and an effect that returns the attached `AttemptRequest`, so a model handler can open a session on the attempt's worker with the agent's brain. A recorded decision names its handler `rule`, `completion`, or `session`, and a model's decision also records the brain, credential route, billing pool, and usage of its model call. A cancel interrupts a running handler. A model can no longer answer an interrupted child: the interruption's rule always applies, so an interrupted child that left no report can't complete the attempt.
