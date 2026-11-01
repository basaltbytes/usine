# Command-Line Interfaces

## Table of Contents

- [Installation](#installation)
- [Minimal Example](#minimal-example)
- [Arguments and Flags](#arguments-and-flags)
- [Subcommands](#subcommands)
- [Worked Example: Task Manager](#worked-example-task-manager)
- [Quick Reference](#quick-reference)

## Installation

```bash
bun add effect@4.0.6 @effect/platform-bun@4.0.6
```

For Node.js, use `@effect/platform-node@4.0.6` instead.

## Minimal Example

```typescript
import { Argument, Command, Flag } from "effect/cli"
import { BunServices, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"

const name = Argument.String("name").pipe(Argument.withDefault("World"))
const shout = Flag.Boolean("shout").pipe(Flag.withAlias("s"))

const greet = Command.make("greet", { name, shout }, ({ name, shout }) => {
  const message = `Hello, ${name}!`
  return Console.log(shout ? message.toUpperCase() : message)
})

const cli = Command.run(greet, { version: "1.0.0" })

cli.pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
```

In Effect 4.0.6, `Command.run` returns an Effect and reads arguments from `Stdio`. Use `Command.runWith(command, { version })(args)` to supply an argument array without the Node executable or script path. Built-in `--help` and `--version` work automatically. Every command should have `Command.withDescription` for useful help output.

## Arguments and Flags

**Arguments** are positional. **Flags** are named options. Flags must come before arguments.

### Arguments

```typescript
import { Argument } from "effect/cli"

Argument.String("file")                              // required text
Argument.String("output").pipe(Argument.optional)    // optional
Argument.String("format").pipe(Argument.withDefault("json")) // default
Argument.String("files").pipe(Argument.variadic())   // zero or more
Argument.String("files").pipe(Argument.atLeast(1))   // one or more
Argument.Int("id").pipe(Argument.withSchema(TaskId)) // schema-validated
```

### Flags

```typescript
import { Flag } from "effect/cli"

Flag.Boolean("verbose").pipe(Flag.withAlias("v"))     // boolean
Flag.String("output").pipe(Flag.withAlias("o"))       // text
Flag.String("config").pipe(Flag.optional)             // optional text
Flag.Literals("format", ["json", "yaml", "toml"])       // enum
Flag.Int("count").pipe(Flag.withDefault(10))      // integer with default
```

Add descriptions for help output:

```typescript
Argument.withDescription("The task description")
Flag.withDescription("Show all tasks including completed")
```

## Subcommands

```typescript
const add = Command.make("add", { task }, ({ task }) =>
  Console.log(`Adding: ${task}`)
).pipe(Command.withDescription("Add a new task"))

const list = Command.make("list", {}, () =>
  Console.log("Listing tasks...")
).pipe(Command.withDescription("List all tasks"))

const app = Command.make("tasks").pipe(
  Command.withDescription("A simple task manager"),
  Command.withSubcommands([add, list])
)
```

## Worked Example: Task Manager

### Schema

```typescript
import { Array, Option, Schema } from "effect"

const TaskId = Schema.Number.pipe(Schema.brand("TaskId"))
type TaskId = typeof TaskId.Type

class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  text: Schema.NonEmptyString,
  done: Schema.Boolean,
}) {
  toggle() { return new Task({ ...this, done: !this.done }) }
}

class TaskList extends Schema.Class<TaskList>("TaskList")({
  tasks: Schema.Array(Task),
}) {
  static Json = Schema.fromJsonString(TaskList)
  static empty = new TaskList({ tasks: [] })

  get nextId(): TaskId {
    if (this.tasks.length === 0) return TaskId.make(1)
    return TaskId.make(Math.max(...this.tasks.map((t) => t.id)) + 1)
  }

  add(text: string): [TaskList, Task] {
    const task = new Task({ id: this.nextId, text, done: false })
    return [new TaskList({ tasks: [...this.tasks, task] }), task]
  }

  toggle(id: TaskId): [TaskList, Option.Option<Task>] {
    const index = this.tasks.findIndex((t) => t.id === id)
    if (index === -1) return [this, Option.none()]
    const updated = this.tasks[index].toggle()
    const tasks = Array.modify(this.tasks, index, () => updated)
    return [new TaskList({ tasks }), Option.some(updated)]
  }
}
```

### Service

```typescript
import { Context, Effect, FileSystem, Layer } from "effect"

class TaskRepo extends Context.Service<TaskRepo, {
  readonly list: (all?: boolean) => Effect.Effect<ReadonlyArray<Task>>
  readonly add: (text: string) => Effect.Effect<Task>
  readonly toggle: (id: TaskId) => Effect.Effect<Option.Option<Task>>
  readonly clear: () => Effect.Effect<void>
}>()("TaskRepo") {
  static layer = Layer.effect(TaskRepo, Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = "tasks.json"

    const load = Effect.gen(function* () {
      const content = yield* fs.readFileString(path)
      return yield* Schema.decodeEffect(TaskList.Json)(content)
    }).pipe(Effect.orElseSucceed(() => TaskList.empty))

    const save = (list: TaskList) => Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(TaskList.Json)(list)
      yield* fs.writeFileString(path, json)
    })

    return {
      list: Effect.fn("TaskRepo.list")(function* (all?: boolean) {
        const taskList = yield* load
        return all ? taskList.tasks : taskList.tasks.filter((t) => !t.done)
      }),
      add: Effect.fn("TaskRepo.add")(function* (text: string) {
        const list = yield* load
        const [newList, task] = list.add(text)
        yield* save(newList)
        return task
      }),
      toggle: Effect.fn("TaskRepo.toggle")(function* (id: TaskId) {
        const list = yield* load
        const [newList, task] = list.toggle(id)
        yield* save(newList)
        return task
      }),
      clear: Effect.fn("TaskRepo.clear")(function* () {
        yield* save(TaskList.empty)
      }),
    }
  }))
}
```

### Commands

```typescript
import { Argument, Command, Flag } from "effect/cli"
import { Console, Effect, Option } from "effect"

const addCmd = Command.make("add", {
  text: Argument.String("task").pipe(Argument.withDescription("The task description")),
}, ({ text }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const task = yield* repo.add(text)
    yield* Console.log(`Added task #${task.id}: ${task.text}`)
  })
).pipe(Command.withDescription("Add a new task"))

const listCmd = Command.make("list", {
  all: Flag.Boolean("all").pipe(Flag.withAlias("a"), Flag.withDescription("Include completed")),
}, ({ all }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const tasks = yield* repo.list(all)
    if (tasks.length === 0) return yield* Console.log("No tasks.")
    for (const task of tasks) {
      yield* Console.log(`${task.done ? "[x]" : "[ ]"} #${task.id} ${task.text}`)
    }
  })
).pipe(Command.withDescription("List pending tasks"))

const toggleCmd = Command.make("toggle", {
  id: Argument.Int("id").pipe(Argument.withSchema(TaskId)),
}, ({ id }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const result = yield* repo.toggle(id)
    yield* Option.match(result, {
      onNone: () => Console.log(`Task #${id} not found`),
      onSome: (task) => Console.log(`Toggled: ${task.text} (${task.done ? "done" : "pending"})`),
    })
  })
).pipe(Command.withDescription("Toggle a task's done status"))

const clearCmd = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    yield* (yield* TaskRepo).clear()
    yield* Console.log("Cleared all tasks.")
  })
).pipe(Command.withDescription("Clear all tasks"))

