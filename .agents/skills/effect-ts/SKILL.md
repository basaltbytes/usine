---
name: effect-ts
description: "Write idiomatic Effect v4 TypeScript following official best practices from effect-solutions and the Effect source. Use when writing, reviewing, or refactoring Effect code: services (Context.Service), layers and dependency injection, error handling (Schema.TaggedError), data modeling (Schema.Class, branded types, variants), concurrency and runtime (fibers, queues, locks, bridging into callbacks), testing (@effect/vitest), HTTP clients (effect/http), CLI tools (effect/cli), child processes, config, observability, and project setup. Triggers on: 'Effect', 'effect-ts', '@effect/', 'Schema', 'ServiceMap', 'Context.Service', 'Layer', 'Effect.gen', 'Effect.fn', 'TaggedError', 'branded types', 'Fiber', 'Queue', 'Semaphore', 'runPromise', or any Effect-TS related code."
---

# Effect-TS (v4)

Patterns from [effect-solutions](https://effect.solutions) and the [Effect source](https://github.com/effect-ts/effect). This covers the latest v4 APIs.

## Version Pin

Every API name in this skill is verified against `effect@4.0.6`, the version pinned by this workspace. Names have churned during v4: `ServiceMap.Service` and `Schema.TaggedErrorClass` existed on earlier v4 RCs and were renamed back to `Context.Service` and `Schema.TaggedError`, the stable 4.0 releases moved the `effect/unstable/*` modules to `effect/*` (`effect/unstable/httpapi` is `effect/http-api`), and `Config`'s constructors are capitalized (`Config.String`). So if this skill and the source mirror ever disagree, the mirror wins (see Source-First Rule) and this skill must be updated in the same change.

## Source-First Rule

When working in any repo that uses Effect (`effect` or `@effect/*` in package/dependency files), verify against the Effect source before writing, reviewing, or refactoring Effect code. Do not rely on stale memory, blog posts, or high-level docs alone.

- **API names and signatures**: grep the installed pinned package first, at `node_modules/.pnpm/effect@<pinned>*/node_modules/effect/dist/*.d.ts` (plus `src/` and `internal/` for semantics). It is the exact version the code compiles against. Cite the `.d.ts` or source line when you state how something behaves.
- **Behavior**: for a question about what the code does at runtime, such as how a decoder treats an absent key or what a stream emits for a blank line, prove it with a throwaway `node --input-type=module` probe against the installed package. Do not answer it by reading alone.
- **Broader reading** (tests, examples, implementation context): use the repo-local shallow mirror at `.agent-sources/effect/`; create it if missing with `mkdir -p .agent-sources && git clone --depth 1 --filter=blob:none https://github.com/effect-ts/effect.git .agent-sources/effect` (or the `effect_source` tool if available). The mirror follows upstream main, which is usually ahead of the pinned version. When the two disagree, the installed package is correct. Keep the mirror out of product commits via `.git/info/exclude`, not the project `.gitignore`.

## Local Source References

- **repo-local Effect source mirror** (canonical for current work): `.agent-sources/effect/`
- **effect-solutions** (best practices, docs, examples): `~/Code/kitlangton/effect-solutions/`
- **fallback global Effect monorepo**: `~/Code/effect-ts/effect/`
- Search source for implementations: `grep -r "pattern" .agent-sources/effect/packages/effect/src/`

## Effect.gen and Effect.fn

`Effect.gen` provides sequential, readable composition (like async/await for Effect):

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const data = yield* fetchData
  yield* Effect.logInfo(`Processing: ${data}`)
  return yield* processData(data)
})
```

`Effect.fn` adds call-site tracing and named spans. Use for all service methods:

```typescript
const processUser = Effect.fn("processUser")(function* (userId: string) {
  yield* Effect.logInfo(`Processing user ${userId}`)
  const user = yield* getUser(userId)
  return yield* processData(user)
})

