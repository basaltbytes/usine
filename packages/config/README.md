# @usine/config

Stores versioned configuration and imports and exports the files of a [usine](https://github.com/basaltbytes/usine) instance folder. The [`usine.yaml`](https://docs.usine.dev/reference/configuration/usine-yaml/), [loop file](https://docs.usine.dev/reference/configuration/loop-files/), and [agent file](https://docs.usine.dev/reference/configuration/agent-files/) references describe every key.

- `usine.yaml`: schema version, factory-wide GitHub labels, the managed-repo registry, projects, settings, workers, webhook mode, and operator login.
- `projects/<project>/loops/*.md`: strict YAML frontmatter and a Markdown prompt. The parser type-checks the trigger and every `{{ CEL expression }}` against the trigger's payload.
- `agents/*.md`: harness, model, effort, optional parent model and parent effort, and persona.

`updateYaml` and `updateFrontmatter` change one path in the YAML tree and keep comments, key order, and the Markdown body. Files use snake_case keys (`poll_interval`, `max_concurrent_attempts`); decoded types use camelCase (`pollInterval`, `maxConcurrentAttempts`). The schema does the rename, so edits keep snake_case.

## Labels and lanes

Declare the labels that loops and lanes use once. usine creates missing labels in every managed repo and never edits or deletes labels:

```yaml
labels:
  - name: ready-for-agent
    color: a2eeef
    description: Ready for an agent to claim
  - name: ready-for-review
```

An undeclared label in a lane source or a trigger expression string literal adds a non-blocking entry to `LoadedInstance.warnings`. Prompt prose isn't checked.

Each project owns an ordered list of registered repositories and one lane map. A repository belongs to at most one project. A registered repository without a project has no board and runs no loops. Label lanes match by name in every member repository, and polling creates missing lane labels.

For example:

```yaml
version: 2
repos:
  - name: acme/widget
  - name: acme/widget-api
projects:
  - id: widget
    name: Widget
    repositories: [acme/widget, acme/widget-api]
    lanes:
      - name: Ready
        sources:
          - label: ready-for-agent
      - name: In review
        sources:
          - label: ready-for-review
          - state: pr-open
```

`isSettledItemState` reports the settled states, `issue-closed`, `pr-closed`, and `pr-merged`; the board places such an item by state alone, whatever its labels. A project without a lane map gets proposed lanes from the labels that polling finds.

## Settings and workers

`settings.max_children` (default 4) limits the child sessions, sequential and concurrent, that one attempt can start. Without a `workers` key, the parser adds a local worker named `local` that runs one attempt at a time. A worker's `kind` (`local`, `exe.dev`, or `ssh`) selects its executor. An SSH worker's `container` (`WorkerContainer`) sets the image and the `cpus`, `memory_mib`, and `pids` limits of each attempt container; each limit is optional, and the executor derives an unset one from the machine at preflight.

Issue and pull request loops accept `max_cycles`, a positive integer (default 3): the number of runs each loop can open on an item between operator resets. The first admission past it blocks runs from every loop on the item. Schedule loops are exempt. See [Write review and fix loops](https://docs.usine.dev/guides/review-fix-loops/).

A loop's optional `priority`, a positive integer (`LoopFile.priority`, `LoopPriority`), ranks its runs for a free worker slot before runs that lane order ranks, higher first. See [Loop files](https://docs.usine.dev/reference/configuration/loop-files/#priority).

## Load an instance

`InstanceFolder.load` takes an `InstanceDirectory` (`@usine/core/instance`) and returns one atomic `LoadedInstance` snapshot:

- An invalid `usine.yaml` fails the load with `FactoryConfigError`.
- An invalid loop goes to `quarantinedLoops` with a `ConfigFileError` naming the file and stage. Valid loops still load.
- Invalid agents go to `invalidAgents`, and loops that use them are quarantined.
- Non-blocking reference diagnostics go to `warnings`.

`ConfigError` is the union of both errors. The `LoadedInstance` constructor enforces that every loop references a rostered agent and registered selector entries.

## Imports

Subpaths: `/factory` (settings and registry), `/board` (lanes), `/project` (project schema, loop scope, migration, and unique short-name resolution), `/label`, `/loop`, `/trigger`, `/agent`, `/selector` (schema and matching), `/instance` (`LoadedInstance` and warnings), and `/file` (file paths and loading failures). Shared identities and agent personas come from `@usine/core`.

`InstanceFolder` (`/instance-folder`) and `ConfigParser` (`/parser`) are Effect services. `InstanceFolder.layer` needs `FileSystem.FileSystem` and `Path.Path`; `ConfigParser.layer` needs `ExpressionEngine` from `@usine/expression/expression-engine`.

The 0.x APIs can change between minor releases.

For a global server installation managed by systemd, `settings.upgrade_channel` selects `latest` (default) or `next`. `settings.upgrade_mode` selects `off`, `propose` (default), or `automatic`. Committed configuration revisions apply both settings; automatic mode waits for admitted attempts to finish before upgrading.

## Configuration revisions

`ConfigurationStore` from `/configuration` reads the current `Configuration`, lists revisions (optionally by entity), reads one revision, commits changes with an expected revision number, and streams revisions after a supplied number. A `ConfigurationRevision` records the actor, time, optional message, and before and after values for settings, workers, repositories, projects (including lanes), labels, loops, and agents. The actor is optional for instances without an `operator` value.

Revision changes record order only for workers, because worker order determines scheduling preference. A change's optional `position` is a zero-based index in the resulting worker list. The diff detects moves by comparing the relative order of workers present in both configurations. Adding or removing an entity leaves unrelated entities out of the revision; reordering repositories, labels, loops, or agents produces no changes.

Historical revisions that record positions in the combined entity list require conversion to worker-relative positions before replay through `commit`. Stored configuration snapshots remain readable.

`commit(parser, current, expected, changes, metadata)` performs deterministic validation without filesystem, database, or clock services. Supply the parser explicitly with `makeConfigParser(makeExpressionEngine())`, and supply the actor and time. It returns the new configuration and revision or `StaleRevision` or `ConfigurationInvalid`. Validation uses the file schemas, CEL checks, and reference checks. `ConfigurationInvalid.problems` contains the errors collected across the candidate.

`memoryConfigurationLayer` from `/memory` uses a `Ref`. `sqliteConfigurationLayer` from `/sqlite` requires `SqlClient` and `ConfigParser`; the application supplies the connection. SQLite commits update the revision log and entity rows in one transaction. The Drizzle schema and migrations are in this package, with their own `usine_configuration_migrations` ledger. Run `pnpm db:generate` after changing the schema; the command embeds the generated SQL so the adapter needs no filesystem or Node driver. Revision streams poll the durable log every 500 ms while idle, including commits from other processes.

`ConfigurationFolder` from `/folder-codec` imports a folder strictly and exports the current format. It rejects invalid configuration as a whole, including invalid loop and agent files. `InstanceFolder.load` remains the permissive inspection API for callers that need quarantine diagnostics. Export writes complete YAML and Markdown files; it does not preserve YAML comments and removes stale Markdown entity files in the destination. It does not export secrets or loop pause state.

Entity values use schema encoding with parser defaults applied. Exporting and importing unchanged configuration produces an empty diff. Diffs compare the relative order of retained entities, so adding or removing a worker does not mark later entities as changed. Reordering workers records their changed preference order.

Boat workers accept a gateway with `provisioner.snapshot` and `provisioner.tailnet`. The tailnet settings contain the gateway address and OAuth environment-variable names; parsing rejects a gateway without both settings. See the [provisioned-worker guide](https://docs.usine.dev/guides/add-a-provisioned-worker/#gateway-subscriptions-over-tailscale).

`Configuration.actor` returns the configured operator login for revision attribution. Schema errors include structured `details` with field paths and messages. Configuration validation associates problems in workers, repositories, and labels with their entity keys.

`revertConfiguration(parser, target, history, current)` computes reverse changes from the revision log, restoring workers relative to surviving workers in the current snapshot. It preserves unrelated changes and returns `ConfigurationRevertBlocked` with the entity keys changed by later revisions. Commit the returned changes with the expected current revision to prevent a concurrent write from being overwritten.

Both SSH provisioners accept `timings` with `ssh_wait`, `creation_backoff_min`, `creation_backoff_max`, and `machine_check_interval`, in positive whole seconds. Parsing defaults them to 600, 30, 600, and 86400 and rejects reversed backoff bounds.

`parseConfigurationForm(key, text)` and `validateConfigurationForm(key, value)` from `/folder-codec` support agent, worker, repository, and settings forms. They use the entity schemas and return `ConfigFileError` with field paths. Agent drafts use the JSON codec of `AgentFile`; other drafts use the export-format keys. `WorkerFromYaml` from `/factory` exposes the worker schema with snake_case keys and cross-field checks.

Loop form drafts use `parseConfigurationForm` and `validateConfigurationForm` from `/folder-codec`. They preserve the loop's JSON representation while expressions are incomplete. Saving checks the schema, CEL expressions, prompt interpolations, and references. Expression diagnostics include the field path, expression, and a zero-based position when the CEL checker provides one.

## Project migration

Configuration version 2 stores projects separately from the repository registry. Loops use `project/loop` identities; a short name resolves while it is unique across projects. Selectors narrow the repositories within the owning project.

`migrateProjects` converts version 1 snapshots to one project per registered repository and copies each loop into every project whose repository its selector matched. `ConfigurationFolder.import` accepts the legacy `loops/*.md` layout and converts it. Export writes a `projects` block in `usine.yaml` and `projects/<project>/loops/*.md`. Historical version 1 revisions remain readable. A version 2 store rejects a downgrade to version 1; import legacy files to convert their contents instead.
