# @usine/server

The foreground CLI for a local [usine](https://github.com/basaltbytes/usine) factory: a thin Node adapter over `@usine/orchestrator`. The library does the polling, schedule triggers, durable execution, worker composition, and operator actions; this package serves their JSON and web surfaces. The [CLI reference](https://docs.usine.dev/reference/cli/) lists every command, flag, and variable, and [Operate runs](https://docs.usine.dev/guides/operate-runs/) covers day-to-day use.

The overview and desk API responses contain run and attempt summaries. Read run or task detail for prompts and result text. The board loads the saved task from run detail when **Run again** is clicked.

Saved harness session records include the home location and optional Codex `modelProvider` ID used to validate continuation. A moved home or changed provider ID refuses the resume before another turn starts.

The run reader matches GitHub changes to each attempt's worker identity, including exe.dev's integration bot. Board moves retain their operator attribution.

Create an instance folder and run its pinned installation:

```sh
npm create usine@latest my-factory
cd my-factory
npm run usine -- up
```

With pnpm, use `pnpm create usine my-factory`, then `pnpm usine up` from that folder. The first start saves an empty configuration revision and opens GitHub App setup. Commands below use `usine`; for the local installation, invoke them with `npm run usine --` or `pnpm usine`.

It prints `http://127.0.0.1:7331` and stays attached to the terminal. Every command reads `.env` in the instance folder for the variables that the environment doesn't set, as dotenv does, so keep tokens there to run the commands from any shell. `--port <port>` or `USINE_PORT` changes the port; if the port is taken, the CLI names the conflict and suggests the override. `--origin <url>` or `USINE_ORIGIN` names the URL at which a proxy, such as `tailscale serve`, publishes the UI; the operator API then accepts browser requests from pages there too. `--log-level <level>` or `USINE_LOG_LEVEL` sets the lowest level it logs, `info` by default; `debug` adds the lines that say why something was skipped. Each log line starts with its date and time in UTC. `usine --version` prints the `@usine/server` version that the instance pins. On macOS, `usine up` warns if the Mac can sleep, which drops the SSH connections to workers: run `caffeinate -s` while runs are open, or turn off sleep on AC power with `sudo pmset -c sleep 0`.

One `usine up` runs per instance folder. It holds `.usine/instance.lock` from startup until every store closes, writes its pid to `.usine/instance.pid`, and writes its pid, port, version, start time, and command line to `.usine/instance.json`. It removes both files when it exits. It reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start; the ID labels its attempt containers on SSH workers, so that another instance with the same GitHub App doesn't remove them. A second `usine up` there names the running process and exits nonzero before opening a store. A draining process keeps the folder until it exits.

`GET /api/version` answers before worker preflight and checkout reconciliation. `GET /api/ready` returns HTTP 503 with `Retry-After: 1` until startup recovery finishes, then HTTP 200 with `{"ok":true}`. Both endpoints accept requests without credentials. Other routes return HTTP 503 during startup. The listener keeps the same socket when runtime routes become available. Recovery logs its attempt count, progress every 50 attempts, and completion at Info.

At startup, a failed worker preflight excludes that worker from scheduling while the other workers start and the API listens. **Needs attention** shows the worker and its preflight message. Checks retry after 1, 2, 5, and 10 minutes, then every 10 minutes; a passing check restores scheduling and clears the entry. A configuration revision that changes the worker's slot count checks it immediately. Configuration writes still refuse a revision whose preflight fails. Startup exits with an error if every worker fails preflight, or if a database, GitHub App, or listen-address error prevents startup.

`GET /api/configuration/capabilities` returns registered harness IDs, reasoning efforts, and `harnessDetails` with each harness’s label and terminal resume metadata. These values come from `@usine/agents/harness`.

## Manage the instance

The first parent harness installs Pi's HTTP dispatcher for all server requests, including GitHub, gateway administration, and Boat. It uses five-minute stream timeouts and respects `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; Pi's global `httpProxy` setting fills unset proxy variables. Restart the server after changing proxy settings.

```sh
usine up --detach   # start in the background, with the output in .usine/usine.log
usine status        # running or not, pid, address, version, uptime, open runs; exit 3 if stopped
usine stop          # send SIGTERM and wait for the drain; --force ends the drain
usine restart       # stop, then start the recorded command line in the background
usine upgrade       # back up, move the @usine/server pin, install, commit, and restart
```

`stop`, `restart`, and `upgrade` wait `--timeout` seconds (120 by default) for each stop. With `--force`, they send `SIGKILL` to a process that still runs after the timeout. Each start, including `usine up --detach`, waits until the new process listens, which it does before startup recovery, and gives up only when the process writes no line to `.usine/usine.log` for that long. Without a readable `.usine/instance.json`, `restart` checks the pid in `.usine/instance.pid` on the port where it answers, stops it, and starts `usine up` as `usine up --detach` without flags would. `restart` and `upgrade` refuse while a run has a running attempt, unless `--force`, and when neither the shell nor `.env` sets a gateway's admin token variable, because the new process inherits the shell's environment and reads `.env`. `upgrade` applies to an instance that installs `@usine/server` from its own `package.json` pin; for a checkout, pull and build it, then run `usine restart`.

`usine up` records the systemd service whose cgroup it runs in, such as `usine.service`. If systemd reports the process as that service's main process, `stop`, `restart`, and `upgrade` stop it with `systemctl stop --no-block` and start it with `systemctl start`, so that systemd keeps managing it, and `status` names the service. A start whose service fails or waits to restart is stopped, so that it doesn't repeat.

On macOS, [install the two LaunchAgents](https://docs.usine.dev/guides/host-usine-on-macos/) and set `USINE_LAUNCHD_SERVICE=gui/<uid>/<label>` in the instance `.env`. The CLI verifies the job's PID with `launchctl print`; `stop` uses `bootout`, and `restart` reloads the plist and uses `kickstart`. `up --detach` starts that job with its plist arguments. The server logs to `.usine/usine.log`; the independent `<label>-upgrade` job logs to `.usine/upgrade/helper.log` and uses the shared package-install, health-check, backup, and rollback helper. Both jobs run as the login user and require Homebrew GNU coreutils, findutils, and flock on PATH. A login is required after reboot.

Without GitHub App credentials, `usine up` serves setup with idle pollers. Open its one-time sign-in link, or run `usine sign-in-link` from the instance folder. `/setup` creates the App through GitHub's manifest flow, saves its credentials with mode 0600, discovers its installation, and opens the repository picker after the first admin signs in. It resumes missing-key and missing-installation states and accepts restored credential JSON. Setup reads saved credentials live. After sign-in, its final action activates the runtime and waits for readiness before opening the repository picker. Existing environment overrides and manual credential files remain supported; restart after changing those outside setup.

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

An empty instance folder starts with an empty configuration revision in the database. Setup creates no git repository or configuration skeleton. Existing bootstrap files still import when the configuration store is empty.

Each project opens as a board of authored or proposed lanes; proposed lanes are read-only. To enable moves, edit the repository with `usine config edit repository <owner/name>` (see the [lane example](../../packages/config/README.md)). Moving an item to an authored label-backed lane swaps only the labels in that map and keeps other labels; polling then evaluates label-driven loops. Cards show the latest run and open its drawer. Retry controls describe the saved harness and model. The drawer flags a changed agent definition, and **Edit and retry** uses the current loaded definition even with the same task and agent name. `POST /api/runs/:id/cancel` returns 409 for failed and succeeded runs and preserves their outcomes; repeating it on a canceled run succeeds.

The UI can approve, retry, or cancel a run, pause or unpause a loop, page back through older transcript rows, and tail parent and first-level child activity.

Run conversations remember the reader's filter, opened disclosures, and reading position across drawer reopens and page refreshes. Bookmarks are per run and browser origin, and unread activity stays pending while a saved position is restored. See [Returning to a conversation](../web/README.md#returning-to-a-conversation) for retention and history-recovery limits. Adjacent completed tools are summarized by their recorded actions, such as files read or changed and recognized test or build commands; expand a group to see each tool and result.

Direct browser requests for UI routes serve the app shell, so refreshing or sharing a project or configuration URL works. Unknown `/api/*` routes, missing `/assets/*` files, and other file-like paths return 404.

`POST /api/cycle-budgets/reset` takes an ask identity, with the same origin guard and typed errors as other interventions, and returns `replayedCiFixEventIds`, the blocked CI fix events the reset replayed. A repeated answer returns an empty list. A stale ask returns 409, and setup mode rejects resets.

Cycle-budget attention entries identify the most recently blocked loop. A later refused event changes the entry's revision and raises it again after dismissal. Repeated sightings of the recorded events preserve dismissal, and later blocks keep the same ask identity for reset.

After `pnpm build`, reload the page to use the new web bundle; no restart is needed.

## Webhook delivery hints

Save `webhooks.mode: deliveries` with `usine config edit settings` to check the GitHub App's delivery summaries about every 10 seconds. The App webhook must be active, but it does not need a reachable endpoint. The runtime persists its delivery cursor and uses hints to refresh registered repositories sooner; the normal poll remains active. **Configuration > Settings** shows the running mode and the last hint received since startup.

For endpoint mode, save the full public delivery URL:

```yaml
webhooks:
  mode: endpoint
  public_url: https://usine.example/webhooks/github
```

Set `USINE_GITHUB_WEBHOOK_SECRET` in the instance `.env` to the webhook secret configured for the GitHub App. Endpoint mode requires a nonempty secret. Keep the App webhook **active** and subscribe it to the issue, pull request, comment, review, push, and check events that your loops use. The App's webhook settings control its active flag, secret, and subscriptions; usine updates its URL and JSON content type at startup and after accepted webhook changes.

Expose `POST /webhooks/github` through your HTTPS reverse proxy to the existing operator HTTP server. This route verifies `X-Hub-Signature-256` with HMAC-SHA256 over the exact request bytes and does not require an operator token. Other operator routes still require authentication. The endpoint accepts bodies up to 25 MiB with a ten-second read timeout. It returns 204 for valid deliveries, including ignored `ping` and unregistered repositories; registered repositories request the same early refresh as deliveries mode.

A failed hook configuration request is logged; the endpoint and normal polling remain available. **Needs attention** warns after ten minutes with no verified delivery since endpoint activation or its last configuration change. Check the public URL, active flag, webhook secret, and startup logs. Self-write hints do not clear this warning. **Configuration > Settings** shows the mode and last hint time. Mode and URL changes replace the active source without a restart. Restart after changing the secret in `.env`. Enabling the endpoint without an available secret logs a configuration error and returns 503; normal polling continues.

## Change the configuration

The web UI edits stored entities in their export format, validates each save, and shows revision history and diffs. Concurrent writes return a conflict; the editor retains the draft while the operator reviews the newer text. Create, delete, and revert actions use the same API as other configuration writes. New loops start paused.

The reload HTTP endpoint has been removed. Revisions apply automatically; `SIGHUP` remains available to explicitly re-read the store without stopping the process. A configuration write that requires a restart or fails worker preflight stores nothing and returns the reason. Existing worker connection changes require a restart so retained attempts keep their machine. App signing credentials are read at startup and after setup saves them. GitHub sign-in reads the client ID and secret from the runtime file when their environment overrides are unset.

## Back up and export

While the orchestrator runs, `usine backup` copies `.usine/runtime.sqlite` to the path you give, and `.usine/durable.sqlite` next to it. For destinations ending in `.sqlite` or `.db`, the durable copy has `.durable` before that extension: `backup.sqlite` becomes `backup.durable.sqlite`, and `backup.db` becomes `backup.durable.db`. For all other names, the command appends `.durable.sqlite`: `before-pi-1.4-2026-10-29` becomes `before-pi-1.4-2026-10-29.durable.sqlite`, and `nightly` becomes `nightly.durable.sqlite`.

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

A global npm installation managed by systemd or launchd checks for upgrades every five minutes. Run `usine config edit settings instance` to configure `settings.upgrade_channel: latest` or `next` and `settings.upgrade_mode: off`, `propose`, or `automatic`. The defaults are `latest` and `propose`. Before offering an upgrade or draining attempts, the server checks that every `@usine/*` dependency, including transitive dependencies, resolves on the registry. If a package is unavailable, the server keeps admitting attempts and checks again in the next cycle.

Upgrade status retains the last fully verified version for the selected channel while a check is running or a newer release is incomplete. Registry probe details stay in the server log; the status message explains pending upgrade waits and upgrade failures.

Managed upgrades are available after GitHub App setup finishes. During setup, upgrade requests explain that setup must finish first. If the service stops during the helper's health check, the recorded failure includes its state and exit status or signal. A failed start reports the start command's exit status; a readiness timeout means the service kept running until the deadline passed.

In **Configuration → Settings**, select **Upgrade when idle** to stop admitting attempts and wait for active attempts to finish, or **Upgrade now** to restart and reattach running attempts. `usine upgrade [<version> | --channel <latest|next>]` requests the same operation; `--force` selects immediate restart, and `--check` only reports versions. The CLI prints when the request is accepted; Settings and the helper's journal or log report its outcome.

While an idle upgrade waits, deferred runs keep worker slots free. Settings shows the requested version and offers **Cancel pending upgrade**; authenticated clients can send `DELETE /api/upgrade`. Cancellation resumes deferred runs without a restart and prevents automatic mode from requesting that version again in this process. A manual request can retry it. Cancellation is rejected once installation starts. An upgrade wait with deferred runs appears in Needs attention after ten minutes.

Install the helper service and polkit rule in the [server guide](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) before using app upgrades. Before stopping the server, the independent helper uses `usine backup` to copy both databases into a private `.usine/upgrade/backup.*` directory. A failed backup leaves the server and packages unchanged. The helper installs into the same npm prefix and allows the target 180 elapsed seconds to report the expected version and return HTTP 200 from `/api/ready`. The readiness check waits for startup recovery to finish. If installation or readiness fails, it stops the service, restores the previous package and both databases, removes WAL and SHM files from the failed version, and verifies the previous version endpoint. Rollback uses the version endpoint so it can restore releases that predate readiness checks. A durable database created by the target is removed if none existed in the backup. After a successful upgrade, the helper keeps the newest three backups, including the current upgrade backup, and removes older ones. Failed upgrades and rollbacks retain all backups. Before copying data, the helper requires free space on both the backup and instance filesystems equal to at least twice the combined database and WAL file sizes, so rollback can stage database copies locally even with external backups. Insufficient space records a failure with the folder to clean and leaves the server and packages unchanged.

Set `USINE_UPGRADE_BACKUP_DIR` to an absolute, instance-specific backup directory and `USINE_UPGRADE_BACKUP_KEEP` to the retention count (1–999999999) in the upgrade helper service’s environment. The defaults are `.usine/upgrade/` in the instance folder and `3`. See [Upgrade an instance](https://docs.usine.dev/guides/upgrade-an-instance/) for a systemd drop-in example.

The result is in `.usine/upgrade/result.json`; inspect `journalctl -u usine-upgrade.service`, or `.usine/upgrade/helper.log` on macOS, for progress and the backup path. If rollback fails, the helper stops the service and records a failure for manual recovery. For npm `ETARGET` or `E404` errors, the helper tries installation up to three times, 60 seconds apart. After a successful rollback from an install failure, automatic mode can retry that version. A version that failed its health check, or whose rollback record does not identify the failure stage, requires a manual retry.

If a failed installation leaves the previous version in the installed `package.json`, the helper restarts it without reinstalling. If a rollback installation fails but leaves the previous version installed, the helper also restarts it. Both paths verify the previous version's API and record `status=failed` with the original upgrade failure reason, so retry the upgrade manually. Recovery errors advise reinstalling only when the installed version matches neither the target nor the previous version, including an unreadable package manifest.

Configuration forms for agents, workers, settings, and repositories save revisions through the operator API. The server supplies supported harnesses and efforts, installation repositories, and live repository labels. GitHub choices return an availability error in setup mode or when GitHub cannot answer; configuration editing remains available.

The loop form checks CEL and prompt expressions as you type and previews matches from stored GitHub items. New loops start paused. **Resume** shows a fresh preview count before allowing the loop to open runs. The check and preview endpoints are available in setup mode, using configuration and items already stored by the instance.

## Projects

At startup, version 1 stored configuration migrates in one revision to one project per repository. For example, `basaltbytes/usine` becomes `basaltbytes-usine`. Selected loops become `project/loop`; their runs, pauses, cycle budgets, and attention acknowledgements migrate in the same transaction. Exported configuration uses version 2 with a `projects` block and loops under `projects/<project>/loops/`. Legacy imports convert automatically.

`GET /api/configuration` and the overview include projects. `GET /api/projects/:project` returns the project board. `GET /api/projects/:project/tasks/:item?repository=owner/repo` reads a member repository's task, and `POST /api/projects/:project/items/:item/lane` accepts `repository` and `toLane`. Existing owner/repository task and move routes remain available.

Configuration entity writes accept kind `project`. CLI and API loop operations accept `project/loop`; a short loop name works while unique. The single-repository configuration editor continues to read and write lanes through the repository form.

## Sign-in

Operator API requests require an instance token or a browser session, including requests from loopback. Health, sign-in, and API schema endpoints are public. Every member has instance admin access.

`GET /api/version` is an upgrade health endpoint that returns only the running release string. It remains public so helpers copied by releases before member authentication can verify the new server during a managed upgrade. `GET /api/ready` also accepts requests without credentials and returns HTTP 200 only after startup recovery finishes. Upgrade status and upgrade requests require authentication.

When `usine up` writes to a terminal, open the printed **Sign in** URL. The link expires after 10 minutes and works once. For a detached instance, a system service, or a new link, run `usine sign-in-link` in the instance folder. This also works before GitHub user authorization is configured. Keep these URLs private.

`usine up` writes `.usine/admin-token` with mode `0600` and replaces it on each start. Local status and lifecycle commands require this file to be owned by the current user, have mode `0600`, and be a regular file rather than a symbolic link. An unreadable or unsafe file fails the command before stop or restart sends a signal. Configuration commands access the local database directly; access to the instance folder is required.

### GitHub App settings

For an existing App, open **GitHub > Settings > Developer settings > GitHub Apps > your App**:

1. Under user authorization, enable **Device Flow**.
2. Set the callback URL to `<instance-origin>/api/auth/callback`, for example `https://usine.example.com/api/auth/callback`.
3. For a manually created App, copy its client ID and generate a client secret. Add `USINE_GITHUB_CLIENT_ID` and `USINE_GITHUB_CLIENT_SECRET` to the instance's `.env` file. These differ from the App ID and private key.
4. Set `USINE_ORIGIN` to the same instance origin, then restart `usine up`.

Use HTTPS for remote access through a reverse proxy. With Tailscale, publish the loopback listener with `tailscale serve --bg http://127.0.0.1:7331` and set `USINE_ORIGIN` to the HTTPS address it prints. `usine up` continues to bind only `127.0.0.1`.

On upgrade, the configured `operator` becomes the first member after the instance resolves that login to a GitHub user ID. If GitHub is unavailable, the instance logs a warning and retries enrollment on the next start; the local sign-in link remains available. On a new instance, open the one-time link after configuring the App's user authorization and complete GitHub sign-in to become the first member. A public sign-in cannot enroll the first member.

Add members by GitHub login on **Members**. The last member cannot be removed. Removing a member revokes that member's tokens. GitHub identity checks use the numeric user ID; a different GitHub account cannot sign in by reusing a member's former login.

### Device tokens

Run `usine sign-in <instance-origin>`, open the GitHub device page, and enter the printed code. After authorization, the CLI prints an instance token once. Store it in a secret manager and send it as `Authorization: Bearer <token>`. The instance stores only its hash. After reading identity, usine requests revocation of the GitHub user token and wipes its local copy. A failed revocation logs a warning and preserves the sign-in result.

**Tokens** lists the signed-in member's browsers and devices, creation times, and last use, updated at most once a minute per token. Listing tokens deletes expired credentials and excludes them from the response. Revoke an entry to end access. Device tokens remain valid until revoked; browser sessions expire after 30 days. **Sign out** revokes the current browser session.

Browser sessions use an `HttpOnly`, `SameSite=Strict` cookie, with `Secure` except for local HTTP origins. Browser writes require `X-Usine-CSRF`. The bundled UI reads its CSRF cookie and sends that header. Health and sign-in endpoints are public; the separate GitHub webhook listener verifies delivery signatures. Sign-in initiation, link issuance, GitHub exchanges, and invalid challenges have separate instance-wide limits of 60 requests per operation per minute. Invalid challenges do not consume the limits for valid sign-ins. Device polls also honor GitHub's interval.

The Overview’s worker utilization uses stored configuration revisions to account for slot changes over the selected window. Revision 1 supplies the slot count before recorded history. Statistics Details also clarifies that repeated successful rebase runs count against first time right.

## Test storage

The SQLite storage, configuration, and export tests use the shared [SQLite fixture directory helper](../../tooling/test/sqlite.mts). Export fixture seeding receives the test cancellation signal, and directory removal retries transient filesystem errors.

See [Development](../../CONTRIBUTING.md#development) for temporary storage selection and worker concurrency.

**Configuration > Workers** provides **Run preflight** on each worker row and detail page. The action displays progress and refreshed checks, with remediation for failures. It is disabled with a reason while an attempt or preflight runs on the worker. `POST /api/workers/:worker/preflight` returns the stored checks and updates overview and Needs attention without a restart; busy workers return 409 `WorkerPreflightRejectedError`.

Loop checks at `/api/configuration/loops/check` validate integer CEL priorities. `/api/configuration/loops/preview` returns each matching item’s evaluated `priority`; evaluation errors appear in `failures` and use zero. `/api/desk` includes the scheduler’s captured priority for runs waiting for a worker slot.

## API schema

`GET /api/openapi.json` publicly serves the generated OpenAPI 3.1 contract, including sign-in, members, and tokens. It describes request and response schemas and authentication requirements without reading instance state. See the [HTTP API reference](https://docs.usine.dev/reference/operator-api/) for endpoint descriptions and the downloadable document.

Route definitions and schema annotations generate the contract. Authentication handlers use the paths and request schemas in `src/auth/api.ts`; setup handlers use `src/setup/api.ts`; the server combines those definitions with `OperatorApi` in `src/openapi.ts`. After changing a contract, regenerate and commit `apps/docs/public/openapi.json` as described in the [docs README](../docs/README.md#operator-http-api-reference).

Apps created through `/setup` already have the web callback and client credentials. Enable the device flow in the App settings before using CLI device sign-in.

`POST /api/configuration/loops/check` validates conditional approval as a boolean
CEL expression in the trigger's environment. Approval diagnostics use the
`approval` field path. Run and overview responses include the saved decision.

## Public HTTPS access

Publish the loopback listener through Caddy, Cloudflare Tunnel, or Tailscale Serve and set `USINE_ORIGIN` to its HTTPS address. See [Expose an instance over HTTPS](../docs/src/content/docs/guides/expose-an-instance.md) for enrollment, credential permissions, webhook secrets, proxy headers, and examples.

The canonical origin is allowed automatically. Configure additional exact browser origins in the top-level `auth.origins` list through `usine config edit settings instance`, then restart. HTTP origins are limited to loopback; development origins require an explicit entry. Unknown origins receive 403 before handlers run. Allowed origins support credentialed CORS with `GET`, `POST`, `PUT`, and `DELETE`, and the `Authorization`, `Content-Type`, and `X-Usine-CSRF` headers. Cookie writes still require CSRF verification.

One global middleware sets CSP and the security headers on routes, assets, preflights, and errors. HSTS follows the configured canonical HTTPS origin, independent of forwarded request headers.


## Access control

Members receive access through configuration role bindings. Browser sessions use current bindings on every request, so grants and removals apply without signing in again. Device token requests intersect current bindings with the token permission ceiling; device sign-in snapshots current grants. Only device tokens have editable scopes. The first member and migrated members receive instance admin bindings; later members need explicit grants. Local admin credentials and configuration CLI writes use `local admin` attribution. See the sign-in guide for roles and scoped token management.

`GET /api/overview` returns compact board cards and every open run plus the latest 50 closed runs across the instance. Cards retain counts, aggregate usage, and summaries needed for their current state and actions. Task and run endpoints provide complete history and prompts.

The web UI uses `GET /api/changes` for entity invalidation. The authenticated stream supports `Last-Event-ID`, bounded replay, and 15-second heartbeats. Reverse proxies must allow streaming responses without buffering. JSON reads support private ETags and conditional 304 responses. See [ADR 0034](../../docs/adr/0034-web-change-notices.md) for read projections and pagination.

## Event-loop delay

`usine up` logs `Event-loop delay` once per minute, including `p99Millis`, `maxMillis`, and `intervalSeconds`. The values describe the preceding minute with a 10 ms sampling resolution. Use maximum delay to detect isolated stalls; p99 describes the slowest 1% of samples. The monitor stops when the server scope closes. Runtime reads use the SQLite read worker so a long standalone read permits transcript appends and HTTP health responses to continue.

If the SQLite read worker stops, the server logs the cause at Error and fails its in-flight reads. Later reads use the main connection, where long reads can delay appends and HTTP responses. The server retries worker startup after 1 second, 5 seconds, 30 seconds, and then every 5 minutes. A replacement serves reads after a successful probe; successful recovery resets the retry delay.

Read `GET /api/health` to check `sqliteReader`: `worker` means standalone reads use the worker, `fallback` means they use the main connection while waiting to retry, and `respawning` means a replacement is starting and reads still use the main connection. The endpoint remains a liveness check and returns HTTP 200 in each state.

## Schema contracts

Operator request and response records use nominal Schema brands. TypeScript integrations construct records with their schema’s `make` method or decode JSON with `Schema.decodeUnknownEffect`. HTTP request and response formats remain unchanged.

Run `pnpm --filter @usine/server check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## Tests

`pnpm turbo run test --filter=@usine/server` builds the server and runs the functional Vitest project. `pnpm --filter @usine/server test:latency` runs the latency project, the 500 ms concurrent overview and desk read budget; its result depends on the machine, so it isn't part of the local gate. CI runs the functional project on pull requests and `main`, and the latency project in a separate job on `main`.

The upgrade helper shell scenarios require GNU coreutils, GNU findutils, and `flock` on PATH. They skip when these tools are unavailable, including on a standard macOS checkout. The upgrade HTTP health checks run independently of these tools.

Provider connections are available in setup and Configuration > Settings. `usine login claude` and `usine login chatgpt` authorize subscription logins; `--api-key` reads a masked API key. `usine logout <provider>` disconnects them. Run these commands from the instance folder while the server runs. The server sends completed logins to configured gateways over their authenticated admin APIs, or writes the local harness credential files when no gateway is configured.

Provider reports preserve the gateway's `refreshable` capability. Local Claude setup tokens also report `refreshable: false`; native Claude OAuth logins keep their reported expiry. Settings explains that setup tokens cannot refresh and that their expiry date is not included with the token.

With a gateway configured, the coordinator also uses the gateway's provider credentials. Startup checks its connection before resuming attempts and validates each agent's parent using the gateway credential. A missing provider credential quarantines the affected agent and its loops; the orchestrator host needs no provider login. Without a gateway, the coordinator uses its local Pi login.

Local provider status checks report missing Claude Code and Codex commands separately, with an installation instruction for the affected provider. Availability changes log once at Info, including recovery; unchanged errors remain quiet across polls. ChatGPT authorization reports a missing Codex command before starting sign-in.

## Step outputs

Attempts can return typed JSON documents from `.usine/outputs/`. The runtime database stores gzip bodies separately from run snapshots, while run evidence and `usine export-run` include output refs. See [agent step outputs](https://docs.usine.dev/reference/configuration/agents/#step-outputs) for the format and limits.

The task page's **Changes** disclosure reads `GET /api/projects/:project/pull-requests/:repository/:item/files`, with the repository encoded as one path segment. The query's `scope` selects `PullRequestFiles` for the whole PR or `CommitRangeFiles` for an attempt. Both require full `base` and `head` commit SHAs: the projected PR base and head, or the attempt's recorded checkout base and pushed head. Project read access and repository membership are checked before cached or GitHub reads. The response reports missing patches, truncated patches, and file-list limits. Unavailable PRs and commit comparisons return 404; stale whole-PR selections return 409 with refresh instructions; rate limits return 503. Concurrent reads of one selection share their GitHub requests. The shared server cache holds up to 64 MiB of file paths and patch text and evicts the least recently read responses first; a diff larger than the budget is returned without server caching.