// Second argument for cross-cutting concerns (retry, timeout)
const fetchWithRetry = Effect.fn("fetchWithRetry")(
  function* (url: string) {
    const data = yield* fetchData(url)
    return yield* processData(data)
  },
  flow(
    Effect.retry(Schedule.recurs(3)),
    Effect.timeout("5 seconds")
  )
)
```

Exception: do not wrap a loop that never returns (`Effect.forever`) in a named `Effect.fn`. Its span never closes and every cycle nests under it. Name the per-cycle operation instead. Let `Effect.fn` infer its return type; declare the public signature on the service tag.

## Context.Service

Define services as classes with a unique tag and typed interface:

```typescript
import { Context, Effect } from "effect"

class Database extends Context.Service<
  Database,
  {
    readonly query: (sql: string) => Effect.Effect<unknown[]>
    readonly execute: (sql: string) => Effect.Effect<void>
  }
>()("@app/Database") {}
```

Implement with `Layer.effect` or `Layer.sync`, using `Effect.fn` for all methods:

```typescript
import { Context, Effect, Layer } from "effect"

class Users extends Context.Service<
  Users,
  {
    readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
    readonly all: () => Effect.Effect<readonly User[]>
  }
>()("@app/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const findById = Effect.fn("Users.findById")(function* (id: UserId) {
        const response = yield* http.get(`/users/${id}`)
        return yield* HttpClientResponse.schemaBodyJson(User)(response)
      })
      const all = Effect.fn("Users.all")(function* () {
        const response = yield* http.get("/users")
        return yield* HttpClientResponse.schemaBodyJson(Schema.Array(User))(response)
      })
      return { findById, all }
    })
  )
}
```

**Rules:**
- Tag identifiers must be unique. Use `@app/ServiceName` pattern
- Service methods should have `R = never` (dependencies via Layer, not method signatures)
- Use `readonly` properties
- Declare the interface in the `Context.Service` type parameter for public services — never infer a public API from the implementation (`Effect.Success<typeof make>`); internal single-implementation services may infer

See [references/services-and-layers.md](references/services-and-layers.md) for service-driven development, test layers, layer memoization, and full composition patterns.

## Schema.Class and Branded Types

Use `Schema.Class` for domain records. Brand all entity IDs and domain primitives:

```typescript
import { Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

const Email = Schema.String.pipe(Schema.brand("Email"))
type Email = typeof Email.Type

class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Email,
  createdAt: Schema.Date,
}) {
  get displayName() { return `${this.name} (${this.email})` }
}

// Construct with .make (throws on invalid input; .makeOption / .makeEffect
// for non-throwing forms). There is no .makeUnsafe on schemas.
const userId = UserId.make("user-123")
```

Use `Schema.TaggedClass` + `Schema.Union` for variants (OR types):

```typescript
import { Match, Schema } from "effect"

class Success extends Schema.TaggedClass<Success>("Success")("Success", {
  value: Schema.Number,
}) {}
class Failure extends Schema.TaggedClass<Failure>("Failure")("Failure", {
  error: Schema.String,
}) {}
const Result = Schema.Union([Success, Failure])
type Result = typeof Result.Type

// Exhaustive pattern matching
const render = (r: Result) => Match.valueTags(r, {
  Success: ({ value }) => `Got: ${value}`,
  Failure: ({ error }) => `Error: ${error}`,
})
```

See [references/data-modeling.md](references/data-modeling.md) for JSON encoding, Schema.Literals, validation, and full patterns.

## Schema.TaggedError

Define domain errors with `Schema.TaggedError`. They are yieldable (no `Effect.fail` needed):

```typescript
import { Schema } from "effect"

class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>(
  "UserNotFoundError",
)("UserNotFoundError", { userId: UserId, message: Schema.String }) {}

// Yieldable: yield directly in generators
const getUser = Effect.fn("getUser")(function* (id: UserId) {
  const user = yield* findUser(id)
  if (!user) yield* new UserNotFoundError({ userId: id, message: "Not found" })
  return user
})
```

Recover with `catchTag` / `catchTags`:

```typescript
// Single tag
const recovered = program.pipe(
  Effect.catchTag("UserNotFoundError", (e) =>
    Effect.succeed(`User ${e.userId} missing`)
  )
)

