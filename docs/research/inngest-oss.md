# Inngest open-source components: what usine can reuse

Researched 2026-08-15 for [The run model: entities, states, idempotency](https://github.com/basaltbytes/usine/issues/7) and [Persistence: what's durable and where](https://github.com/basaltbytes/usine/issues/13). All claims verified against live sources on that date.

## The inngest/inngest server repo

**Contents.** The repo (https://github.com/inngest/inngest) is the whole platform in Go: Event API, event stream, runner, multi-tenant queue, executor, state store, GraphQL/REST APIs, CLI, dev server, and the React UIs. `pkg/` contains `execution/queue`, `execution/state/redis_state` (Lua scripts), `execution/ratelimit`, `connect`, `devserver`, `coreapi`, `cqrs`; `ui/apps/` contains `dev-server-ui`, `dashboard`, and `support`. The README states the same code powers dev server and cloud.

**License.** Root `LICENSE.md` (https://raw.githubusercontent.com/inngest/inngest/main/LICENSE.md) is "Server Side Public License, Version 1.0" plus an "Apache 2.0 Future License": each release converts to Apache-2.0 three years after it shipped — code released before mid-2023 is Apache today; current releases are SSPL until 2029. The SDKs are Apache-2.0. For a single-operator internal tool, SSPL's service clause never triggers — running it yourself is unrestricted.

**Self-hosting.** Production self-hosting exists since v1.0 (Sept 2024): `inngest start` runs everything in one binary, including the dashboard UI, all flow control, batching, and `waitForEvent` (https://www.inngest.com/docs/self-hosting, https://www.inngest.com/blog/inngest-1-0-announcing-self-hosting-support). Caveats: no guaranteed support for self-hosted instances, and no automatic pruning of old Postgres rows.

**Storage.** Default: an in-process in-memory Redis for queue+state, snapshotted to SQLite at `./.inngest/main.db`. Optional: external Redis (`--redis-uri`) and Postgres (`--postgres-uri`). The queue/state layer is Redis+Lua always — SQL only handles durable persistence/history. It cannot run purely on one SQL database.

## Fit against usine's run model

- **Never-expire dedup vs 24 h TTL — clash, hard-coded.** Event-id idempotency and function-level `idempotency` both last exactly 24 h (https://www.inngest.com/docs/guides/handling-idempotency); `FunctionIdempotencyPeriod = 24 * time.Hour` in `pkg/consts/consts.go`. Changing it means owning a fork.
- **One-open-run-per-key — partial.** Singleton functions (`singleton: {key, mode}`, modes `skip`/`cancel`) guarantee at most one *active* run per key (https://www.inngest.com/docs/guides/singleton) — a concurrency gate, not a permanent ledger.
- **Approvals — works self-hosted.** `waitForEvent` with CEL matching, max ~1 year. Events sent before the step executes are missed.
- **Cancel/steer.** `cancelOn` events, a bulk-cancellation REST API, dashboard cancellation (https://www.inngest.com/docs/guides/cancel-running-functions).
- **Long-running agent steps — the weak point.** Steps execute inside an HTTP request, max 2 h (https://www.inngest.com/docs/usage-limits/inngest). Connect (persistent websocket worker, unbounded step duration) is Public Beta (https://www.inngest.com/docs/setup/connect). Step output capped at 4 MB, run state 32 MB.

## workflow-kit

"A reference implementation of how to build user-defined workflows with Inngest" (https://github.com/inngest/workflow-kit): `@inngest/workflow-kit` (runs a user-defined DAG as one Inngest function) plus React components for a Zapier-like editor. **Apache-2.0** (v0.1.3). Maintenance mode: last functional commit Sept 2025, dependency bumps since. The workflow-instance format is a small JSON DAG — `actions` (id, kind, name, inputs) + `edges` (`from`/`to`, `$source` entry) (https://www.inngest.com/docs/reference/workflow-kit/workflow-instance). Ideas and code freely stealable; the engine itself depends on `inngest`.

## inngest-js (TypeScript SDK)

The published `inngest` npm package (v4.18.1) is **Apache-2.0**, as are `@inngest/test`, `@inngest/realtime`, and the middleware packages (GitHub's "GPL-3.0" sidebar label is a stale misdetection from example projects). The step-memoization runtime is coupled to the server protocol, but `@inngest/test`'s `InngestTestEngine` executes functions with mocked step state entirely locally — a good reference for how memoization/replay works in TS (https://github.com/inngest/inngest-js/tree/main/packages/test). The whole server↔SDK protocol is an open spec: `docs/SDK_SPEC.md` in the server repo (https://github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md) — the best single document of their execution model.

## Other reusable material

- Queue design writeups: https://www.inngest.com/blog/building-the-inngest-queue-pt-i-fairness-multi-tenancy, https://www.inngest.com/blog/fixing-multi-tenant-queueing-concurrency-problems, https://www.inngest.com/blog/rate-limit-debouncing-throttling-explained, https://www.inngest.com/blog/building-an-event-driven-queue.
- Flow-control semantics (concurrency, throttle, rate limit, debounce, priority): https://www.inngest.com/docs/guides/flow-control.
- Limits from `pkg/consts/consts.go`: sleep and waitForEvent max 366 d, retry window max 24 h, debounce max 7 d, step output 4 MB, state 32 MB.
- The dev-server and dashboard UIs are SSPL — read for ideas, don't copy until a release's 3-year Apache date passes.

## Assessment

**Skip adopting the server**: it needs Redis beside SQL, hard-codes the 24 h TTL against usine's never-expire dedup, and long SSH steps only work via beta Connect — the mismatches sit exactly on usine's decided invariants. **Steal ideas freely**: SDK_SPEC.md, the flow-control semantic definitions, singleton skip/cancel modes, the fair-queue series. **Adopt code selectively**: `@inngest/workflow-kit`'s DAG format and editor patterns, `@inngest/test`'s local execution engine as reference TS memoization.
