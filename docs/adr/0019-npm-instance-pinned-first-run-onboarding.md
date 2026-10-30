# npm distribution pinned per instance; first-run web UI setup

v1 distributes only through **npm**: `apps/server` publishes as **`@usine/server`** (bin **`usine`**), a thin CLI over `@usine/orchestrator` that bundles the built web UI. `apps/web` stays unpublished (ADR 0012 amended).

**`pnpm create usine`** (`create-usine`) creates an instance folder: a local git repo ([ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md)), a `usine.yaml` skeleton (schema `version:`, empty registry, implicit local worker, `webhooks.mode: off`), empty `loops/` and `agents/`, a `.gitignore` for `.usine/` and `node_modules/`, and a **`package.json` and lockfile that exact-pin `@usine/server`**, then installs and commits.

The pin is the point: the engine version is **per-instance, committed, authored config**. To upgrade, edit the pin and restart; forward-only SQLite migrations run at startup (back up by stopping and copying the folder, [ADR 0010](./0010-single-sqlite-runtime-store.md)). Sharing the repo reproduces the instance, engine included. No example loop or agent is scaffolded; the first ones are made in the UI, paused.

`usine up` runs the orchestrator as a **foreground CLI** in the instance folder, using the local install, printing the UI URL, and opening the browser on first run. Keeping it running (tmux, launchd, systemd) is the operator's job (copy-paste docs); service management, Docker, and a binary can come later.

**Bootstrap is in the first-run web UI.** Without App credentials, `up` starts in needs-setup with idle pollers, and the UI walks through setup:

1. Create the App by manifest flow against the orchestrator's redirect endpoint ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md) permissions; active `hook_attributes` with the `.invalid` URL and events of [ADR 0014](./0014-webhook-delivery-as-hints.md)).
2. Save the conversion response (App id, private key, webhook secret) to the 0600 `.usine/` secrets file (environment override).
3. Prefill the operator's GitHub login into `usine.yaml` ([ADR 0017](./0017-away-intervention-github-native-asks.md)).
4. Install the App on the managed repos.
5. Fill the registry with the installation-bound add-repo picker (ADR 0016).

The Workers page under Configuration is the **preflight surface**: it runs the verify-only preflight of [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md) on demand and shows each typed capability error with its fix (for example, "run `claude /login` in a terminal"). Logins stay in the operator's terminal. The CLI is two commands: `pnpm create usine` and `usine up`.

## Considered options

- **Global tool** (one engine per machine, config-only instance folders): all instances upgrade at once, forward-only migrations make accidents irreversible, and a shared instance repo no longer says what runs it. Rejected.
- **Standalone binary or Docker first**: rejected for v1. The local worker needs Node for the npm-CLI harnesses anyway, and a containerized orchestrator conflicts with a same-machine local worker (toolchain, worktrees, harness logins). Both can follow, likely Docker first for a cloud orchestrator.
- **CLI setup wizard** (`init` opens a browser and a temporary localhost server for the manifest redirect): duplicates the orchestrator's HTTP server, and the add-repo picker is in the UI anyway. Rejected.
- **`usine doctor`**: would repeat the Workers page's preflight errors. Rejected for v1; additive if wanted.
- **Scaffolded example loop and agent**: friendlier onboarding, but git-committed loops arm at once ([ADR 0016](./0016-config-editing-forms-first-preview-before-arming.md)) and cold start fires on existing state ([ADR 0007](./0007-polling-triggers-content-hashed-events.md)), so a demo would act on real repos. Rejected.

## Consequences

- ADR 0012 amended: `create-usine` publishes next to `@usine/server` as a scaffolder, not a block. It's unscoped, so the `@usine-dev` fallback doesn't affect it.
- The instance repo is a Node package: `package.json` and lockfile are committed config; `node_modules/` is gitignored like `.usine/`. UI config commits (ADR 0009) never touch the pin.
- Onboarding must resume wherever a first run stopped: each step is idempotent and re-enterable (App created but key lost, key present but nothing installed, installation live but registry empty).
- Locally, one install contains orchestrator and run host, so only remote workers can skew, which preflight catches (ADR 0006).
- The prebuilt exe.dev image stays adapter-owned (ADR 0006).

