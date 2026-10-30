# Graceful shutdown closes attempt admission before runtime teardown

On the first SIGINT or SIGTERM, `usine up` stops its trigger loops, closes attempt admission, and waits for admitted work to record outcomes before closing the runtime. The process-wide deadline is `max_attempt_minutes` after shutdown, regardless of session timers, or none if no ceiling is set (the default since the ADR 0013 amendment of 2026-09-18). A second signal ends the drain at once. Expiry and forced shutdown fall back to restart recovery.

Admission is the engine's job: durable workflows start queued runs and retry attempts without polls. The scheduler manages worker capacity; the workflow manages admission through outcome persistence. A private, process-local admission service coordinates them; `RunEngine.drain()` is the public wait. Hosts may pass a fresh `RunEngineShutdown` Deferred before building the runtime, whose completion closes admission synchronously, even in startup recovery; otherwise the engine makes its own latch. The latch is the only admission state; the service brackets acquire, use, and release through outcome persistence. Closing and admitting are atomic, and interrupting the wait doesn't reopen admission.

An admitted attempt still recording its start at shutdown is drained. Pending reservations, approval gates, and later retries aren't admitted; their runs resume after restart. The drain ends when admitted attempts store outcomes; it cancels no runs and uses no retries.

The server registers signal observers before building the runtime. Startup and triggers run in supervised fibers outside the runtime scope, so the shutdown timer starts before awaiting trigger finalizers. If startup finishes after a shutdown request, triggers never start. Force and deadline interrupt startup and close resources alongside trigger cleanup. The grace wait is bounded, and ordinary finalizers still run before exit. The signal wait precedes the runtime's scope finalizers, so the HTTP server and engine stay up while admitted work finishes. Defects still terminate the runtime; the drain covers interruption. This extends ADR 0003's recovery, leaving the event ledger and run lifecycle unchanged.


## Amendment (2026-10-30, #783): cancellable idle upgrade admission

Process shutdown retains its permanent admission latch. Idle upgrades use a separate process-local gate through `RunEngine.waitForUpgrade(target)`. Both gates interrupt pending reservations and release acquired slots before waiting. Admission starts only after a reservation completes, and tracks the attempt through outcome persistence. Already admitted attempts continue.

`cancelUpgrade` reopens the upgrade gate and wakes deferred runs; a completed shutdown latch still denies admission. The upgrade controller serializes cancellation with the transition to installation, interrupts its drain wait before reopening the gate, and rejects cancellation after installation starts. It suppresses automatic requests for the canceled version until a newer version appears or the process restarts; manual requests remain available.

`upgradeDrain` reports the pending version, its start time, and deferred run IDs. Operator projections read it without changing durable run states or consuming attempts. The drain logs one warning with its target version and deferred-run count when it starts. Overview adds an attention entry after ten minutes with deferred runs.
