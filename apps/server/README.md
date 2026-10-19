# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory. It is a thin Node adapter over `@usine/orchestrator`: the library owns polling, schedule triggers, durable execution, worker composition, and operator acts; this package serves their JSON and web surfaces.

Run it from an instance folder:

```sh
usine up
```

The command prints `http://127.0.0.1:7331` and stays attached to the terminal. Pass `--port <port>` (or set `USINE_PORT`) to listen elsewhere. `usine --help` prints the complete command surface and `usine --version` prints the exact `@usine/server` version pinned by the instance. If the chosen port is occupied, the CLI names the conflict and suggests the override instead of exposing Node's bind failure.

One `usine up` runs per instance folder. It holds `.usine/instance.lock` from startup until every store has closed, and writes its process id to `.usine/instance.pid`. A second `usine up` in the same folder exits with a nonzero status before it opens any store, and names the running process; a process that is still draining its Attempts keeps the folder until it exits.

Without GitHub App credentials, it opens the setup screen in the default browser, logs the typed credential error, and leaves both trigger streams idle instead of crashing. The browser command has a two-second timeout; a failed opener produces a warning and does not stop the server. Existing Runs, transcript detail, and database-backed Loop pause state remain observable, and the instance folder can be reloaded, while interventions stay unavailable. Credentials may come from `USINE_GITHUB_APP_ID` plus `USINE_GITHUB_PRIVATE_KEY`, or from a mode-0600 `.usine/github-app.json` file with `app_id` and `private_key` fields. The running process reads credentials only at startup, so stop and rerun `usine up` after adding them; the setup screen states that restart requirement explicitly.

The local-only UI opens each project as a Board built from its authored or proposed lanes. Proposed lanes are read-only. Configure `repos[].lanes` in `usine.yaml` and reload the configuration to enable moves; see the [lane configuration example](../../packages/config/README.md). Moving an Item into an authored label-backed lane exchanges only the labels in that map, preserving descriptive labels outside it; normal polling then evaluates label-protocol loops. Board cards show the latest Run and open its existing detail drawer. The UI can also approve, retry, or cancel a Run; pause or unpause a Loop's database runtime state; page backward through older transcript rows; and tail parent and one-level child session activity.

Run conversations remember the reader’s filter, inspected disclosures and reading place when the drawer reopens or the page refreshes. Bookmarks are specific to each Run and browser origin; unread activity remains pending while a saved place is restored. See the [conversation reader behavior](../web/README.md#returning-to-a-conversation) for retention and history-recovery limits.

Direct browser requests for UI routes serve the application shell, so refreshing or sharing a Project or Configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths remain 404 responses.

Run conversations summarize adjacent completed tools by their recorded actions, including the files read or changed and recognized test or build invocations. Expand a group to inspect each tool and its result.

The operator API includes `POST /api/cycle-budgets/reset` with an Ask identity. It uses the same request-origin guard and typed error contract as other interventions; stale Asks return 409 and needs-setup mode rejects resets until the runtime is available.

## Reloading the configuration

**Reload configuration** on the Loops page, `POST /api/instance/reload`, and `SIGHUP` load `usine.yaml`, `agents/`, and `loops/` again without stopping the process. New Runs, the next poll and schedule tick, and the next Attempt's settings use the new files; an open Run keeps the Agent it was opened with. Invalid Loop and Agent files are left out, logged, and listed in Needs you, as at startup. An invalid `usine.yaml` returns 422 `FactoryConfigError`, and a changed `workers` or `webhooks` block returns 409 `RestartRequiredError`; both keep the running configuration. The response of an accepted reload names the Loops, Agents, labels, and repositories it added, removed, or changed. `SIGHUP` no longer ends the process: stop it with Ctrl+C or SIGTERM.

## Runtime backup and Run evidence

From the instance folder, copy the runtime store and the durable storage while the orchestrator runs:

```sh
usine backup /path/to/runtime-backup.sqlite
```

`usine backup` writes two files. The runtime store `.usine/runtime.sqlite` goes to the path you give, and the durable storage `.usine/durable.sqlite`, where each running Attempt keeps its parent task and conversations, goes beside it with `.durable` before the extension: `/path/to/runtime-backup.durable.sqlite`. Both copies include committed WAL data. The command opens each source read-only, copies the durable storage first, and doesn't need GitHub credentials. An instance that has not run an Attempt since it was created has no durable storage; the command then writes only the runtime copy and says so.

Use a new filename in an existing writable directory on a filesystem that supports hard links. The command writes complete copies with owner-only permissions and won't overwrite existing files. If the runtime copy fails, the durable copy is removed again. Errors identify the affected path and cause.

Keep the backup outside the instance folder to protect it against loss of that folder. Back up the authored instance files and credentials separately. To restore, stop the orchestrator and restore both files from the same backup together:

1. Move `.usine/runtime.sqlite` and `.usine/durable.sqlite` aside, with any `-wal` and `-shm` files next to them.
2. Copy the runtime backup to `.usine/runtime.sqlite` and the `.durable` backup to `.usine/durable.sqlite`.
3. Restart with the matching instance configuration and engine version.

An Attempt that was running when the backup was taken reattaches to its parent task when its checkout under `.usine/workers` is still there; without its checkout, or without the durable copy, it fails as interrupted and its Run retries on a new Attempt. Restoring an older backup also restores its older deduplication ledger, so work performed after that backup can run again.

From the instance folder, export one Run into a local JSON file:

```sh
usine export-run <runId>
usine export-run <runId> --output /path/to/evidence.json
```

The default destination is `run-<encoded-runId>.json` in the current directory; characters such as `/` in the Run id are percent-encoded. The output directory must already exist. The command writes a complete file with owner-only permissions, preserves existing destinations, and prints its path after success. A missing Run, unreadable runtime store, encoding failure, or write failure returns a nonzero exit status.

The versioned JSON contains `exportedAt`, the full durable Run `snapshot` (Event, effective task and Agent, repository revision, Step result, and all Attempts), and every saved transcript envelope for those Attempts in append order. The snapshot and transcripts come from one database transaction, including history beyond the drawer's current page. Active Runs continue accumulating history, so export a settled Run for its final evidence.

Exporting opens the instance's existing `.usine/runtime.sqlite` in read-only mode, without creating tables, running migrations, starting Attempts, or polling triggers. The command keeps the output local. Transcripts can contain repository content and tool output; inspect the file before sharing it. A Run export preserves selected evidence; use `usine backup <path>` for a restorable runtime database, as described in [ADR 0010](../../docs/adr/0010-single-sqlite-runtime-store.md).

## Stopping and updating

Send SIGTERM or press Ctrl+C once to stop trigger polling and drain admitted Attempts. The server waits up to `max_attempt_minutes` from the shutdown request before closing the runtime, or without a deadline when that setting is absent. A second SIGTERM or Ctrl+C stops the wait immediately. Start the next `usine up` once the process has exited. Queued Runs and automatic retries remain saved for the next start. An Attempt interrupted by the deadline or force stop uses normal restart recovery.

After `pnpm build`, reload the page to use the rebuilt web bundle; no process restart is required. GitHub credentials, the `workers` block, and the `webhooks` block are read at startup only; the rest of the instance folder reloads as described above.

Choose **Mark resolved** in a failed Run’s drawer to clear a failure you have handled. Open the drawer from its Needs you entry or Run history. Resolution persists across restarts and preserves the failed outcome, transcript, and retry controls. A later failed Attempt requests attention again. When the Agent asked a question, the button reads **Mark answered**. After a question or a blocker, the Run's Loop then acts on the Item's newest state.
