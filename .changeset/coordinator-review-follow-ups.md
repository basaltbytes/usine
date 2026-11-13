---
"@usine/durable": minor
---

The event-driven coordinator ends an attempt with `InfraFailure` when a stored state, decision, or delegation outcome no longer decodes, and logs the attempt ID and the record, instead of stopping on a defect. A child whose launch hadn't returned when the orchestrator stopped resumes its saved conversation if available. If no conversation was saved or the harness cannot reopen it, the child launches fresh in its slot without a `SessionFinished` or `ChildInterrupted` for the unfinished launch, or a spent budget slot. Kept Worker notices stay kept until the transition that reserves `Started` commits.

The SQLite attempt journal reserves and acknowledges envelopes with targeted statements, without loading the attempt's snapshot. The coordinator drops an attempt's in-process state once the attempt completes, fails, or is canceled, and the sink received its last envelope.

`@usine/durable/coordinator/journal` adds the `Launched` progress change and the `ChildProgress.launched` field, which reads as `true` for progress stored before it. The coordinator no longer has a budget event, because each transition numbers its child within the child-session budget.
