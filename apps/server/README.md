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
