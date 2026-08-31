# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory. It is a thin Node adapter over `@usine/orchestrator`: the library owns polling, schedule triggers, durable execution, worker composition, and operator acts; this package serves their JSON and web surfaces.

Run it from an instance folder:

```sh
usine up
```

The command prints `http://127.0.0.1:7331` and stays attached to the terminal. Without GitHub App credentials, it serves a setup screen, logs the typed credential error, and leaves both trigger streams idle instead of crashing. Credentials may come from `USINE_GITHUB_APP_ID` plus `USINE_GITHUB_PRIVATE_KEY`, or from a mode-0600 `.usine/github-app.json` file with `app_id` and `private_key` fields.

The local-only UI can approve, retry, or cancel a Run; pause or unpause a Loop's database runtime state; and tail parent and one-level child session activity. It does not expose steering, takeover, or a planning board.
