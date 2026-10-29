# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory: a thin Node adapter over `@usine/orchestrator`. The library does the polling, schedule triggers, durable execution, worker composition, and operator actions; this package serves their JSON and web surfaces. The [CLI reference](https://docs.usine.dev/reference/configuration/cli/) lists every command, flag, and variable, and [Operate runs](https://docs.usine.dev/guides/operate-runs/) covers day-to-day use.

Run it from an instance folder:

```sh
usine up
```

It prints `http://127.0.0.1:7331` and stays attached to the terminal. Every command reads `.env` in the instance folder for the variables that the environment doesn't set, as dotenv does, so keep tokens there to run the commands from any shell. `--port <port>` or `USINE_PORT` changes the port; if the port is taken, the CLI names the conflict and suggests the override. `--origin <url>` or `USINE_ORIGIN` names the URL at which a proxy, such as `tailscale serve`, publishes the UI; the operator API then accepts browser requests from pages there too. `--log-level <level>` or `USINE_LOG_LEVEL` sets the lowest level it logs, `info` by default; `debug` adds the lines that say why something was skipped. Each log line starts with its date and time in UTC. `usine --version` prints the `@usine/server` version that the instance pins. On macOS, `usine up` warns if the Mac can sleep, which drops the SSH connections to workers: run `caffeinate -s` while runs are open, or turn off sleep on AC power with `sudo pmset -c sleep 0`.

One `usine up` runs per instance folder. It holds `.usine/instance.lock` from startup until every store closes, writes its pid to `.usine/instance.pid`, and writes its pid, port, version, start time, and command line to `.usine/instance.json`. It removes both files when it exits. It reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start; the ID labels its attempt containers on SSH workers, so that another instance with the same GitHub App doesn't remove them. A second `usine up` there names the running process and exits nonzero before opening a store. A draining process keeps the folder until it exits.

At startup, a failed worker preflight excludes that worker from scheduling while the other workers start and the API listens. **Needs attention** shows the worker and its preflight message. Checks retry after 1, 2, 5, and 10 minutes, then every 10 minutes; a passing check restores scheduling and clears the entry. A configuration revision that changes the worker's slot count checks it immediately. Configuration writes still refuse a revision whose preflight fails. Startup exits with an error if every worker fails preflight, or if a database, GitHub App, or listen-address error prevents startup.

## Manage the instance

```sh
usine up --detach   # start in the background, with the output in .usine/usine.log
usine status        # running or not, pid, address, version, uptime, open runs; exit 3 if stopped
usine stop          # send SIGTERM and wait for the drain; --force ends the drain
usine restart       # stop, then start the recorded command line in the background
usine upgrade       # back up, move the @usine/server pin, install, commit, and restart
```

`stop`, `restart`, and `upgrade` wait `--timeout` seconds (120 by default) for each stop. With `--force`, they send `SIGKILL` to a process that still runs after the timeout. Each start, including `usine up --detach`, waits until the new process listens, which it does after startup recovery, and gives up only when the process writes no line to `.usine/usine.log` for that long. Without a readable `.usine/instance.json`, `restart` checks the pid in `.usine/instance.pid` on the port where it answers, stops it, and starts `usine up` as `usine up --detach` without flags would. `restart` and `upgrade` refuse while a run has a running attempt, unless `--force`, and when neither the shell nor `.env` sets a gateway's admin token variable, because the new process inherits the shell's environment and reads `.env`. `upgrade` applies to an instance that installs `@usine/server` from its own `package.json` pin; for a checkout, pull and build it, then run `usine restart`.

`usine up` records the systemd service whose cgroup it runs in, such as `usine.service`. If systemd reports the process as that service's main process, `stop`, `restart`, and `upgrade` stop it with `systemctl stop --no-block` and start it with `systemctl start`, so that systemd keeps managing it, and `status` names the service. A start whose service fails or waits to restart is stopped, so that it doesn't repeat.

