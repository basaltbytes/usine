---
title: usine config
description: Configuration commands, revisions, entity names, and live application.
---

Run configuration commands from the instance folder. They read and write `.usine/runtime.sqlite` directly and work with the orchestrator running or stopped. Each command reads the [environment file](/reference/cli/#environment-file). Revisions record a number, actor, UTC time, optional message, and the changed entities' before and after values. Local writes record **local admin** and do not create git commits.

## Export

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `<folder>` | path | required | Destination created if necessary for the configuration snapshot. |

```sh
usine config export ./config-export
```

The command prints the revision and absolute destination. It replaces export files, removes stale entity files, and excludes credentials, history, and loop pause state. See [Import and export format](/reference/configuration/import-export/).

## Import

| Argument or option | Type | Default | Description |
| --- | --- | --- | --- |
| `<folder>` | path | required | Complete configuration snapshot that replaces stored configuration. |
| `--message <text>` | string | omitted | Message recorded on the revision. |

```sh
usine config import ./config-export --message "Add the review loop"
```

Import validates all entities, expressions, and references before saving one revision. Omitting an entity removes it. New loops start paused. Unchanged content prints `No configuration changes.` and saves nothing. A stale revision rejects the write; export the latest state and reapply changes.

## Edit

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `<kind>` | entity kind | required | Entity type from the table below. |
| `<name>` | entity identifier | required | Existing entity to edit. |
| `EDITOR` | environment command | required | Editor command, including arguments, invoked with a temporary entity path. |

```sh
EDITOR=vi usine config edit settings instance
EDITOR=vi usine config edit loop widgets/start-dev
```

Saving and closing the editor validates the result and commits one revision. A nonzero editor exit, invalid content, unknown entity, or revision saved while the editor was open saves nothing. Unchanged content saves no revision. Use the UI or a complete import to create or delete entities.

## Entity identifiers

| Kind | Type of identifier | Default | Description |
| --- | --- | --- | --- |
| `settings` | `instance` | required | Singleton instance settings. |
| `repository` | `owner/name` | required | Managed repository in the registry. |
| `project` | project ID | required | Project membership and lanes. |
| `worker` | worker name | required | Worker connection and capacity. |
| `loop` | `project/loop` | required | Loop definition, with an unambiguous short name also accepted. |
| `agent` | agent name | required | Brain spec and persona. |
| `label` | label name | required | Declared GitHub label. |
| `binding` | binding name | required | Member role and scope. |

For example, `usine config edit binding alice-widgets` edits one role binding. [Entity references](/reference/) describe the fields.

## Log

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `<kind> <name>` | entity key | all revisions | Restricts history to one entity when both arguments are supplied. |

```sh
usine config log
usine config log agent developer
```

Output has tab-separated revision number, actor, ISO 8601 UTC time, and message in ascending order. An empty history prints no rows.

In the web UI, **Configuration > History** shows revisions, export-format diffs, and revert controls. Revision buttons align with the content column. Expand a revision to see a diff that starts with the `---` and `+++` file headers. Choose an **Entity type**, enter an **Entity name**, and select **Filter history** to restrict the list to one entity. For loops, use the qualified name, such as `usine/start-dev`; for settings, use `instance`. The `kind` and `identifier` URL parameters preserve the filter when you share the link. **All entities** clears the filter. You can filter by a deleted entity's name.

Repository links on configuration pages show the owner's GitHub avatar. The repository's initial appears while the image loads or if it fails.

Each configuration entity page links to its filtered history beside the title. In an entity editor, **Cmd+Enter** or **Ctrl+Enter** saves the form. When a revision is available, the link shows who changed the entity and when. **Revert** restores every entity in the selected revision and creates a new revision. Instance admins can revert revisions; project maintainers can revert a revision that changes only the selected project or loop. Later changes can prevent a revert. Review the affected entities before confirming.

## Revision application

The running orchestrator observes the revision log and validates changes before applying them to new work. Running attempts continue with their definitions. Open runs retain their submitted task and agent; **Edit and retry** replaces them for later attempts.

Settings, labels, registry entries, projects, loops, agents, and webhook sources apply live. Worker additions and increased capacity run preflight; removed workers start no new attempts and let running attempts finish. Reduced capacity admits no new attempt until usage falls below the limit. All workers must share the running executor kind.

SSH and Cloudflare connection changes apply to new work. Retained attempts keep their machine, container limits, gateway, and client through recovery. Their connection records are in `.usine/attempt-connections/`; back up that directory and keep the referenced variables and SSH key files until recovery finishes. Failed connection checks block new attempts on that worker and retry automatically.

These settings require a restart:

| Change | Type | Default | Description |
| --- | --- | --- | --- |
| `tracing` | startup setting | unchanged | Initializes the process-wide exporter. |
| `auth` | startup setting | unchanged | Initializes browser origin middleware. |
| Worker name or `kind` | worker identity | unchanged | Determines stored identities and executor selection. |
| Executor kind or any `workers` change in setup mode | runtime capability | unchanged | Requires executor initialization. |
| Credentials, `.env`, listen port, canonical origin, or log level | process input | unchanged | Initializes services outside configuration revisions. |

For example, after changing browser origins with the CLI, run `usine restart` when no attempt is running.

Before applying a revision, the orchestrator checks the coordinator brain of each agent: the parent model, effort, and credential. Agents that share a parent model and effort share one check. If the check doesn't finish within 10 seconds, the save or reload is refused with `ValidationTimeoutError` (HTTP 504), and no revision is stored. Each step of a save or reload logs `Configuration step finished` with its `step`, `durationMillis`, and `outcome`:

| Step | Type | Default | Description |
| --- | --- | --- | --- |
| `wait` | step | none | Waits for a save or reload that is already running. |
| `read` | step | none | Reads the configuration store. |
| `parse` | step | none | Parses and validates the changed entities. |
| `restart` | step | none | Checks for changes that require a restart. |
| `coordinator-brains` | step | 10-second limit | Checks each agent's coordinator brain. |
| `worker-preflight` | step | none | Runs preflight for added workers, added capacity, and new brains. |
| `store` | step | none | Stores the revision. |
| `apply` | step | none | Applies the revision to new work. |

The UI refuses a revision that requires a restart, fails preflight, or runs out of time. CLI commands can save it while the process keeps the accepted configuration. A successful CLI exit confirms storage. Check logs for `Stored configuration applied; new runs use the new configuration` or `Configuration revision could not be applied; the running configuration is unchanged`. Correct rejected settings or restart to apply them. `SIGUSR1` requests an explicit store reread.

## Exit status

| Status | Type | Default | Description |
| --- | --- | --- | --- |
| `0` | exit code | success | Command completed, including unchanged content, empty history, or help. |
| `1` | exit code | failure | Invalid usage, editor failure, invalid configuration, stale revision, or storage failure, with a diagnostic on standard error. |
