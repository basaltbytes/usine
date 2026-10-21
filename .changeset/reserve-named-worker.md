---
"@usine/engine": minor
"@usine/orchestrator": patch
---

`StepExecutor.reserve` takes a second argument, `worker: Option<WorkerName>`. With a Worker, the lease comes from that Worker only, and the reservation waits while none of its slots is free. The orchestrator's scheduler serves a reservation that names a Worker before the reservations that name none, and a reservation that waits for a full Worker does not hold up the Runs behind it that another Worker can take. A reservation that names a Worker `usine.yaml` does not declare logs `Run waits for a slot on the Worker its reattached Attempt runs on, which usine.yaml does not declare; it waits until a reload declares that Worker again or the Run is canceled` at warning. A canceled reservation leaves the scheduler's queue.