Without GitHub App credentials, it logs the typed error, leaves both trigger streams idle, and opens the setup screen in the default browser. The browser command times out after two seconds; a failed opener only logs a warning. Runs, transcripts, and loop pause state stay readable, and stored configuration can be edited, but interventions are unavailable. Supply `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, or `app_id` and `private_key` in a mode-0600 `.usine/github-app.json`. Credentials are read only at startup, so restart `usine up` after adding them, as the setup screen says.

## Configuration commands

The first start imports `usine.yaml`, `agents/`, and `loops/` as revision 1, with the operator as actor and the message `Imported from the instance folder`. Invalid files prevent the import. Later starts read configuration only from `.usine/runtime.sqlite`. Keep `.env`, `.usine/github-app.json`, and the listen address in files or environment variables.

```sh
usine config export ./configuration
usine config import ./configuration --message "Update worker slots"
usine config edit agent developer
usine config log
usine config log agent developer
```

Importing an unchanged export prints `No configuration changes.` and saves no revision. Adding or removing a worker records only that worker; unchanged loops and other entities keep their existing history.

These commands work while `usine up` runs and while it is stopped. `edit` uses `$EDITOR` and refuses an edit if another revision was committed meanwhile. Entity kinds are `settings` (name `instance`), `worker`, `repository`, `label`, `loop`, and `agent`. Imports print the changed entities and save one revision, or report all validation problems without saving. A configuration with no differences saves no revision. Revisions apply live after worker preflight; restart-required changes remain stored until restart.

The [configuration revisions API](../../packages/orchestrator/README.md#configuration-revisions-api) reads history and accepts JSON or export-format entity edits. API writes check runtime compatibility before saving and apply accepted revisions without a reload. New loops created by API writes or CLI imports start paused; the initial migration preserves existing pause states. The server commits loop creation and its pause state in one SQLite transaction.

## Web UI

Each project opens as a board of authored or proposed lanes; proposed lanes are read-only. To enable moves, edit the repository with `usine config edit repository <owner/name>` (see the [lane example](../../packages/config/README.md)). Moving an item to an authored label-backed lane swaps only the labels in that map and keeps other labels; polling then evaluates label-driven loops. Cards show the latest run and open its drawer. Retry controls describe the saved harness and model. The drawer flags a changed agent definition, and **Edit and retry** uses the current loaded definition even with the same task and agent name. `POST /api/runs/:id/cancel` returns 409 for failed and succeeded runs and preserves their outcomes; repeating it on a canceled run succeeds.

The UI can approve, retry, or cancel a run, pause or unpause a loop, page back through older transcript rows, and tail parent and first-level child activity.

Run conversations remember the reader's filter, opened disclosures, and reading position across drawer reopens and page refreshes. Bookmarks are per run and browser origin, and unread activity stays pending while a saved position is restored. See [Returning to a conversation](../web/README.md#returning-to-a-conversation) for retention and history-recovery limits. Adjacent completed tools are summarized by their recorded actions, such as files read or changed and recognized test or build commands; expand a group to see each tool and result.

Direct browser requests for UI routes serve the app shell, so refreshing or sharing a project or configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths return 404.

`POST /api/cycle-budgets/reset` takes an ask identity, with the same origin guard and typed errors as other interventions. A stale ask returns 409, and setup mode rejects resets.

After `pnpm build`, reload the page to use the new web bundle; no restart is needed.

## Change the configuration

The web UI edits stored entities in their export format, validates each save, and shows revision history and diffs. Concurrent writes return a conflict; the editor retains the draft while the operator reviews the newer text. Create, delete, and revert actions use the same API as other configuration writes. New loops start paused.

The reload HTTP endpoint has been removed. Revisions apply automatically; `SIGHUP` remains available to explicitly re-read the store without stopping the process. A configuration write that requires a restart or fails worker preflight stores nothing and returns the reason. GitHub credentials are read only at startup.

## Back up and export

While the orchestrator runs, `usine backup` copies `.usine/runtime.sqlite` to the path you give, and `.usine/durable.sqlite` next to it with `.durable` before the extension (`/path/to/runtime-backup.durable.sqlite`):

```sh
usine backup /path/to/runtime-backup.sqlite
```

Both copies include committed WAL data and are owner-only. The command opens each source read-only, copies the durable storage first, needs no GitHub credentials, and never overwrites a file. Use a new name in an existing writable directory on a file system with hard links. If the runtime copy fails, the durable copy is removed. Without durable storage (no attempt has run yet), it writes only the runtime copy and says so. Errors give the path and cause.

Keep backups outside the instance folder. The runtime backup includes authored configuration and revisions; back up credentials and bootstrap files separately. To restore, stop the orchestrator and restore both files of one backup:

1. Move `.usine/runtime.sqlite` and `.usine/durable.sqlite` aside, with their `-wal` and `-shm` files.
2. Copy the runtime backup to `.usine/runtime.sqlite` and the `.durable` backup to `.usine/durable.sqlite`.
3. Restart with the matching instance configuration and engine version.

An attempt that was running at backup time reattaches if its checkout under `.usine/workers` still exists. Without its checkout or the durable copy, it fails as interrupted and the run retries. An older backup has an older dedup ledger, so work done after it can run again.

`usine export-run` writes one run to a local JSON file:

```sh
usine export-run <runId>
usine export-run <runId> --output /path/to/evidence.json
```

The default is `run-<encoded-runId>.json` in the current directory, with characters such as `/` percent-encoded; the output directory must exist. The command writes a complete owner-only file, never overwrites one, and prints its path. A missing run, unreadable store, encoding failure, or write failure exits nonzero.

The versioned JSON has `exportedAt`, the full run `snapshot` (event, effective task and agent, revision, step result, and all attempts), and every saved transcript envelope in append order, from one transaction, including history past the drawer's page. Active runs keep adding history, so export a settled run. The export opens `.usine/runtime.sqlite` read-only, without creating tables, migrating, starting attempts, or polling. Transcripts can contain repo content and tool output; check the file before you share it. For a restorable database, use `usine backup` ([ADR 0010](../../docs/adr/0010-single-sqlite-runtime-store.md)).

## Stop the server

Run `usine stop`, press Ctrl+C, or send `SIGTERM` once to stop polling and drain admitted attempts. The server waits up to `max_attempt_minutes` from the request, or indefinitely if unset; a second signal, or `usine stop --force`, stops the wait, and `usine stop --force` sends `SIGKILL` if the process still runs after `--timeout`. Queued runs and automatic retries stay saved, and an attempt cut off by the deadline uses normal restart recovery. Start the next `usine up` after the process exits; `usine stop` returns when it has.

To clear a handled failure, select **Mark resolved** in the run drawer, opened from Needs attention or run history. Resolution survives restarts and keeps the failed outcome, transcript, and retry. A later failed attempt asks for attention again. After a question the button reads **Mark answered**; after a question or blocker, the loop then acts on the item's newest state.

Failure resolution through `POST /api/runs/:runId/resolve-failure` records the current instance's operator login and resolution time. The next `GET /api/statistics/runs` reflects the resolution, including when the previous response was cached.

Every Needs attention entry has **Dismiss**. The overview's collapsed **Dismissed** section lists acknowledged entries with **Undo**. Dismissals persist across refreshes and restarts, and a changed entry appears again. Attention counts and badges exclude dismissed entries. Dismissing an approval, failure, or cycle-budget ask leaves its state and actions available on the run and task pages and board cards. Dismiss and Undo also work while GitHub credentials need setup.

After the first poll cycle and schedule check finish, refreshing the overview removes dismissals for entries it no longer reports or whose content changed. Until both sources report, including while GitHub credentials need setup, the overview retains dismissals so that startup does not clear them. If an entry disappears during a refresh and later returns, dismiss it again to hide it.

## Server upgrades

A global npm installation managed by systemd checks for upgrades every five minutes. Run `usine config edit settings instance` to configure `settings.upgrade_channel: latest` or `next` and `settings.upgrade_mode: off`, `propose`, or `automatic`. The defaults are `latest` and `propose`. Before offering an upgrade or draining attempts, the server checks that every `@usine/*` dependency, including transitive dependencies, resolves on the registry. If a package is unavailable, the server keeps admitting attempts and checks again in the next cycle.

In **Configuration → Settings**, select **Upgrade when idle** to stop admitting attempts and wait for active attempts to finish, or **Upgrade now** to restart and reattach running attempts. `usine upgrade [<version> | --channel <latest|next>]` requests the same operation; `--force` selects immediate restart, and `--check` only reports versions. The CLI prints when the request is accepted; Settings and the helper journal report its outcome.

Install the helper service and polkit rule in the [server guide](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) before using app upgrades. The independent helper installs into the same npm prefix and restores the previous version if installation or the new operator API fails. Its result is in `.usine/upgrade/result.json`; inspect `journalctl -u usine-upgrade.service` for progress. For npm `ETARGET` or `E404` errors, the helper tries installation up to three times, 60 seconds apart. After a successful rollback from an install failure, automatic mode can retry that version. A version that failed its health check, or whose rollback record does not identify the failure stage, requires a manual retry. Rollback restores packages; maintain database backups for releases with incompatible storage changes.

Configuration forms for agents, workers, settings, and repositories save revisions through the operator API. The server supplies supported harnesses and efforts, installation repositories, and live repository labels. GitHub choices return an availability error in setup mode or when GitHub cannot answer; configuration editing remains available.

The loop form checks CEL and prompt expressions as you type and previews matches from stored GitHub items. New loops start paused. **Resume** shows a fresh preview count before allowing the loop to open runs. The check and preview endpoints are available in setup mode, using configuration and items already stored by the instance.

## Projects

At startup, version 1 stored configuration migrates in one revision to one project per repository. For example, `basaltbytes/usine` becomes `basaltbytes-usine`. Selected loops become `project/loop`; their runs, pauses, cycle budgets, and attention acknowledgements migrate in the same transaction. Exported configuration uses version 2 with a `projects` block and loops under `projects/<project>/loops/`. Legacy imports convert automatically.

`GET /api/configuration` and the overview include projects. `GET /api/projects/:project` returns the project board. `GET /api/projects/:project/tasks/:item?repository=owner/repo` reads a member repository's task, and `POST /api/projects/:project/items/:item/lane` accepts `repository` and `toLane`. Existing owner/repository task and move routes remain available.

Configuration entity writes accept kind `project`. CLI and API loop operations accept `project/loop`; a short loop name works while unique. The single-repository configuration editor continues to read and write lanes through the repository form.
