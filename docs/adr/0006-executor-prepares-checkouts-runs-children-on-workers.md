# The executor prepares a checkout per attempt and runs harness children on a worker

For each attempt, the executor:

- **Checks readiness.** Preflight verifies git, memory for the worker's concurrent attempts, and each rostered brain, and fails with a typed capability error. It installs nothing and starts no login. Preparation verifies the assigned brain again, which catches a later logout.
- **Prepares a checkout.** It keeps a cached clone per repository on each worker machine and creates a fresh worktree per attempt, with the attempt's single-repository credential (ADR 0011, ADR 0027). Closing the `PreparedAttempt`'s scope releases the checkout, the credential, and any held machine.
- **Runs children on the worker.** Each Claude Code or Codex child runs at the attempt's child host: a local process, an SSH command, or a provider's exec stream. On a remote host, a process owner keeps the child running across a dropped connection, stops it when the orchestrator's heartbeat lapses, and confirms it ended before the checkout goes. The orchestrator sends the owner program with each launch, so a worker needs no usine package. Pi children run their tools in the orchestrator, so only local workers run them. Nothing run for an attempt inherits the orchestrator's environment, which holds the App private key.
- **Keeps the work.** An unsuccessful attempt with write permissions pushes its work to `usine/salvage/<run>/<attempt>`, and the next attempt starts from it. A finished attempt's result is its commits, pull requests, agent-signed comments, and step outputs (ADR 0034), harvested with the attempt's credential.

Coordination runs in the orchestrator and stores activity, as versioned attempt channel envelopes, before the transcript shows it. After an orchestrator restart, the engine reattaches a live attempt to its checkout and saved child sessions without spending a retry.

Built: the Pi parent, a pi-durable task in the orchestrator, coordinates every attempt (ADR 0005). Decided, not built: the event-driven coordinator replaces it behind the same executor contract (#1150, removal in #1166).

## Considered options

- **A one-shot run host over a framed channel** (removed in #176): crash isolation, but a restart lost the attempt, and workers needed a matching usine package.
- **A persistent worker daemon**: reattach, at the cost of worker-side state and version skew.
- **Credentials in the run request or on the channel**: secrets would land in stored records.
- **A fresh clone, or one persistent checkout per repository**: slow, or unisolated.
