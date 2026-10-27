# Data Modeling

## Table of Contents

- [Why Schema](#why-schema)
- [Records (AND Types)](#records-and-types)
- [Variants (OR Types)](#variants-or-types)
- [Branded Types](#branded-types)
- [JSON Encoding and Decoding](#json-encoding-and-decoding)
- [Common Schema Primitives](#common-schema-primitives)
- [Validation Checks](#validation-checks)
- [Optional, Nullable, Defaults](#optional-nullable-defaults)
- [Decode-Time Transformation](#decode-time-transformation)
- [Strict vs Lenient Decoding](#strict-vs-lenient-decoding)
- [Literal Sets Have One Owner](#literal-sets-have-one-owner)
- [Generic Helpers over Schemas](#generic-helpers-over-schemas)

## Why Schema

- **Single source of truth**: define once, get TypeScript types + runtime validation + JSON serialization
- **Parse safely**: validate HTTP/CLI/config data with detailed errors
- **Rich domain types**: branded primitives prevent confusion, classes add methods
- **Ecosystem integration**: same schema everywhere (RPC, HttpApi, CLI, frontend, backend)

All representable data composes from two primitives:
- **Records** (AND): a User has a name AND an email AND a createdAt
- **Variants** (OR): a Result is a Success OR a Failure

## Records (AND Types)

Use `Schema.Class` for composite data models:

```typescript
import { Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.Date,
}) {
  get displayName() {
    return `${this.name} (${this.email})`
  }
}

const user = new User({
  id: UserId.make("user-123"),
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date(),
})
```

Reuse a class's field schemas instead of restating them: `User.fields.email`.

## Variants (OR Types)

Simple string/number alternatives with `Schema.Literals`:

```typescript
const Status = Schema.Literals(["pending", "active", "completed"])
type Status = typeof Status.Type // "pending" | "active" | "completed"
```

Structured variants with `Schema.TaggedClass` + `Schema.Union`:

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
const renderResult = (result: Result) =>
  Match.valueTags(result, {
    Success: ({ value }) => `Got: ${value}`,
    Failure: ({ error }) => `Error: ${error}`,
  })
```

## Branded Types

Brand nearly all primitives with semantic meaning. Not just IDs, but emails, URLs, counts, ports, slugs:

```typescript
import { Schema } from "effect"

// Entity IDs
const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

const PostId = Schema.String.pipe(Schema.brand("PostId"))
type PostId = typeof PostId.Type

// Domain primitives
const Email = Schema.String.pipe(Schema.brand("Email"))
type Email = typeof Email.Type

const Port = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
type Port = typeof Port.Type

// Usage: impossible to mix types
const userId = UserId.make("user-123")
const postId = PostId.make("post-456")

function getUser(id: UserId) { /* ... */ }
// getUser(postId) // Type error: can't pass PostId where UserId expected
```

## JSON Encoding and Decoding

Use `Schema.fromJsonString` to combine JSON.parse + schema decoding in one step:

```typescript
import { Effect, Schema } from "effect"

class Move extends Schema.Class<Move>("Move")({
  from: Schema.String,
  to: Schema.String,
}) {}

const MoveFromJson = Schema.fromJsonString(Move)

const program = Effect.gen(function* () {
  // Decode from JSON string
  const jsonString = '{"from":"A1","to":"B2"}'
  const move = yield* Schema.decodeUnknownEffect(MoveFromJson)(jsonString)

  // Encode back to JSON string
  const json = yield* Schema.encodeEffect(MoveFromJson)(move)
  return json
})
```

Use the `FromJson` schema (not the base schema) for both decode and encode when working with JSON strings.

## Common Schema Primitives

| Schema | TypeScript Type | Notes |
|--------|----------------|-------|
| `Schema.String` | `string` | |
| `Schema.Number` | `number` | |
| `Schema.Int` | `number` | Integer validation |
| `Schema.Boolean` | `boolean` | |
| `Schema.Date` | `Date` | Parses from ISO string |
| `Schema.DateTimeUtc` | `DateTime.Utc` | Effect DateTime |
| `Schema.String.check(Schema.isUUID())` | `string` | UUID format validation |
| `Schema.NonEmptyString` | `string` | Min length 1 |
| `Schema.NullOr(S)` | `T \| null` | Key stays REQUIRED — see below |
| `Schema.optionalKey(S)` | `T` (key may be absent) | Absent-only optionality |
| `Schema.optional(S)` | `T \| undefined` (key may be absent) | Absent or undefined |
| `Schema.Array(S)` | `readonly T[]` | Array of schema |
| `Schema.Struct({...})` | `{...}` | Object shape |
| `Schema.Redacted(S)` | `Redacted<T>` | Hidden in logs |
| `Schema.Defect` | `unknown` | Wraps unknown errors |

## Validation Checks

Constraints are `Schema.is*` filters applied through `.check(...)` (variadic; also pipeable as `Schema.check(...)`). The v3 fluent combinators `Schema.pattern` / `minLength` / `maxLength` do not exist in v4:

```typescript
Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))
Schema.String.check(Schema.isPattern(/^[a-z]+$/u, { message: "Expected lowercase letters" }))
Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
Schema.Array(WatchKey).check(Schema.isUnique())
```

Write custom predicates, including invariants across several fields of a struct, with `Schema.makeFilter`. A `Schema.Class` built on a checked struct runs the filter in its constructor, so hand-built test values are checked too:

```typescript
const S = Schema.Struct({ agents: Schema.Array(Agent), loops: Schema.Array(Loop) })
  .check(Schema.makeFilter(loopsReferenceRosteredAgents, {
    message: "Every loop must name a rostered agent",
  }))
class LoadedInstance extends Schema.Class<LoadedInstance>("@app/LoadedInstance")(S) {}
// new LoadedInstance({...}) throws when the filter fails
```

Before writing a validator by hand, check whether effect already has a parser for it: `Cron.parse` returns a `Result`, and there are `DateTime.zoneMakeNamed`, `Schema.URL`, and duration parsers. Validating with the same parser the evaluator uses means config cannot accept a value the evaluator then rejects.

## Optional, Nullable, Defaults

These are three separate things. Mixing up the first two broke a live session on a third-party payload:

- `Schema.NullOr(S)`: the key is **required** and its value may be `null`. `Schema.is` returns `false` when the key is absent.
- `Schema.optionalKey(S)` and `Schema.optional(S)`: the key may be absent, and `optional` also accepts `undefined`. Sparse vendor payloads need these, not `NullOr`.
- Defaults are a separate step, since `Schema.optional` takes no options object in v4. Use the `withDecodingDefault*` family:

```typescript
pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60)))
```

## Decode-Time Transformation

Use `Schema.decodeTo` with `SchemaGetter` to normalize a value while decoding, so the domain type does not have to represent the wire shape:

```typescript
// Accept a nullable wire value, keep the domain type non-null
const orEmpty = <A>(schema: Schema.Codec<A, A, never, never>, empty: A) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((value: A | null) => value ?? empty),
      encode: SchemaGetter.transform((value: A) => value),
    }),
  )

// String env var → branded int
const AppId = Schema.FiniteFromString.pipe(Schema.decodeTo(PositiveInt))
```

Rename keys between the wire format and the domain once, in the schema, with `Schema.encodeKeys`. Domain field names then stay camelCase whatever the wire uses:

```typescript
const Settings = Schema.Struct({ pollInterval: PositiveInt, appId: AppId }).pipe(
  Schema.encodeKeys({ pollInterval: "poll_interval", appId: "app_id" }),
)
```

## Strict vs Lenient Decoding

`onExcessProperty` defaults to `"ignore"`, so decoding **removes unknown keys without reporting them**. In one case this dropped a GraphQL `errors[]` array, and rate-limited responses were then treated as successes. Two rules:

- For a wire format you own, declare every field (`Schema.optionalKey` for the ones that may be absent) and pass `{ onExcessProperty: "error" }`, so an unknown key fails decoding.
- For a stream you don't own, be lenient: log and skip lines the protocol does not need, and fail the operation only when a message it does need fails to decode.

## Literal Sets Have One Owner

Define a literal set (`Schema.Literals([...])`, command lists, state partitions) in one package and import it everywhere else. Derive the other forms from the union type instead of writing them out again: `type Stream = Trigger["on"]` for a key union, and a helper that does not compile when a tag list is missing a tag or contains one that is not in the union. Where order matters, declare it (`WORKFLOW_COMMAND_PRIORITY`) instead of relying on an alphabetical sort.

## Generic Helpers over Schemas

A helper that decodes with a caller-supplied schema and returns `Effect<..., ..., never>` has to constrain the schema's `DecodingServices` to `never`. Otherwise `S["DecodingServices"]` ends up in `R`, which fails as TS2375 under `exactOptionalPropertyTypes`:

```typescript
const fetchJson = <A>(schema: Schema.Codec<A, unknown, never>, request: HttpClientRequest) => ...
```

The alternative is to take a prepared decoder (`Schema.decodeUnknownEffect(schema)`) instead of the schema itself.