## Amendment (2026-10-25, #154): the CLI starts, stops, restarts, and upgrades an instance

`usine up` still runs in the foreground, and a supervisor such as launchd or systemd can still run it. In practice, the dogfood instance ran detached, and each engine upgrade was a manual sequence: build the checkout or bump the pin, find the PID, send `SIGTERM`, wait for the drain, relaunch with `nohup`, and read the log. No command told whether an instance was up. The CLI now has `usine status`, `usine stop`, `usine restart`, `usine upgrade`, and `usine up --detach`.

`usine up` records its PID, port, engine version, start time, and command line in `.usine/instance.json`. The instance lock decides whether an instance runs, so a PID that the OS reused never counts. `stop` sends the drain signal of [ADR 0023](./0023-graceful-attempt-drain.md) and waits, and `--force` sends the second signal. The first signal is recorded, so a second `stop` waits instead of ending the drain. `restart` and `upgrade` refuse while an attempt runs, because without a ceiling the drain can keep the instance down for hours, and `--force` lets the next start reattach the attempt instead. The restarted process inherits the environment of the shell that runs the command, so they also refuse when that shell lacks a gateway admin token variable.

`upgrade` keeps the pin as the engine version: it backs up the stores into `.usine/backups/`, moves the pin, installs, commits the change, and restarts. An engine outside the instance, such as a checkout, has no pin to move, so `upgrade` changes nothing and says how to update that engine.

## Amendment (2026-10-26, #547): every usine command reads the instance folder's `.env`

The refusal above made a bare `usine restart` fail on the dogfood instance, whose `start.sh` sources `.env` before `usine up`. Keeping the variable names in `.usine/instance.json` would still leave the shell to supply the values, and keeping the values there would put tokens in plain text beside the store. So each `usine` command reads `.env` in the instance folder when it starts, and the restarted process reads it again.

`.env` follows dotenv: a variable that the environment sets keeps its value, and `.env` fills in the rest, so a shell can still override a value for one start. This differs from the gateway's environment files ([ADR 0027](./0027-gateway-credential-proxy.md)), which override the environment as systemd's `EnvironmentFile=` does. The values go into the Effect `ConfigProvider`, not `process.env`, so child processes still receive only their allowlisted variables ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)). The refusal stays, and checks the shell and `.env` together, which is what the new process reads.

## Amendment (2026-10-27, #609): the orchestrator's server runs a global install, and the CLI manages its systemd service

`infra/hetzner/orchestrator-cloud-init.yaml` installs `@usine/server` with `npm install --global` under `/home/usine/.local`, and `usine.service` runs `/home/usine/.local/bin/usine up` in `/home/usine/factory`. This is the global tool that *Considered options* rejects, for one case: a server that runs one instance. cloud-init sets up the server before an instance folder exists there, so there is no pin to install from, and the unit's `ExecStart=` names the install's path. With one instance per server, the engine of the machine and the engine of the instance are the same, and a global upgrade migrates the stores of that instance alone.

What the pin guarantees is lost on the server: the instance repo doesn't say which engine runs it, and an instance moved from a laptop keeps a `package.json` pin that the service doesn't read. The operator installs the version by hand, with `npm install --global @usine/server@<version>` as `usine`, then runs `usine restart`. `usine upgrade` refuses an engine outside the instance, as the amendment of #154 says, and names that install. [Run the orchestrator on a server](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) documents the procedure. Everywhere else, the pin stays the engine version.

