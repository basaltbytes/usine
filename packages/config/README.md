# @usine/config

Reads and edits the authored files in a [usine](https://github.com/basaltbytes/usine) instance folder:

- `usine.yaml` holds the schema version, managed-repo registry, settings, workers, webhook mode, and operator login.
- `loops/*.md` combines strict YAML frontmatter with a Markdown prompt. The parser type-checks the trigger and every `{{ CEL expression }}` against that trigger's payload.
- `agents/*.md` records a named agent's harness, model, effort, optional parent model, and persona.
- `updateYaml` and `updateFrontmatter` change one path through the YAML document tree while retaining comments, key order, and the Markdown body.

Authored keys are snake_case (`poll_interval`, `max_concurrent_attempts`); the decoded domain types expose camelCase fields (`pollInterval`, `maxConcurrentAttempts`). The rename is part of the schema, so edits encode back to the authored casing.

`workers` must contain at least one uniquely named worker. If the key is absent, the parser supplies one local worker named `local` with a concurrency limit of one. Set `kind` to `local` or `exe.dev` to select its executor, and set `max_concurrent_attempts` to control how many Attempts it can run at once.

`InstanceFolder.load` takes an `Instance.Directory` (from `@usine/core`) and returns one atomic `LoadedInstance` snapshot. An invalid `usine.yaml` fails the load with a `FactoryConfigError`; an invalid loop enters `quarantinedLoops` with a `ConfigFileError` naming the file and stage, without blocking valid siblings. Invalid agents appear in `invalidAgents`, and loops that name them are quarantined. A `LoadedInstance` always satisfies its own reference rule: every loaded loop names a rostered agent and registered selector entries, enforced at construction. The `ConfigError` union covers both failure types.

The package exports Effect services and layers. Supply `FileSystem.FileSystem` and `Path.Path` implementations when composing `InstanceFolder.layer`; `ConfigParser.layer` requires `ExpressionEngine` from `@usine/expression`.

All APIs remain 0.x and can change between minor releases.
