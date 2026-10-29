---
title: usine config
description: Edit stored configuration, import and export YAML and Markdown files, and inspect revision history from the command line.
sidebar:
  order: 6
---

Run `usine config` from the instance folder, where `.usine/runtime.sqlite` stores the configuration and its revision history. Commands work while the orchestrator runs or while it is stopped; they access the local database directly. Each command reads [`.env`](/reference/configuration/cli/#environment-file) first.

```sh
usine config export <folder>
usine config import <folder> [--message <text>]
usine config edit <kind> <name>
usine config log [<kind> <name>]
```

A revision records its number, actor, UTC time, optional message, and each changed entity's before and after values. Commands attribute revisions to the first stored member and require the local admin-token file when members exist. Otherwise they use the stored `operator` login; without one, the revision has no actor.

If the configuration tables are empty, a configuration command imports the instance's bootstrap files as revision 1, just as the first `usine up` does. Later commands and starts ignore those original files. Secrets remain in `.env` or `.usine/github-app.json`; the listen address remains in command flags or environment variables. Configuration changes do not create git commits.

## Export

```sh
usine config export ./config-export
```

`export <folder>` creates the destination if necessary and writes the current configuration as:

| Path | Contents |
| --- | --- |
| `usine.yaml` | Version 2 settings, registry, projects and lanes, labels, and workers. |
| `projects/<project>/loops/<loop>.md` | One loop's frontmatter and prompt. |
| `agents/<agent>.md` | One agent's frontmatter and persona. |

The folder is relative to the working directory, or an absolute path. There are no export-specific options. Existing configuration files are replaced; stale Markdown files in the exported agent and loop directories are removed. Export rewrites complete files, applies schema defaults, and does not preserve YAML comments.

The command prints the exported revision number and absolute destination. It does not include secrets, loop pause state, or revision history. Use [`usine backup`](/reference/configuration/cli/#usine-backup-path) to back up the database, and copy credentials separately.

## Import

```sh
usine config export ./config-export
# Edit the exported files, keeping every entity that should remain configured.
usine config import ./config-export --message "Add the review loop and its labels"
```

`import <folder> [--message <text>]` validates the complete folder, compares it with the stored configuration, and commits the changes in one revision. `--message` is optional and records the supplied text on that revision. The folder argument is required; paths resolve as for export.

Import replaces the complete configuration. Omitting an entity removes it; include the other entities from a fresh export when adding a worker, repository, project, label, loop, or agent. Renaming a file removes the old entity and adds another. A new loop starts paused, except during the first import, which preserves existing pause state. Review new loops before resuming them.

The command prints `Revision <number>: <count> change(s).` and lists each added, changed, or removed entity. An unchanged import prints `No configuration changes.` and saves no revision. An invalid file, expression, or reference rejects the whole import and saves nothing. If another process commits first, a stale-revision error rejects the write; export the latest configuration and reapply the changes.

Version 1 folders with `loops/` are accepted and converted to version 2 projects. Exports use the version 2 layout. See [Project configuration](/reference/configuration/usine-yaml/#projects).

## Edit

```sh
EDITOR=vi usine config edit settings instance
EDITOR=vi usine config edit loop widgets/start-dev
```

`edit <kind> <name>` opens an existing entity in `$EDITOR`, including any editor arguments. It writes a temporary `.yaml` file, or `.md` for a loop or agent, and passes its path to the editor through `sh -c`. Saving and closing the editor validates the result and commits one revision. `EDITOR` must be set to a nonempty command.

| Kind | Name | Editor contents |
| --- | --- | --- |
| `settings` | `instance` | YAML with `version`, `settings`, `operator`, `webhooks`, and `tracing`. |
| `worker` | Worker name | One worker record, without the enclosing `workers:` list. |
| `repository` | `owner/name` | One repository record, without the enclosing `repos:` list. |
| `project` | Project ID | One project record with its repositories and lanes. |
| `label` | Label name | One label record, without the enclosing `labels:` list. |
| `loop` | `project/loop` | Markdown with frontmatter and prompt. A short loop name works only when unambiguous. |
| `agent` | Agent name | Markdown with frontmatter and persona. |

There are no edit-specific options or `--message` flag. Use import to add or remove entities. An unknown entity, a nonzero editor exit, invalid text, or a revision committed while the editor was open saves nothing. Unchanged content saves no revision. Retry an edit against the latest revision after a conflict.

For a non-interactive edit on a system with GNU `sed`, use an editor command that changes the temporary file and exits:

```sh
EDITOR="sed -i 's/poll_interval: 60/poll_interval: 30/'" usine config edit settings instance
```

This changes a polling interval of 60 seconds to 30. If the text does not match, the command reports no configuration changes.

## Log

```sh
usine config log
usine config log agent developer
usine config log loop widgets/start-dev
```

`log [<kind> <name>]` prints tab-separated revision number, actor, ISO 8601 UTC time, and message in ascending revision order. Without arguments it lists all revisions; supply both kind and name to list revisions that changed one entity. It accepts the same entity names as `edit`, with no log-specific options. An entity with no history produces no rows. A revision without an actor prints `(operator not configured)`.

## Live changes and restart requirements

The running orchestrator observes the revision log automatically. A saved revision applies to new work after validation and worker preflight; you do not reload files. Running attempts continue, and open runs retain their submitted task, agent, and parent model. Use **Edit and retry** to change an existing run's definition.

The next poll or schedule tick uses the new loops and registry. Changes to settings, labels, repositories, projects, agents, and loop definitions apply live. Workers can be added, removed, or resized within the running executor's capabilities. A removed worker starts no new attempts, and its running attempts finish.

These changes require a restart:

| Configuration | Fields or changes |
| --- | --- |
| Instance | `webhooks`, `tracing`. |
| Existing worker | `kind`, a rename (`name`), or any setting other than `max_concurrent_attempts`. For SSH workers: `destination`, `identity_file`, `port`, `root`, `gateway`, `container`, `provisioner`. For Cloudflare workers: `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type`, `llm_providers`. |
| Worker set | Changes while no worker executor is registered, as in setup mode, or switching the executor kind. Adding a Cloudflare worker that was not present at startup also needs a restart. |
| Bootstrap values | GitHub App credentials, `.env` and provider or gateway credentials, listen port, origin, and log level. These are outside configuration revisions. |

A CLI write can succeed while the running process refuses to apply it with `RestartRequiredError` or `ReloadPreflightError`. The revision remains saved, and the complete running configuration stays unchanged. Check the orchestrator log for `Stored configuration applied; new runs use the new configuration` or `Configuration revision could not be applied; the running configuration is unchanged`.

After saving a change to startup-only fields, run `usine restart` when no attempt is running. For a failed preflight, correct the worker or save another revision, then apply the saved configuration again with a restart or [an explicit store reread](/reference/configuration/cli/#reload). A successful CLI exit reports a saved revision, not successful application by the running process.

## Exit status

These statuses apply to all four subcommands:

| Status | Meaning |
| --- | --- |
| `0` | The command completed, including an unchanged import or edit, an empty log, or `--help`. |
| `1` | Invalid arguments, missing or unknown entity, unset `EDITOR`, nonzero editor exit, invalid configuration, stale revision, unreadable environment or credential file, or a filesystem or database failure. The diagnostic is on standard error. |

`usine config --help` prints the general CLI usage. Configuration commands do not use the `3` status of `usine status`, and an editor's nonzero status becomes `1` rather than propagating unchanged.
