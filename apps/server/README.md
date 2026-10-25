# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory: a thin Node adapter over `@usine/orchestrator`. The library does the polling, schedule triggers, durable execution, worker composition, and operator actions; this package serves their JSON and web surfaces. The [CLI reference](https://docs.usine.dev/reference/configuration/cli/) lists every command, flag, and variable, and [Operate runs](https://docs.usine.dev/guides/operate-runs/) covers day-to-day use.

Run it from an instance folder:

```sh
usine up
```

It prints `http://127.0.0.1:7331` and stays attached to the terminal. `--port <port>` or `USINE_PORT` changes the port; if the port is taken, the CLI names the conflict and suggests the override. `--log-level <level>` or `USINE_LOG_LEVEL` sets the lowest level it logs, `info` by default; `debug` adds the lines that say why something was skipped. `usine --version` prints the `@usine/server` version that the instance pins.

One `usine up` runs per instance folder. It holds `.usine/instance.lock` from startup until every store closes, writes its pid to `.usine/instance.pid`, and writes its pid, port, version, start time, and command line to `.usine/instance.json`. It removes both files when it exits. A second `usine up` there names the running process and exits nonzero before opening a store. A draining process keeps the folder until it exits.

## Manage the instance

```sh
usine up --detach   # start in the background, with the output in .usine/usine.log
usine status        # running or not, pid, address, version, uptime, open runs; exit 3 if stopped
usine stop          # send SIGTERM and wait for the drain; --force ends the drain
usine restart       # stop, then start the recorded command line in the background
usine upgrade       # back up, move the @usine/server pin, install, commit, and restart
```

`stop`, `restart`, and `upgrade` wait `--timeout` seconds (120 by default) for each stop and start. `restart` and `upgrade` refuse while a run has a running attempt, unless `--force`, and when the shell lacks a gateway's admin token variable, because the new process inherits the shell's environment. `upgrade` applies to an instance that installs `@usine/server` from its own `package.json` pin; for a checkout, pull and build it, then run `usine restart`.

Without GitHub App credentials, it logs the typed error, leaves both trigger streams idle, and opens the setup screen in the default browser. The browser command times out after two seconds; a failed opener only logs a warning. Runs, transcripts, and loop pause state stay readable, and the instance folder can be reloaded, but interventions are unavailable. Supply `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, or `app_id` and `private_key` in a mode-0600 `.usine/github-app.json`. Credentials are read only at startup, so restart `usine up` after adding them, as the setup screen says.

## Web UI

Each project opens as a board of authored or proposed lanes; proposed lanes are read-only. To enable moves, define `repos[].lanes` in `usine.yaml` and reload (see the [lane example](../../packages/config/README.md)). Moving an item to an authored label-backed lane swaps only the labels in that map and keeps other labels; polling then evaluates label-driven loops. Cards show the latest run and open its drawer. The UI can approve, retry, or cancel a run, pause or unpause a loop, page back through older transcript rows, and tail parent and first-level child activity.

Run conversations remember the reader's filter, opened disclosures, and reading position across drawer reopens and page refreshes. Bookmarks are per run and browser origin, and unread activity stays pending while a saved position is restored. See [Returning to a conversation](../web/README.md#returning-to-a-conversation) for retention and history-recovery limits. Adjacent completed tools are summarized by their recorded actions, such as files read or changed and recognized test or build commands; expand a group to see each tool and result.

Direct browser requests for UI routes serve the app shell, so refreshing or sharing a project or configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths return 404.

`POST /api/cycle-budgets/reset` takes an ask identity, with the same origin guard and typed errors as other interventions. A stale ask returns 409, and setup mode rejects resets.

After `pnpm build`, reload the page to use the new web bundle; no restart is needed.

## Reload the configuration

**Reload configuration** on any Configuration page, `POST /api/instance/reload`, and `SIGHUP` reload `usine.yaml`, `agents/`, and `loops/` without stopping the process. `SIGHUP` no longer ends the process; stop it with Ctrl+C or `SIGTERM`. The [CLI reference](https://docs.usine.dev/reference/configuration/cli/) describes what a reload applies. A refused reload keeps the running configuration and returns:

- 422 `FactoryConfigError` for an invalid `usine.yaml`;
- 409 `RestartRequiredError`, naming the field, for a changed `webhooks` block or a `workers` change that needs a restart (a worker's kind or settings, or a rename);
- 409 `ReloadPreflightError` if a worker, slot count, or agent brain that the reload adds fails preflight, or a new SSH worker's gateway admin token variable is unset.

An accepted reload's response names the loops, agents, labels, repos, and workers it added, removed, or changed. Until a removed worker's last attempt ends, Needs attention counts its running attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 `LeftoversDiscardRejectedError` with that count. GitHub credentials, the `workers` changes above, and the `webhooks` block apply only at startup.

## Back up and export

While the orchestrator runs, `usine backup` copies `.usine/runtime.sqlite` to the path you give, and `.usine/durable.sqlite` next to it with `.durable` before the extension (`/path/to/runtime-backup.durable.sqlite`):

```sh
usine backup /path/to/runtime-backup.sqlite
```

Both copies include committed WAL data and are owner-only. The command opens each source read-only, copies the durable storage first, needs no GitHub credentials, and never overwrites a file. Use a new name in an existing writable directory on a file system with hard links. If the runtime copy fails, the durable copy is removed. Without durable storage (no attempt has run yet), it writes only the runtime copy and says so. Errors give the path and cause.

Keep backups outside the instance folder, and back up the instance files and credentials separately. To restore, stop the orchestrator and restore both files of one backup:

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

Run `usine stop`, press Ctrl+C, or send `SIGTERM` once to stop polling and drain admitted attempts. The server waits up to `max_attempt_minutes` from the request, or indefinitely if unset; a second signal, or `usine stop --force`, stops the wait. Queued runs and automatic retries stay saved, and an attempt cut off by the deadline uses normal restart recovery. Start the next `usine up` after the process exits; `usine stop` returns when it has.

To clear a handled failure, select **Mark resolved** in the run drawer, opened from Needs attention or run history. Resolution survives restarts and keeps the failed outcome, transcript, and retry. A later failed attempt asks for attention again. After a question the button reads **Mark answered**; after a question or blocker, the loop then acts on the item's newest state.
