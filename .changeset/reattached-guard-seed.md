---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
---

A reattached Attempt's runaway guard resumes from the Attempt's transcript instead of starting over after an orchestrator restart. Its ceilings trip at the same totals as if the orchestrator had kept running, and a ceiling's 80% warning is sent at most once per Attempt.

`@usine/core`: `AttemptChannel.Sink` has `transcript`, which reads back the envelopes `append` recorded for the Attempt, in append order.

`@usine/engine`: the sink a Run's fiber passes to `StepExecutor.execute` reads `transcript` from the run tables: the Attempt's stored envelopes in the current protocol version.

`@usine/executor`: when the durable session reattaches an Attempt, it reads `Sink.transcript` and seeds the guard with each session's highest token report, finished children included. It also seeds the unsupervised time from the first recorded envelope to the last, without the stretches under a Hold. The parent's Hold stays placed if it was placed before the restart, and a warning the transcript holds is not sent again. A transcript that cannot be read is logged with `Could not read the reattached Attempt's transcript; its ceilings start over`, and the guard then starts from zero. The wall clock of every Attempt now starts once the launch has registered the Attempt's session, so a ceiling that trips at once still stops the parent task. A guard that resumes with no time left while the parent is held trips once the parent is released.
