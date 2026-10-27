# Child Processes & Scopes

Verified against `effect@4.0.6`. v4 has no `Command` module; the `@effect/platform` `Command` API is v3. Child processes are in `effect/process`. For fork variants, see [runtime-and-concurrency.md](runtime-and-concurrency.md#fork-family).

## Table of Contents

- [Spawning with ChildProcess](#spawning-with-childprocess)
- [Spawn Option Gotchas](#spawn-option-gotchas)
- [Reading Output Streams](#reading-output-streams)
- [Scope Patterns](#scope-patterns)
- [Killable Background Process](#killable-background-process)

## Spawning with ChildProcess

```typescript
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Effect, Stream } from "effect"

const runCommand = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", ["status"], {
      env,               // allowlisted environment
      extendEnv: false,  // do NOT inherit the host env
      detached: false,
      forceKillAfter: "10 seconds",
    }),
  )
  const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
  const exitCode = yield* handle.exitCode
  return { exitCode, stdout }
}).pipe(Effect.scoped) // process killed when the scope closes
```

The Node implementation comes from `@effect/platform-node` (`NodeServices.layer`). To type a service value in a helper signature, use the tag's `"Service"` projection: `spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]`. The exported name on its own is the tag class, which has no `.spawn` method.

## Spawn Option Gotchas

Both of these were review blockers:

- **`detached` defaults to `true` on non-Windows.** The child gets its own process group, so killing the parent process group does not kill the child. Pass `detached: false` unless you want the child to outlive the parent.
- **`forceKillAfter` has no default.** Without it, a graceful kill waits indefinitely on a process that ignores SIGTERM. Set it to get a SIGTERM, then a SIGKILL after the timeout.

Set the child environment explicitly with `env` and `extendEnv: false`, so the child gets an allowlist instead of the whole host environment.

## Reading Output Streams

`Stream.decodeText()` then `Stream.mkString` for whole-output capture, or `Stream.splitLines` for line protocols.

**`Stream.splitLines` emits `""` for blank lines**: `\n\n` produces an empty element. A line-protocol decoder that fails on any undecodable line therefore fails on a stray newline. Skip blank lines, and log then skip lines the protocol does not need (see [data-modeling.md](data-modeling.md#strict-vs-lenient-decoding) on strict vs lenient decoding).

Writing to stdin: `Stream.make(new TextEncoder().encode(input)).pipe(Stream.run(handle.stdin))`.

## Scope Patterns

### Automatic (Short-Lived)

`Effect.scoped` creates and closes the scope around the effect:

```typescript
const output = yield* Effect.scoped(
  Effect.gen(function* () {
    const handle = yield* spawnProcess(cmd)
    return yield* collectOutput(handle.stdout)
  })
)
// process auto-killed when scope exits
```

### Manual (Long-Lived, Killable)

Use `Scope.make()` for external lifetime control:

```typescript
import { Effect, Scope, Exit } from "effect"

const scope = yield* Scope.make()
const handle = yield* spawnProcess(cmd).pipe(Scope.provide(scope))
// later, to tear down:
yield* Scope.close(scope, Exit.void)
```

`Scope.provide` ties the resource to the scope and removes `Scope` from the effect's requirements.

### acquireRelease

```typescript
const connection = yield* Effect.acquireRelease(
  openConnection(),                                    // acquire
  (conn) => closeConnection(conn).pipe(Effect.orDie)   // release
)
```

## Killable Background Process

```typescript
const startBackground = (command: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner
      .spawn(ChildProcess.make("bash", ["-c", command], { detached: false, forceKillAfter: "10 seconds" }))
      .pipe(Scope.provide(scope))

    // Fork ONLY the output collection, never the scoped acquisition
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
        const exitCode = yield* handle.exitCode
        // store results...
      }).pipe(Effect.ignore)
    )

    return { handle, scope }
  })

const kill = (shell: { handle: Handle; scope: Scope.CloseableScope }) =>
  Scope.close(shell.scope, Exit.void)
```

Anti-pattern: acquiring the process inside a detached fiber's own `Effect.scoped` makes it unreachable from outside that fiber. Acquire it into a scope you control, and fork only the output collection.