// Multiple tags
const recovered2 = program.pipe(
  Effect.catchTags({
    UserNotFoundError: (e) => Effect.succeed("not found"),
    ValidationError: (e) => Effect.succeed("invalid"),
  })
)
```

See [references/error-handling.md](references/error-handling.md) for defects, Schema.Defect, and recovery patterns.

Do not convert defects into typed errors inside adapters: that turns a bug into a retryable domain failure. Use `Effect.catchDefect` only at a boundary that requires serializable errors, such as a wire channel's `InfraFailure({ cause: Schema.Defect() })`, keep the original cause, and do not mark the result retryable. See [references/error-handling.md](references/error-handling.md).

## Layer Composition

Compose layers with `Layer.provideMerge` (incremental, flat types) and `Layer.merge` (parallel):

```typescript
import { Effect, Layer } from "effect"

// Compose layers for the app
const appLayer = UserService.layer.pipe(
  Layer.provideMerge(DatabaseLayer),
  Layer.provideMerge(LoggerLayer),
  Layer.provideMerge(ConfigLayer),
)

// Provide once at the entry point
const main = program.pipe(Effect.provide(appLayer))
Effect.runPromise(main)
```

**Key rules:**
- Store parameterized layers in constants (layer memoization by reference identity)
- Provide once at app entry, not scattered throughout code
- Use `Layer.sync` for synchronous implementations, `Layer.effect` for effectful ones

## Testing Quick Start

```typescript
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

