---
"@usine/agents": patch
---

Build the child process owner and lifeline from TypeScript into self-contained Node programs. Add direct worker lifecycle tests for input replay, lease expiry, stale process identities, environment changes, and TERM-to-KILL shutdown.

Track relay input history, retry state, and output checkpoints in Effect refs, with separate connect, replay, stream, and reattach phases.
