# Config

## Table of Contents

- [How Config Works](#how-config-works)
- [Basic Usage](#basic-usage)
- [Config Service Pattern](#config-service-pattern)
- [Config Primitives](#config-primitives)
- [Defaults and Fallbacks](#defaults-and-fallbacks)
- [Validation with Schema](#validation-with-schema)
- [Config Providers](#config-providers)
- [Redacted Secrets](#redacted-secrets)

## How Config Works

By default, `Config` reads from environment variables. Override with `ConfigProvider`:
- **Production**: environment variables (default)
- **Tests**: in-memory maps or `Layer.succeed` with test values
- **Development**: JSON files or hardcoded values

## Basic Usage

```typescript
import { Config, Effect } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("API_KEY")
  const port = yield* Config.Int("PORT")
  console.log(`Starting on port ${port}`)
})
```

Override the provider:

```typescript
import { ConfigProvider, Layer } from "effect"

const testConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ API_KEY: "test-key", PORT: "3000" })
)

Effect.runPromise(program.pipe(Effect.provide(testConfigLayer)))
```

## Config Service Pattern

**Best practice:** Create a config service with `layer` and `testLayer`:

```typescript
import { Config, Context, Effect, Layer, Redacted } from "effect"

class ApiConfig extends Context.Service<
  ApiConfig,
  {
    readonly apiKey: Redacted.Redacted
    readonly baseUrl: string
    readonly timeout: number
  }
>()("@app/ApiConfig") {
  static readonly layer = Layer.effect(
    ApiConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.Redacted("API_KEY")
      const baseUrl = yield* Config.String("API_BASE_URL").pipe(
        Config.orElse(() => Config.succeed("https://api.example.com"))
      )
      const timeout = yield* Config.Int("API_TIMEOUT").pipe(
        Config.orElse(() => Config.succeed(30000))
      )
      return { apiKey, baseUrl, timeout }
    })
  )

  // Tests: inline values, no ConfigProvider needed
  static readonly testLayer = Layer.succeed(ApiConfig, {
    apiKey: Redacted.make("test-key"),
    baseUrl: "https://test.example.com",
    timeout: 5000,
  })
}
```

**Why this pattern:**
- Separates config loading from business logic
- Easy to swap implementations (layer vs testLayer)
- Config errors caught early at layer composition
- Type-safe throughout your app

For tests, just `Layer.succeed` with hardcoded values. No need for `ConfigProvider.fromUnknown`.

## Config Primitives

```typescript
Config.String("MY_VAR")           // string
Config.Number("PORT")             // number
Config.Int("MAX_RETRIES")         // integer
Config.Boolean("DEBUG")           // boolean
Config.Redacted("API_KEY")        // hidden in logs
Config.URL("API_URL")             // URL
Config.Duration("TIMEOUT")        // Duration
Config.Array(Schema.String, "TAGS") // comma-separated array
```

## Defaults and Fallbacks

```typescript
// With orElse
const port = yield* Config.Int("PORT").pipe(
  Config.orElse(() => Config.succeed(3000))
)

// Optional values (returns Option<string>)
const optionalKey = yield* Config.option(Config.string("OPTIONAL_KEY"))
```

Compose several independently-optional variables with `Config.all`:

```typescript
const settings = yield* Config.all({
  appId: Config.option(Config.schema(AppId, "APP_ID")),
  privateKey: Config.option(Config.redacted("PRIVATE_KEY")),
})
```

A missing variable is fine; a variable that is set but invalid is an error. `Config.option` turns a missing variable into `Option.none()`. A variable that is present and fails validation must fail the load instead of falling back to a default, because the operator set it and expects it to be used.

To build a `Record<string, string>` from an allowlist of optional variables, read each with `Config.option`, collect the present ones with `Arr.getSomes`, and `Effect.orDie` the remaining `ConfigError`: if the process environment cannot be read, the app cannot start anyway.

## Validation with Schema

Use `Config.schema` for type-safe validation:

```typescript
import { Config, Schema } from "effect"

const Port = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
type Port = typeof Port.Type

const Environment = Schema.Literals(["development", "staging", "production"])

const program = Effect.gen(function* () {
  const port = yield* Config.schema(Port, "PORT")     // branded Port
  const env = yield* Config.schema(Environment, "ENV") // validated enum
})
```

## Config Providers

```typescript
import { ConfigProvider, Layer } from "effect"

// From object
ConfigProvider.layer(ConfigProvider.fromUnknown({ API_KEY: "key", PORT: "3000" }))


// Prefixed env vars (reads APP_API_KEY, APP_PORT, etc.)
ConfigProvider.layer(ConfigProvider.fromEnv().pipe(ConfigProvider.nested("APP")))
```

## Redacted Secrets

Always use `Config.Redacted()` for sensitive values:

```typescript
import { Config, Redacted } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("API_KEY")

  // Extract value when needed
  const headers = { Authorization: `Bearer ${Redacted.value(apiKey)}` }

  // Hidden in logs
  console.log(apiKey) // Output: <redacted>
})
```

Use `Schema.Redacted(Schema.String)` in config schemas. `Schema.Redacted` validates its label, so a second declaration of the same redacted schema with a different label, or none, rejects values built from the first. Export one schema constant per secret and import it everywhere. `Schema.RedactedFromValue` converts an already-decoded raw value into a `Redacted`.

```typescript
class DatabaseConfig extends Context.Service<
  DatabaseConfig,
  { readonly host: string; readonly port: number; readonly password: Redacted.Redacted }
>()("@app/DatabaseConfig") {
  static readonly layer = Layer.effect(DatabaseConfig, Effect.gen(function* () {
    const host = yield* Config.schema(Schema.String, "DB_HOST")
    const port = yield* Config.schema(Port, "DB_PORT")
    const password = yield* Config.schema(Schema.Redacted(Schema.String), "DB_PASSWORD")
    return { host, port, password }
  }))
}
```