it.effect("queries database", () =>
  Effect.gen(function* () {
    const db = yield* Database
    const results = yield* db.query("SELECT *")
    expect(results.length).toBe(2)
  }).pipe(Effect.provide(Database.testLayer))
)
```

- Use `it.effect` for Effect-based tests (provides TestContext with TestClock)
- Use `it.live` for real time / real clock
- Provide fresh layers per test to prevent state leakage
- Use `it.layer` only when sharing expensive resources across a suite

See [references/testing.md](references/testing.md) for the full worked example and advanced patterns.

## Pipe for Instrumentation

```typescript
const program = fetchData.pipe(
  Effect.timeout("5 seconds"),
  Effect.retry(Schedule.exponential("100 millis").pipe(
    Schedule.compose(Schedule.recurs(3))
  )),
  Effect.tap((data) => Effect.logInfo(`Fetched: ${data}`)),
  Effect.withSpan("fetchData"),
)
```

Write logs so that a reader can tell from them why nothing happened, not just what happened:

- Annotate every `Effect.fn` span with domain ids: `Effect.annotateCurrentSpan({ runId, repository })`.
- Log before discarding an error. Use `Effect.tapError(logError), Effect.ignore` rather than a bare `Effect.ignore`.
- Build log fields from a result union with `Match.valueTags`, where each variant returns its own fields, instead of using `""` as a placeholder.
- Log every decision: skips, resets, backoffs, and terminal outcomes at info; idle summaries at debug; config mistakes at warning.

## Anti-Patterns

| Do Not | Do Instead |
|--------|-----------|
| `console.log(...)` | `Effect.log(...)` with structured data |
| `process.env.KEY` | `Config.String("KEY")` or `Config.Redacted("KEY")` |
| `throw new Error()` inside `Effect.gen` | `yield* new TaggedError({...})` or `Effect.fail(...)` |
| `Effect.runSync(...)` inside services | Keep everything effectful |
| `Effect.catchAll(() => ...)` losing type info | `Effect.catchTag` / `Effect.catchTags` |
| `null` / `undefined` in domain types | `Option<T>` with `Option.match` |
| `Option.getOrThrow(...)` | `Option.match({ onNone, onSome })` or `Option.getOrElse` |
| `Effect.Service` (v3) / `ServiceMap.Service` (earlier v4 RC) | `Context.Service` |
| `Schema.TaggedErrorClass(...)` (earlier v4 RC) | `Schema.TaggedError<Self>("Tag")("Tag", {...})` |
| `Effect.fork` / `Effect.forkDaemon` (v3 — fails at runtime) | `Effect.forkChild` / `forkScoped` / `forkIn` / `forkDetach` |
| `Option.fromNullable` (v3) | `Option.fromNullishOr` (or `fromNullOr` for null-only) |
| `Schema.pattern` / `minLength` / `maxLength` (v3) | `.check(Schema.isPattern(re, { message }))` / `isMinLength` / `isMaxLength` |
| `Schema.optional(S, { default })` (v3) | `Schema.withDecodingDefaultKey(Effect.succeed(v))` |
| `Effect.makeSemaphore` (v3) | `Semaphore.make` (standalone module) |
| `Schema.NullOr` for maybe-absent keys | `Schema.optionalKey` — `NullOr` keys stay required |
| `Effect.catchTag("RequestError" / "ResponseError")` | `Effect.catchTag("HttpClientError", ...)`, branch on `reason` / `response` |
| `Effect.runPromise` inside vendor callbacks | Context-carrying runner ([runtime-and-concurrency](references/runtime-and-concurrency.md)) |
| `import { Command } from "@effect/platform"` (v3) | `effect/process` `ChildProcess` + `ChildProcessSpawner` |
| `Config.string` / `Config.redacted` / `Config.int` (v4 RC) | `Config.String` / `Config.Redacted` / `Config.Int` |
| `Encoding.encodeBase64(...)` (v4 RC) | `Base64.encode(...)` from `effect/encoding`; `Base64Url` and `Hex` likewise |
| `.annotate({ parseOptions: { onExcessProperty: "error" } })` (v4 RC; 4.0 parsing ignores it) | `{ onExcessProperty: "error" }` at the decode site, or `HttpApi.PayloadParseOptions` on an `HttpApi` group |
| Wiping the `Redacted` you passed to a `Schema.Redacted` field | Wipe the field's value: decoding and construction store a copy. To keep the instance, declare the field with `Schema.declare` over `Redacted.isRedacted` |
| Scatter `Effect.provide` calls | Provide once at app entry |
| Call parameterized layer constructors inline | Store layers in constants (memoization) |

## Reference Files

Load these as needed for deeper patterns:

- **[Services & Layers](references/services-and-layers.md)**: Context.Service, service-driven development, test layers, layer memoization, provide vs provideMerge
- **[Data Modeling](references/data-modeling.md)**: Schema.Class, branded types, variants, Match.valueTags, JSON encoding
- **[Schema Decisions](references/schema-decisions.md)**: Schema.Class vs Struct vs TaggedClass decision flowchart, migration patterns
- **[Error Handling](references/error-handling.md)**: Schema.TaggedError, catch/catchTag/catchTags, defects, Schema.Defect, TypeId/refail patterns
- **[Testing](references/testing.md)**: @effect/vitest setup, it.effect/it.live/it.layer, TestClock, Effect.flip, FiberRef isolation, worked example
- **[HTTP Clients](references/http-clients.md)**: HttpClient, request building, response decoding, middleware, retries, HttpClientError handling, typed API service
- **[CLI](references/cli.md)**: Command.make, Arguments, Flags, subcommands, worked task manager example
- **[Config](references/config.md)**: Config module, schema validation, ConfigProvider, Redacted, config layers
- **[Runtime & Concurrency](references/runtime-and-concurrency.md)**: fork family, bridging into vendor callbacks, loop shapes and per-item isolation, timeouts, cleanup/compensation, locks, SynchronizedRef caching, queues
- **[Child Processes & Scopes](references/processes.md)**: ChildProcess/ChildProcessSpawner, spawn option gotchas, output streams, Scope.extend, killable background tasks
- **[Setup](references/setup.md)**: tsconfig, Effect Language Service, project structure, module settings
