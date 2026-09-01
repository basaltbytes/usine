# Error Handling

## Table of Contents

- [Schema.TaggedError](#schemataggederror)
- [Yieldable Errors](#yieldable-errors)
- [Recovering from Errors](#recovering-from-errors)
- [Expected Errors vs Defects](#expected-errors-vs-defects)
- [Schema.Defect for Unknown Errors](#schemadefect-for-unknown-errors)

## Schema.TaggedError

Define domain errors with `Schema.TaggedError`:

```typescript
import { Schema } from "effect"

class ValidationError extends Schema.TaggedError<ValidationError>("ValidationError")(
  "ValidationError",
  {
    field: Schema.String,
    message: Schema.String,
  }
) {}

class NotFoundError extends Schema.TaggedError<NotFoundError>("NotFoundError")(
  "NotFoundError",
  {
    resource: Schema.String,
    id: Schema.String,
  }
) {}

const AppError = Schema.Union([ValidationError, NotFoundError])
type AppError = typeof AppError.Type
```

**Benefits:**
- Serializable (can send over network, save to DB)
- Type-safe with built-in `_tag` for pattern matching
- Custom methods via class extension
- Sensible default `message` when you don't declare one

**Every distinct failure reason deserves its own error type.** Don't collapse multiple failure modes into generic errors like `NotFoundError`. Use `UserNotFoundError`, `ChannelNotFoundError`, etc. with relevant context fields.

**Package conventions:**
- Class name equals the tag (`ExpressionCheckError`, tagged `"ExpressionCheckError"`).
- Namespace the schema identifier in the first constructor argument (`"@pkg/ExpressionCheckError"`). The runtime `_tag` stays the bare name.
- Each package exports one failure union (`ConfigError`, `EngineError`) built with `Schema.Union([...])`.
- `Schema.TaggedError` supplies a default `message`; declare a `message` field only when it adds information the tag does not.
- **Split error types by whether the caller should retry.** Callers decide that from the error type: a vendor or child-process problem is a retryable infra error, while an agent-reported failure or a bad config is not. Mapping both to one type either wastes retries on failures that will never succeed, or stops a run that would have succeeded on the next attempt.
- **Delete error types that can no longer occur.** When an exhaustive dispatcher or a narrowed input type makes a failure impossible, remove the error class, its union member, and its imports.

## Yieldable Errors

`Schema.TaggedError` values are yieldable. Return them directly in generators without wrapping in `Effect.fail`:

```typescript
import { Effect, Random, Schema } from "effect"

class BadLuck extends Schema.TaggedError<BadLuck>("BadLuck")(
  "BadLuck",
  { roll: Schema.Number }
) {}

const rollDie = Effect.gen(function* () {
  const roll = yield* Random.nextIntBetween(1, 6)
  if (roll === 1) {
    yield* new BadLuck({ roll }) // no Effect.fail needed
  }
  return { roll }
})
```

## Recovering from Errors

### catch

Handle all errors with a fallback:

```typescript
const recovered: Effect.Effect<string, never> = program.pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Effect.logError("Error occurred", error)
      return `Recovered from ${error.name}`
    })
  )
)
```

### catchTag

Handle a specific error by its `_tag`:

```typescript
const recovered = program.pipe(
  Effect.catchTag("HttpError", (error) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(`HTTP ${error.statusCode}: ${error.message}`)
      return "Recovered from HttpError"
    })
  )
)
// HttpError is removed from the error channel; other errors remain
```

### catchTags

Handle multiple error types at once:

```typescript
const recovered = program.pipe(
  Effect.catchTags({
    HttpError: () => Effect.succeed("Recovered from HttpError"),
    ValidationError: () => Effect.succeed("Recovered from ValidationError"),
  })
)
// Both error types removed from the error channel
```

## Expected Errors vs Defects

Effect tracks errors in the type system (`Effect<A, E, R>`) so callers know what can fail and can recover.

**Use typed errors** for domain failures the caller can handle: validation errors, "not found", permission denied, rate limits.

**Use defects** for unrecoverable situations: bugs, invariant violations. Defects terminate the fiber and you handle them once at the system boundary (logging, crash reporting).

```typescript
// At app entry: if config fails, nothing can proceed
const main = Effect.gen(function* () {
  const config = yield* loadConfig.pipe(Effect.orDie)
  yield* Effect.log(`Starting on port ${config.port}`)
})
```

**When to catch defects:** Almost never. Only at system boundaries for logging/diagnostics. Use `Effect.exit` to inspect or `Effect.catchDefect` if you must recover (e.g., plugin sandboxing).

**Do not convert defects into ordinary typed failures.** Catching every defect in an adapter and re-throwing it as a typed error turns a bug into a retryable domain failure with an invented message. Use `catchDefect` in two places only: a boundary that requires serializable errors, such as a wire channel's `InfraFailure({ cause: Schema.Defect() })`, and a port where "the code around the agent crashed" is a real outcome the caller handles. In both, keep the original cause and do not mark the result retryable.

More rules from review:
- Do not define a typed error for a branch that cannot happen. An in-memory SHA-256 digest that fails is a violated invariant, so use `Effect.orDie` and delete the error type.
- Operator configuration mistakes are typed errors at the parse boundary, not `Effect.die` at layer build. Only programmer defects crash.
- Do not re-validate a contract the types already guarantee. A branded or union input needs no second check.

## Schema.Defect for Unknown Errors

Wrap unknown errors from external libraries with `Schema.Defect`:

```typescript
import { Schema, Effect } from "effect"

class ApiError extends Schema.TaggedError<ApiError>("ApiError")(
  "ApiError",
  {
    endpoint: Schema.String,
    statusCode: Schema.Number,
    error: Schema.Defect(), // wraps the underlying error
  }
) {}

const fetchUser = (id: string) =>
  Effect.tryPromise({
    try: () => fetch(`/api/users/${id}`).then((r) => r.json()),
    catch: (error) => new ApiError({
      endpoint: `/api/users/${id}`,
      statusCode: 500,
      error,
    }),
  })
```

**Schema.Defect handles:**
- JavaScript `Error` instances become `{ name, message }` objects
- Any unknown value becomes a string representation
- Result is serializable for network/storage

**Use for:** wrapping external library errors, network boundaries, persisting errors to DB, logging systems.

## Advanced Patterns

### TypeId Branding (from Effect core packages)

Brand error families with a TypeId symbol for runtime type discrimination across package boundaries:

```typescript
import { hasProperty, isTagged } from "effect/Predicate"
import { Schema } from "effect"

export const TypeId: unique symbol = Symbol.for("@myapp/AppError")
export type TypeId = typeof TypeId

export class NotFoundError extends Schema.TaggedError<NotFoundError>("NotFoundError")(
  "NotFoundError",
  { resource: Schema.String, id: Schema.String }
) {
  readonly [TypeId] = TypeId

  static is(u: unknown): u is NotFoundError {
    return hasProperty(u, TypeId) && isTagged(u, "NotFoundError")
  }
}
```

### Refail Combinators Guarded by the Package Union

Map foreign errors into the package's failure union without double-wrapping your own:

```typescript
const isEngineError = Schema.is(EngineError) // the package's exported union

export const persistence = (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EngineError, R> =>
    Effect.mapError(effect, (error) =>
      isEngineError(error) ? error : new EnginePersistenceError({ operation, cause: error })
    )
```

Apply it through `Effect.fn`'s second (pipeline) argument on each service method instead of wrapping every function body. Use `Schema.is(Union)` as the guard rather than a chain of `instanceof` checks.

To read a message out of an unknown vendor cause, decode it: `Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }))(cause)`, then `Option.match`.

### Effect.flip (Swap Success/Error for Testing)

```typescript
it.effect("should fail on invalid input", () =>
  Effect.gen(function* () {
    const service = yield* MyService
    const error = yield* service.doThing(badInput).pipe(Effect.flip)
    expect(error._tag).toBe("ValidationError")
  }).pipe(Effect.provide(TestLayer))
)
```

Patterns adapted from [artimath/effect-skills](https://github.com/artimath/effect-skills) (MIT).
