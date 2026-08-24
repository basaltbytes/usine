# @usine/config

Reads and edits the authored files in a [usine](https://github.com/basaltbytes/usine) instance folder:

- `usine.yaml` holds the schema version, managed-repo registry, settings, workers, webhook mode, and operator login.
- `loops/*.md` combines strict YAML frontmatter with a Markdown prompt. The parser type-checks the trigger and every `{{ CEL expression }}` against that trigger's payload.
- `agents/*.md` records a named agent's harness, model, effort, optional parent model, and persona.
- `updateYaml` and `updateFrontmatter` change one path through the YAML document tree while retaining comments, key order, and the Markdown body.

`InstanceFolder.load` returns one atomic snapshot. An invalid `usine.yaml` fails the load; an invalid loop enters `quarantinedLoops` without blocking valid siblings. Invalid agents appear in `invalidAgents`, and loops that name them are quarantined.

The package exports Effect services and layers. Supply `FileSystem.FileSystem` and `Path.Path` implementations when composing `InstanceFolder.layer`; `ConfigParser.layer` requires `ExpressionEngine` from `@usine/expression`.

All APIs remain 0.x and can change between minor releases.