`usine up` records the system service whose cgroup it runs in. If `systemctl show` reports the process as that service's main process, `usine stop`, `usine restart`, and `usine upgrade` start the drain with `systemctl stop --no-block`, so that `Restart=` doesn't start the service again, and start it with `systemctl start`. Otherwise they signal the process as the amendment of #154 says. A `systemctl` call that fails stops the command, so that the CLI never signals a process behind systemd's back.

## Amendment (2026-10-28, #636): channel upgrades for a systemd server

A server with a global npm installation checks `settings.upgrade_channel` (`latest` by default, or `next`) every five minutes. `settings.upgrade_mode` is `propose` by default; `off` disables checks, and `automatic` requests an idle upgrade when the channel has a newer version. Configuration reload applies both settings.

The operator API exposes the running version, selected channel, available version, progress, and the last helper outcome. Settings links to the release tags or prerelease commit hashes and offers **Upgrade when idle** and **Upgrade now**. Until the operator API has authentication, its existing network and origin policy also governs upgrades.

Idle upgrades call `RunEngine.drain()` from ADR 0023 before installing anything. The admission latch closes atomically; admitted attempts finish and persist outcomes. Immediate upgrades use the existing second-SIGTERM shutdown behavior so workers can continue and the next server can reattach. A failed helper launch after draining requires a service restart to reopen admission.

The server audits the recorded entry point and systemd main PID to identify a global npm prefix. It writes an owner-only helper script and previous/target version record under `.usine/upgrade/`, then starts the separate `<server-unit>-upgrade.service`. The script uses Bash and system tools, with no imports from the package it replaces. The helper stops the server, installs an exact version into the same prefix, starts the service, and waits up to three minutes for the operator API to report that version. Only then does it record the version as good. A failed installation, start, or health check reinstalls the previous version and restarts it. Both versions and the failure reason remain in the record and journal. Automatic checks do not retry a target that failed or rolled back.

The existing command runner and systemd adapter supply npm and systemd access. The server upgrade controller adds the scoped polling and drain coordination needed by HTTP requests; it accepts an adapter for registry lookups and helper operations. A standalone shell helper is necessary because stopping the orchestrator and replacing its dependencies must not stop rollback. Cloud-init installs its service and the narrowly scoped polkit rule. Existing servers install those files once, as documented in the server guide. Local installations retain their package pin upgrade behavior.

Rollback restores the executable package, not the databases. Package releases that change persistent storage must remain readable by the previous version for automatic rollback to succeed. Operators retain database backups for manual recovery across incompatible storage changes.

## Amendment (2026-10-28, #652): registry propagation and install retries

A channel tag can become visible before another package from the same release. Before offering an upgrade and again before draining, the server resolves the target's `@usine/*` dependency graph through npm, including transitive dependencies such as `@usine/cloudflare`. Shared package specs are checked once per traversal. A lookup failure leaves admission open and defers the upgrade to the next check cycle.

The helper retries an installation that reports npm `ETARGET` or `E404` up to three times, 60 seconds apart, then rolls back. Other install errors and timeouts roll back immediately. A successful rollback records `failureStage` as `install` or `health-check`; older records decode as `unknown`. This replaces the blanket automatic-retry restriction above: automatic mode can retry a target after an install rollback, but continues to skip health-check rollbacks, unknown rollback causes, failed rollbacks, and unfinished installations. The helper still verifies the previous version's API before recording a successful rollback.

## Amendment (2026-10-30, #742): restart an existing previous installation after npm fails

A failed npm install can leave the previous package installed. After a target install fails, the helper reads the installed `package.json` in the original prefix. If it reports the previous version, the helper skips reinstallation and restarts the service. After a rollback install fails, the helper checks again and restarts the previous version if it remains installed. Both paths require the previous version's API to answer and record `status=failed` with the original upgrade failure reason; automatic mode requires a manual retry. A successful rollback reinstall retains `status=rolled-back`. Recovery errors advise reinstalling only when the installed version matches neither known version, or the manifest cannot be read.
