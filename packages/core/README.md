# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against.

- **Event** — one deduplicated fact the engine may react to, keyed by an engine-derived, never-expiring dedup key.
- **Run** — the work a loop owes one Event; at most one open run per dedup key, ever.
- **Step** — a named unit inside a run whose stored result is addressable by name; the loop-authored name is its identity.
- **Attempt** — one try of a step on a worker; retries are new attempts under the same step, never new runs.

The run state machine (`RunState`) is typestate: `pending → waiting → running → succeeded / failed / canceled`, with `failed → running` on operator retry. Each transition function accepts only the states it is legal on, so an illegal transition is a compile error, not a runtime surprise.

The attempt-failure taxonomy (`AttemptFailure`) separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), and the runaway guard tripping (never auto-retried).

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.
