---
"@usine/core": minor
"@usine/durable": minor
"@usine/engine": minor
"@usine/executor": minor
---

A reattached Attempt's runaway guard resumes where it stopped instead of starting over after an orchestrator restart. Its ceilings trip at the same totals as if the orchestrator had kept running, and a ceiling's 80% warning is sent at most once per Attempt.

`@usine/core`: `AttemptChannel.Sink` has `transcript`, which reads back the envelopes `append` recorded for the Attempt, in append order.

`@usine/engine`: the sink a Run's fiber passes to `StepExecutor.execute` reads `transcript` from the run tables: the Attempt's stored envelopes in the current protocol version.

`@usine/durable`: `AttemptRuntime.recordUnsupervised` keeps the unsupervised time an Attempt's runaway guard counted with the Attempt's durable record, and `AttemptRuntime.unsupervised` reads it back. The kept time never goes back. The stub runtime keeps it in `StubStorage.unsupervised`.

`@usine/executor`: a guard with a wall-clock ceiling records the unsupervised time it counted through `AttemptRuntime.recordUnsupervised` every 30 seconds while that time grows, and once more when it stops, within a five-second grace. When the durable session reattaches an Attempt, it seeds the guard with that time, so the quiet time before a restart counts and the time the orchestrator was stopped does not. Each time an orchestrator stops without shutting down, the Attempt's clock loses at most the 30 seconds since the guard's last record. From `Sink.transcript` it seeds each session's highest token report, finished children included. The parent's Hold stays placed if it was placed before the restart, and a warning the transcript holds is not sent again. The reattachment reads only what its armed ceilings use. When its transcript or its unsupervised time cannot be read, the guard does not start over: the parent task is canceled, the checkout is salvaged and the salvage recorded, and the Attempt fails with an `InfraFailure` (`Could not read the reattached Attempt's transcript, which its runaway guard resumes from`, or `unsupervised time`), so the Run's next Attempt starts from the salvage. The wall clock of every Attempt now starts once the launch has registered the Attempt's session, so a ceiling that trips at once still stops the parent task. A guard checks the restored token total as it starts, so an Attempt whose transcript already reached a lowered token ceiling trips at once and one past 80% of it gets its warning, without waiting for another usage report. A Hold stops the wall clock when its receipt arrives, also while the guard is delivering its warning, and a guard that resumes with no time left while the parent is held trips once the parent is released.
