# Each open run is an engine fiber over usine's tables; each attempt resumes through its coordinator

usine drives runs itself, with no workflow engine. Each open run is one engine fiber over usine's event, run, step, and attempt tables. The fiber waits for approval if the run is gated, reserves a worker, opens or reattaches the attempt, records the outcome, and repeats until the run closes. Approval, retry, cancel, supersede, and revoke commit through the store, then start or stop the fiber. At startup, the engine starts a fiber per open run (gated runs keep waiting) and opens the queued events of items whose run closed before its continuation ran. Run IDs hash the dedup key, so the same event joins the same run.

The hard part, resuming an agent session that a crash cut off, belongs to the attempt's coordinator behind `AttemptRuntime`:

- The Pi parent is a pi-durable task, which commits each turn and tool call.
- The event-driven coordinator commits each lifecycle event with its decision, its state, the child it starts or the outcome it records, and the envelopes it reserves, in one transaction of its attempt journal in the runtime database (ADR 0010). After a restart, `execute` resumes the open child, applies a decision recorded before its transition instead of deciding again, and reads a child's recorded outcome instead of starting another child.

A router behind `AttemptRuntime` keeps each attempt on the coordinator that started it, so the run fiber and the executor are the same for both.

A defect escaping the `StepExecutor` port becomes `DefectFailure` at the attempt boundary: the cause is kept, the attempt fails terminally, and it's never retried automatically. This avoids a run suspended forever with an open attempt, and repeated agent work after a bug.

## Considered options

- **Effect's `effect/unstable/workflow` and `effect/unstable/cluster` modules** (used until #176): crash-safe resume with deferred signals for approval, retry, and cancel. Once the attempt's coordinator resumed agent sessions, the run level was a small state machine already stored in usine's tables, and a second durable store only added commands to replay and drift to repair. The modules were also alpha and exempt from semver.
- **Self-hosted Inngest**: needs Redis next to SQL, hard-codes a 24-hour idempotency TTL against the permanent dedup guarantee, and caps HTTP-driven steps at 2 hours ([research](https://github.com/basaltbytes/usine/blob/research/engine-substrate/docs/research/inngest-oss.md)).
