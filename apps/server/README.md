# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory. It is a thin Node adapter over `@usine/orchestrator`: the library owns polling, schedule triggers, durable execution, worker composition, and operator acts; this package serves their JSON and web surfaces.

Run it from an instance folder:

```sh
usine up
```

The command prints `http://127.0.0.1:7331` and stays attached to the terminal. Pass `--port <port>` (or set `USINE_PORT`) to listen elsewhere. `usine --help` prints the complete command surface and `usine --version` prints the exact `@usine/server` version pinned by the instance. If the chosen port is occupied, the CLI names the conflict and suggests the override instead of exposing Node's bind failure.

Without GitHub App credentials, it opens the setup screen in the default browser, logs the typed credential error, and leaves both trigger streams idle instead of crashing. The browser command has a two-second timeout; a failed opener produces a warning and does not stop the server. Existing Runs, transcript detail, and database-backed Loop pause state remain observable, while interventions stay unavailable. Credentials may come from `USINE_GITHUB_APP_ID` plus `USINE_GITHUB_PRIVATE_KEY`, or from a mode-0600 `.usine/github-app.json` file with `app_id` and `private_key` fields. The running process reads credentials only at startup, so stop and rerun `usine up` after adding them; the setup screen states that restart requirement explicitly.

The local-only UI opens each project as a Board built from its authored or proposed lanes. Moving an Item between label-backed lanes updates its GitHub labels; normal polling then evaluates label-protocol loops. Board cards show the latest Run and open its existing detail drawer. The UI can also approve, retry, or cancel a Run; pause or unpause a Loop's database runtime state; page backward through older transcript rows; and tail parent and one-level child session activity.

Direct browser requests for UI routes serve the application shell, so refreshing or sharing a Project or Configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths remain 404 responses.

The operator API includes `POST /api/cycle-budgets/reset` with an Ask identity. It uses the same request-origin guard and typed error contract as other interventions; stale Asks return 409 and needs-setup mode rejects resets until the runtime is available.

## Exporting Run evidence

From the instance folder, export one Run into a local JSON file:

```sh
usine export-run <runId>
usine export-run <runId> --output /path/to/evidence.json
```

The default destination is `run-<encoded-runId>.json` in the current directory; characters such as `/` in the Run id are percent-encoded. The output directory must already exist. The command writes a complete file with owner-only permissions, preserves existing destinations, and prints its path after success. A missing Run, unreadable runtime store, encoding failure, or write failure returns a nonzero exit status.

The versioned JSON contains `exportedAt`, the full durable Run `snapshot` (Event, effective task and Agent, repository revision, Step result, and all Attempts), and every saved transcript envelope for those Attempts in append order. It includes history beyond the drawer's current page. Active Runs continue accumulating history, so export a settled Run for its final evidence.

Exporting requires the instance's `.usine/runtime.sqlite` and starts no Attempts or trigger polling. The command keeps the output local. Transcripts can contain repository content and tool output; inspect the file before sharing it. A Run export preserves selected evidence; a restorable backup still requires stopping the orchestrator and copying the instance folder, as described in [ADR 0010](../../docs/adr/0010-single-sqlite-runtime-store.md).

## Stopping and updating

Send SIGTERM or press Ctrl+C once to stop trigger polling and drain admitted Attempts. The server waits up to `max_attempt_minutes` from the shutdown request before closing the runtime. A second SIGTERM or Ctrl+C stops the wait immediately. Queued Runs and automatic retries remain saved for the next start. An Attempt interrupted by the deadline or force stop uses normal restart recovery.

After `pnpm build`, reload the page to use the rebuilt web bundle; no process restart is required. Instance configuration and GitHub credentials are read at startup.
