# Graceful shutdown closes Attempt admission before runtime teardown

On the first SIGINT or SIGTERM, `usine up` stops its trigger loops, closes Attempt admission, and waits for admitted work to record its outcome before closing the runtime. The wait has a process-wide deadline of `max_attempt_minutes` measured from shutdown, regardless of individual session timers. A second signal ends the wait immediately. Deadline expiry and forced shutdown retain the existing restart recovery policy.

Admission belongs to the engine because durable workflows can start queued Runs and retry Attempts without a trigger poll. The existing RunEngine, StepExecutor, scheduler, and durable workflow were examined: the scheduler owns Worker capacity, while the workflow owns admission through outcome persistence. A private process-local admission service coordinates those lifetimes; `RunEngine.drain()` is the public operation. Closing admission and admitting an Attempt are atomic decisions. Admission stays closed even if the caller interrupts its drain wait.

An Attempt admitted before shutdown may still be recording its start when the signal arrives; it is included in the drain. Pending Worker reservations, approval gates, and subsequent retries do not count as admitted work. Their durable Runs resume after restart. The drain completes only after admitted Attempts finish execution and persist their outcomes. It does not cancel Runs or consume retry allowances.

The signal wait runs before the runtime's scope finalizers. The HTTP server and engine resources remain available while admitted work finishes. A defect still terminates the runtime; graceful drain applies to interruption. This extends the recovery behavior in ADR 0003 without changing the permanent Event ledger or Run lifecycle.
