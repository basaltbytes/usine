# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory. It is a thin Node adapter over `@usine/orchestrator`: the library owns polling, schedule triggers, durable execution, worker composition, and operator acts; this package serves their JSON and web surfaces.

Run it from an instance folder:

```sh
usine up
```

The command prints `http://127.0.0.1:7331` and stays attached to the terminal. Pass `--port <port>` (or set `USINE_PORT`) to listen elsewhere. `usine --help` prints the complete command surface and `usine --version` prints the exact `@usine/server` version pinned by the instance. If the chosen port is occupied, the CLI names the conflict and suggests the override instead of exposing Node's bind failure.

Without GitHub App credentials, it opens the setup screen in the default browser, logs the typed credential error, and leaves both trigger streams idle instead of crashing. The browser command has a two-second timeout; a failed opener produces a warning and does not stop the server. Existing Runs, transcript detail, and database-backed Loop pause state remain observable, while interventions stay unavailable. Credentials may come from `USINE_GITHUB_APP_ID` plus `USINE_GITHUB_PRIVATE_KEY`, or from a mode-0600 `.usine/github-app.json` file with `app_id` and `private_key` fields. The running process reads credentials only at startup, so stop and rerun `usine up` after adding them; the setup screen states that restart requirement explicitly.

The local-only UI opens each project as a Board built from its authored or proposed lanes. Proposed lanes are read-only. Configure `repos[].lanes` in `usine.yaml` and restart `usine up` to enable moves; see the [lane configuration example](../../packages/config/README.md). Moving an Item into an authored label-backed lane exchanges only the labels in that map, preserving descriptive labels outside it; normal polling then evaluates label-protocol loops. Board cards show the latest Run and open its existing detail drawer. The UI can also approve, retry, or cancel a Run; pause or unpause a Loop's database runtime state; page backward through older transcript rows; and tail parent and one-level child session activity.

Run conversations remember the reader’s filter, inspected disclosures and reading place when the drawer reopens or the page refreshes. Bookmarks are specific to each Run and browser origin; unread activity remains pending while a saved place is restored. See the [conversation reader behavior](../web/README.md#returning-to-a-conversation) for retention and history-recovery limits.

Direct browser requests for UI routes serve the application shell, so refreshing or sharing a Project or Configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths remain 404 responses.

Run conversations summarize adjacent completed tools by their recorded actions, including the files read or changed and recognized test or build invocations. Expand a group to inspect each tool and its result.

The operator API includes `POST /api/cycle-budgets/reset` with an Ask identity. It uses the same request-origin guard and typed error contract as other interventions; stale Asks return 409 and needs-setup mode rejects resets until the runtime is available.

## Runtime backup and Run evidence

From the instance folder, copy the runtime store while the orchestrator runs:

```sh
usine backup /path/to/runtime-backup.sqlite
```

The destination must be a new file in an existing directory. The command uses SQLite's online backup API to include committed WAL data and all runtime tables, then publishes the completed file atomically with owner-only permissions. It opens the source read-only and requires no GitHub credentials. Failed backups leave the destination unpublished; existing files are preserved.

Keep the backup outside the instance folder to protect it against loss of that folder. Back up the authored instance files and credentials separately. To restore, stop the orchestrator, move the existing `.usine/runtime.sqlite` and any `runtime.sqlite-wal` / `runtime.sqlite-shm` files aside, and copy the backup to `.usine/runtime.sqlite`. Restart with the matching instance configuration and engine version. Restoring an older backup also restores its older deduplication ledger, so work performed after that backup can run again.

From the instance folder, export one Run into a local JSON file:

```sh
usine export-run <runId>
usine export-run <runId> --output /path/to/evidence.json
```

The default destination is `run-<encoded-runId>.json` in the current directory; characters such as `/` in the Run id are percent-encoded. The output directory must already exist. The command writes a complete file with owner-only permissions, preserves existing destinations, and prints its path after success. A missing Run, unreadable runtime store, encoding failure, or write failure returns a nonzero exit status.

The versioned JSON contains `exportedAt`, the full durable Run `snapshot` (Event, effective task and Agent, repository revision, Step result, and all Attempts), and every saved transcript envelope for those Attempts in append order. The snapshot and transcripts come from one database transaction, including history beyond the drawer's current page. Active Runs continue accumulating history, so export a settled Run for its final evidence.

Exporting opens the instance's existing `.usine/runtime.sqlite` in read-only mode, without creating tables, running migrations, starting Attempts, or polling triggers. The command keeps the output local. Transcripts can contain repository content and tool output; inspect the file before sharing it. A Run export preserves selected evidence; use `usine backup <path>` for a restorable runtime database, as described in [ADR 0010](../../docs/adr/0010-single-sqlite-runtime-store.md).

## Stopping and updating

Send SIGTERM or press Ctrl+C once to stop trigger polling and drain admitted Attempts. The server waits up to `max_attempt_minutes` from the shutdown request before closing the runtime. A second SIGTERM or Ctrl+C stops the wait immediately. Queued Runs and automatic retries remain saved for the next start. An Attempt interrupted by the deadline or force stop uses normal restart recovery.

After `pnpm build`, reload the page to use the rebuilt web bundle; no process restart is required. Instance configuration and GitHub credentials are read at startup.
