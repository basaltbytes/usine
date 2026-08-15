# Durable execution on Effect workflow, projected into usine's own tables

Rather than hand-rolling crash-safe resume, usine delegates durable execution — memoized step results, suspend-awaiting-signal, resume-after-failure, capped typed retries, interruption — to Effect's workflow modules (`effect/unstable/workflow` + `effect/unstable/cluster`, `SingleRunner` on one SQL database), pinned exactly and wrapped behind a usine-owned engine seam: the same policy already applied to Pi. The Event/Run/Step/Attempt tables remain usine's own — Effect's state store is an implementation detail behind the seam, while usine's tables are what the UI reads. Effect exposes no list-runs API, so the operator surface was ours to build regardless.

## Considered Options

- **Hand-rolled durable execution on the four tables** — fully inspectable, and what the [substrate research](https://github.com/basaltbytes/usine/blob/research/engine-substrate/docs/research/effect-workflow.md) recommended; rejected by the operator: crash-safe resume plus deferred signals is the deceptively hard part, and it is exactly what Effect provides (DurableDeferred maps to approval Events, SuspendOnFailure + resume to operator retry, interrupt to cancel/supersede).
- **Self-hosted Inngest server** — requires Redis beside SQL, hard-codes a 24 h idempotency TTL against the permanent dedup guarantee, and caps HTTP-driven steps at 2 h (the persistent-worker mode is still beta). Its open SDK spec and Apache-licensed workflow-kit remain design references ([research](https://github.com/basaltbytes/usine/blob/research/engine-substrate/docs/research/inngest-oss.md)).

## Consequences

- The workflow modules are alpha and exempt from semver in minors: exact pin; upgrades are deliberate migrations absorbed at the seam.
- Deterministic execution ids (hash of workflow name + idempotency key) make "the same Event joins the same run" free — usine's dedup key is the idempotency key.
- A crash mid-step re-runs that step's agent session from scratch — acceptable: it is a new Attempt.
- The known SQLite lock issue ([Effect-TS/effect#6176](https://github.com/Effect-TS/effect/issues/6176)) concerns concurrent multi-process access; the single orchestrator process, or Postgres, sidesteps it.