const app = Command.make("tasks").pipe(
  Command.withDescription("A simple task manager"),
  Command.withSubcommands([addCmd, listCmd, toggleCmd, clearCmd]),
)
```

### Entry point

```typescript
import { BunServices, BunRuntime } from "@effect/platform-bun"

const cli = Command.run(app, { version: "1.0.0" })
const mainLayer = Layer.provideMerge(TaskRepo.layer, BunServices.layer)

cli.pipe(Effect.provide(mainLayer), BunRuntime.runMain)
```

### Version from package.json

```typescript
import pkg from "./package.json" with { type: "json" }
const cli = Command.run(app, { version: pkg.version })
```

Requires `"resolveJsonModule": true` in tsconfig.

## Quick Reference

| Concept | API |
|---------|-----|
| Define command | `Command.make(name, config, handler)` |
| Positional args | `Argument.String`, `.Int`, `.optional`, `.variadic()` |
| Named flags | `Flag.Boolean`, `.String`, `.Literals`, `.Int` |
| Flag alias | `Flag.withAlias("v")` |
| Descriptions | `Argument.withDescription`, `Flag.withDescription`, `Command.withDescription` |
| Schema validation | `Argument.withSchema(BrandedType)` |
| Subcommands | `Command.withSubcommands([...])` |
| Run CLI | `Command.run(cmd, { version })` |
| Bun platform | `BunServices.layer` + `BunRuntime.runMain` |
| Node platform | `NodeServices.layer` + `NodeRuntime.runMain` |
