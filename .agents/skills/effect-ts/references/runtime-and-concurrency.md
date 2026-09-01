# Runtime & Concurrency

Fibers, calling Effect from promise-based callbacks, loop structure, locks, caches, and queues. Verified against `effect@4.0.0-rc.111`.

## Table of Contents

- [Fork Family](#fork-family)
- [Bridging into Vendor Callbacks](#bridging-into-vendor-callbacks)
- [Long-Running Loops](#long-running-loops)
- [Timeout Discipline](#timeout-discipline)
- [Cleanup and Compensation](#cleanup-and-compensation)
- [Locks](#locks)
- [Caching State: SynchronizedRef Lease](#caching-state-synchronizedref-lease)
- [Queues and Terminal-Once Channels](#queues-and-terminal-once-channels)
- [Throwable Library Math](#throwable-library-math)

## Fork Family

rc.111 exports four fork variants. `Effect.fork` and `Effect.forkDaemon` do not exist; calling them fails at **runtime** ("... is not iterable"), not at the type level.

| API | Lifetime | Use |
|-----|----------|-----|
| `Effect.forkChild` | Interrupted with the parent fiber | Concurrent work inside one operation |
| `Effect.forkScoped` | Interrupted when the enclosing scope closes | Background workers tied to a resource |
| `Effect.forkIn(scope)` | Interrupted when an explicit scope closes | Runners that outlive the current fiber but not the app |
| `Effect.forkDetach` | Independent | The v3 `forkDaemon`; interrupt it yourself |

```typescript
const fiber = yield* Effect.forkChild(work)
const result = yield* Fiber.join(fiber)
```

## Bridging into Vendor Callbacks

A bare `Effect.runPromise` inside an SDK callback starts a new root fiber. That fiber does not inherit the services, the fiber-scoped `Context.Reference` values (log level, `Logger.LogToStderr`, span annotations), or the launch scope. In one case this sent child-process logs to stdout, which was the NDJSON protocol channel, because `Logger.LogToStderr` was not inherited.

Capture the scope and context in the owning fiber, then give the callback a runner:

```typescript
const scope = yield* Effect.scope
const context = yield* Effect.context<never>()
const run = <A>(program: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(program.pipe(
    Effect.provideContext(context),
    Effect.forkIn(scope),
    Effect.flatMap(Fiber.join),
  ))
// pass `run` to the callback world; it never calls Effect.runPromise directly
```

When stdout is a machine channel, set `Effect.provideService(Logger.LogToStderr, true)` at the process entry. That reference is fiber-scoped, which is why the runner above has to provide the captured context.

## Long-Running Loops

**Per-item isolation.** `Effect.forEach` stops at the first failure, and its options are only `{ concurrency, discard }`; there is no `mode: "either"` in rc.111. One bad item must not stop the loop:

```typescript
const results = yield* Effect.forEach(
  items,
  (item) => process(item).pipe(Effect.result),
  { concurrency: 4 },
)
// partition the Results: log each failure as a typed row, continue with successes
```

**Cycle-result objects.** Each cycle of a polling or scheduling loop returns one object (`{ submissions, failures, nextTickAt, ... }`), where failures are `Schema.TaggedClass` rows, unioned with `Schema.Union` when there are several kinds. The `run` loop logs that object; only defects stop the loop.

**Spans.** A named `Effect.fn` around `Effect.forever` opens a span that never closes, and every cycle nests under it. Name the per-cycle operation and leave the forever-loop wrapper anonymous.

## Timeout Discipline

Put a timeout on every external operation: git, ssh, vendor SDK calls, waits on a child process. Cancellation cannot interrupt unbounded work inside an uninterruptible region, so a run parked there ignores cancel requests.

```typescript
yield* gitFetch(repo).pipe(Effect.timeout("10 minutes"))

yield* executor.launch(request).pipe(
  Effect.timeoutOrElse({
    duration: config.maxAttemptMinutes,
    orElse: () => new InfraFailure({ operation: "launch", reason: "timed out" }),
  }),
)
```

Use `Effect.timeoutOption` when a missing result is a normal outcome.

## Cleanup and Compensation

- **Cleanup must not change the outcome.** Run it in `Effect.ensuring`, and log then ignore its own errors: `Effect.ensuring(cleanup.pipe(Effect.tapError(logError), Effect.ignore))`. A failed `git worktree remove` must not turn a successful attempt into a retryable failure that re-runs a non-idempotent agent.
- **Releasing state also goes in `Effect.ensuring`.** If a run releases its slot only on the success path, a later cleanup releases it a second time.
- **`Effect.onError` runs on interrupt, but only for the pipeline it is attached to.** An acquire that happens before that pipeline is not covered, so an interrupt while the fiber is waiting leaves that resource acquired and never released. Move the acquire inside the pipeline, or give it its own `onError`.
- **Cancel handshakes** use `Effect.onInterrupt(() => cancel(id).pipe(Effect.tapError(logWarning), Effect.ignore))`, registered inside the scope so the resource still exists when it runs.

## Locks

`Effect.makeSemaphore` does not exist in v4. `Semaphore` is a standalone module: `Semaphore.make(permits)`, `Semaphore.makeUnsafe`, `Semaphore.withPermit(sem, effect)`, `withPermits`, `withPermitsIfAvailable`.

**`PartitionedSemaphore` is not a keyed lock.** `PartitionedSemaphore.make({ permits: 1 })` is one global permit pool; the key only decides the order of waiting fibers. Code that used it as a per-repository lock was merged and serialized every clone across all repositories. A per-key mutex is a map of semaphores:

```typescript
const keyedLockFor = <K>(): Effect.Effect<KeyedLock<K>> =>
  Effect.map(Ref.make(new Map<K, Semaphore.Semaphore>()), (locks) => ({
    withLock: (key) => {
      const semaphore = Ref.modify(locks, (current) => {
        const existing = current.get(key)
        if (existing !== undefined) return [existing, current] as const
        const created = Semaphore.makeUnsafe(1)
        const next = new Map(current)
        next.set(key, created)
        return [created, next] as const
      })
      return (effect) => Effect.flatMap(semaphore, (lock) => Semaphore.withPermit(lock, effect))
    },
  }))
```

Use `PartitionedSemaphore` only for a bounded global pool with fair per-key waiting.

## Caching State: SynchronizedRef Lease

When a cached credential's expiry comes from the payload itself, store it in a `SynchronizedRef` and renew inside `modifyEffect`. Renewals are serialized, so concurrent callers produce one renewal request rather than one each:

```typescript
const lease = yield* SynchronizedRef.make<Option.Option<Lease>>(Option.none())
const current = SynchronizedRef.modifyEffect(lease, (state) =>
  Effect.map(
    needsRenewal(state) ? mint : Effect.succeed(Option.getOrThrow(state)),
    (fresh) => [fresh.token, Option.some(fresh)] as const,
  ))
```

`Effect.cachedWithTTL` fits only fixed TTLs known up front.

## Queues and Terminal-Once Channels

v4 queues have an error/done channel: `Queue.make<Event, SessionError | Cause.Done>()`, terminated with `Queue.fail(queue, error)` or `Queue.end(queue)`. `Queue.offer` returns `Effect<boolean>`, and returns `false` after termination; log dropped events instead of ignoring that boolean.

A terminal-once adapter channel combines three pieces: a `Queue` for events, a `Deferred` for the single result, and `Ref.getAndSet(terminal, true)` as a latch. Both the failure path and the success path call the latch, and only the first one runs the cleanups.

## Throwable Library Math

A synchronous library call inside a generator throws as a **defect**. Inside an `E = never` loop, that defect is not caught by `Effect.forever` and terminates the fiber with no log. Wrap such calls in `Effect.try` (piped to `Effect.result` for per-item isolation) when the throw should become a typed failure.

Known rc.111 case: `Cron.prev` throws `Error("Unable to find cron date")` for about 23 hours on any DST spring-forward day, for crons whose local time falls in the skipped hour, and `Cron.next` returns a time inside that window, so a scheduler loop wakes up and immediately hits the throw. Run cron boundary math per schedule under `Effect.try`, convert it to a typed per-schedule failure, and keep the other schedules running.
