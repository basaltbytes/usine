# Executor contract: a one-shot run host over a duplex attempt channel

The Worker seam's executor contract has five operations: **preflight** (verify-only readiness — toolchain, run-host version, harness login state, attached credentials — failing with typed capability errors, never installing), **workspace provisioning** (one cached clone per worker+repo, fetched on demand; a fresh worktree per attempt), **attempt launch** (a one-shot run host per attempt — the process hosting the run's Pi parent session — RunSpec in, exit code as attempt outcome), **cancellation**, and **cleanup** (the worktree is destroyed at attempt end regardless of outcome). Orchestrator and run host talk over a duplex attempt channel: attempt-scoped, protocol-versioned framed messages — normalized events out, steer/interrupt in — carried by any byte transport (stdio locally, `ssh <vm> -- <cmd>` on exe.dev). The run host's final message is the step result (agent final message plus harvested facts: commits, PRs, comments); the orchestrator persists the event flow as it arrives, and that record is the transcript — no file artifacts leave the worker. Credentials are machine-attached worker capabilities, ambient to the run host and verified by preflight, never carried in a RunSpec or on the channel. Workers are named entries in `usine.yaml` (an implicit local worker when none is declared); the engine assigns attempts, capped by per-worker `maxConcurrentAttempts`, queuing runs as `pending` beyond it.

## Considered Options

- **Persistent worker daemon** — a long-lived usine process per worker, multiplexing attempts and enabling mid-attempt reattach. Rejected for v1: daemon lifecycle, orchestrator↔daemon version skew, and worker-side session state. The envelopes are attempt-scoped and versioned precisely so a daemon transport can carry them later without changing a message.
- **One-shot run host** (chosen) — local = spawn a child process, exe.dev = one SSH exec; crash isolation per attempt, zero worker-side state between attempts, and the channel-loss story collapses into ADR 0002's typed-infra-error retry.
- **Per-run credential injection** — orchestrator passes secrets at spawn. Rejected: secrets transit the channel, and it breaks exe.dev's edge-injected no-token-on-VM design, forking the two adapters.
- **Workspace artifact collection** — shipping declared files (diffs, logs) off the worker before cleanup. Deferred: nothing in the three acceptance loops needs it; result facts plus the transcript cover observe-and-intervene.
- **Fresh clone / persistent checkout per repo** — rejected for slow attempts and for no isolation respectively; cached-clone-plus-worktree takes both wins for a fetch lock and worktree hygiene.

## Consequences

- No reattach in v1: an orchestrator restart or dropped link mid-attempt fails the attempt with a typed infra error, eligible for capped auto-retry as a new Attempt — the same crash story as ADR 0003.
- Cancellation (operator cancel and supersede) is two-stage and idempotent: an interrupt message lets the Pi parent stop children cleanly and flush final events, then a grace timeout, then hard kill. On exe.dev: kill the SSH session, then lifecycle cleanup.
- Making a worker ready is out-of-band and adapter-specific — guided setup locally, a baked VM image on exe.dev; harness login (Claude/ChatGPT OAuth) is always the operator's task. Version skew between orchestrator and a baked image surfaces at preflight, not mid-run.
- Anything durable an agent produces must be pushed to GitHub or said on the channel — the worktree is gone after the attempt, on success and failure alike.
- A `worker:` selector on loops stays a later additive field (workers are name-keyed), the same pattern that keeps repo-scoped loop files possible (ADR 0001).
- exe.dev fits without leakage: lobby commands are adapter internals for machine lifecycle, edge injection is one credential-attachment mode, and completion rides the SSH child's exit.
