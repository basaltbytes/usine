# @usine/config

Reads and edits the authored files in a [usine](https://github.com/basaltbytes/usine) instance folder:

- `usine.yaml` defines the schema version, factory-wide GitHub labels, managed-repo registry, settings, workers, webhook mode, and operator login.
- `loops/*.md` combines strict YAML frontmatter with a Markdown prompt. The parser type-checks the trigger and every `{{ CEL expression }}` against that trigger's payload.
- `agents/*.md` records a named agent's harness, model, effort, optional parent model, optional parent effort, and persona.
- `updateYaml` and `updateFrontmatter` change one path through the YAML document tree while retaining comments, key order, and the Markdown body.

Authored keys are snake_case (`poll_interval`, `max_concurrent_attempts`); the decoded domain types expose camelCase fields (`pollInterval`, `maxConcurrentAttempts`). The rename is part of the schema, so edits encode back to the authored casing.

Declare the GitHub labels used by Loops and Board lanes once. Usine provisions missing declarations in every managed repository; existing definitions are never edited or deleted. `color` is an optional six-digit hexadecimal value without `#`:

```yaml
labels:
  - name: ready-for-agent
    color: a2eeef
    description: Ready for an agent to claim
  - name: ready-for-review
```

Label names follow GitHub's contract: at most 50 characters, no surrounding whitespace, and unique without regard to case; descriptions are at most 100 characters. A lane source or trigger-expression string literal that refers to an undeclared label becomes a non-blocking entry in `LoadedInstance.warnings`; prose in prompt bodies is not inspected.

Set `settings.max_children` to the number of child sessions one Attempt may spawn. The default is 4, and the count includes sequential and concurrent child sessions.

Each managed repository can define an exclusive Board lane map. A lane accepts one or more GitHub label or Item-state sources:

```yaml
repos:
  - name: acme/widget
    lanes:
      - name: Ready
        sources:
          - label: ready-for-agent
      - name: In review
        sources:
          - label: ready-for-review
          - state: pr-open
```

Valid state sources are `issue-open`, `issue-closed`, `pr-open`, `pr-closed`, and `pr-merged`. Lane names and sources must be unique within the repository. Repositories without an authored map receive proposed lanes from the labels observed during GitHub polling.

`workers` must contain at least one uniquely named worker. If the key is absent, the parser supplies one local worker named `local` with a concurrency limit of one. Set `kind` to `local` or `exe.dev` to select its executor, and set `max_concurrent_attempts` to control how many Attempts it can run at once.

`InstanceFolder.load` takes an `InstanceDirectory` (from `@usine/core/instance`) and returns one atomic `LoadedInstance` snapshot. An invalid `usine.yaml` fails the load with a `FactoryConfigError`; an invalid loop enters `quarantinedLoops` with a `ConfigFileError` naming the file and stage, without blocking valid siblings. Invalid agents appear in `invalidAgents`, and loops that name them are quarantined. A `LoadedInstance` always satisfies its own reference rule: every loaded loop names a rostered agent and registered selector entries, enforced at construction. Non-blocking authored-reference diagnostics appear in `warnings`. The `ConfigError` union covers both failure types.

Import factory settings and registry types from `@usine/config/factory`, Board lanes from `@usine/config/board`, and label declarations from `@usine/config/label`. Authored loop, trigger, and agent schemas are available at `/loop`, `/trigger`, and `/agent`; `/selector` provides both the selector schema and matching operation. `/instance` provides `LoadedInstance` and its warnings, while `/file` provides file paths and typed loading failures. Shared identities and agent personas come from their owning `@usine/core` modules.

The package exports Effect services and layers. Import `InstanceFolder` from `@usine/config/instance-folder` and `ConfigParser` from `@usine/config/parser`. Supply `FileSystem.FileSystem` and `Path.Path` implementations when composing `InstanceFolder.layer`; `ConfigParser.layer` requires `ExpressionEngine` from `@usine/expression/expression-engine`.

All APIs remain 0.x and can change between minor releases.
