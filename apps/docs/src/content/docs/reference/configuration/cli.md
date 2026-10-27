---
title: CLI
description: The usine commands, their flags, the environment variables that the orchestrator and the gateway read, and exit statuses.
sidebar:
  order: 5
---

The `@usine/server` package provides the `usine` binary ([`main.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/main.ts#L47)). Run every command from the instance folder, the folder that contains `usine.yaml`. Each command first reads the [environment file](#environment-file), `.env`, in that folder.

```sh title="Usage"
usine up [--port <port>] [--log-level <level>] [--allow-volatile-instance] [--detach]
usine status
usine stop [--timeout <seconds>] [--force]
usine restart [--timeout <seconds>] [--force]
usine upgrade [<version>] [--check] [--timeout <seconds>] [--force]
usine backup <path>
usine export-run <runId> [--output <path>]
usine --help
usine --version
```

For any other form, the parser prints the usage on standard error and exits with status 1 ([`parseCli`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/cli.ts#L192)).

| Command | Description |
| --- | --- |
| `usine up` | Starts the orchestrator and serves the UI. |
| `usine status` | Reports whether the orchestrator runs, and its PID, address, engine version, uptime, and open runs. |
| `usine stop` | Stops the orchestrator after its drain. |
| `usine restart` | Stops the orchestrator and starts it again in the background. |
| `usine upgrade` | Moves the instance's `@usine/server` pin to another version and restarts the orchestrator. |
| `usine backup <path>` | Copies the runtime store and the durable storage while the orchestrator runs. |
| `usine export-run <runId>` | Writes one run's records and transcript to a JSON file. |
| `usine --help`, `usine -h` | Prints the usage. `usine <command> --help` does the same for every command. |
| `usine --version`, `usine -v` | Prints the version of the installed `@usine/server`. |

## `usine up`

| Flag | Value | Default | Description |
| --- | --- | --- | --- |
| `-p <port>`, `--port <port>`, `--port=<port>` | integer 1 to 65535 | `USINE_PORT`, then `7331` | The HTTP port. The server listens only on `127.0.0.1`. |
| `--log-level <level>`, `--log-level=<level>` | `trace`, `debug`, `info`, `warn`, or `error`, in any case | `USINE_LOG_LEVEL`, then `info` | The lowest level of the lines that usine logs. `debug` adds the lines that say why usine skipped or deferred something, such as an entry left out of **Needs attention**. A change takes effect at the next `usine up`; `usine restart` keeps the recorded level. |
| `--allow-volatile-instance` | none | off | Starts even if the instance folder is under a temporary directory. |
| `--detach` | none | off | Starts the orchestrator in the background. See [Background start](#background-start). |

If a flag repeats, the last value wins.

### Startup

`usine up` runs these steps in order and stops at the first failure ([`up`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/up.ts#L104)):

1. **Volatile path check.** usine refuses an instance folder under `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, or `/var/folders`, by the given path or its real path, because the runtime store is the only copy of every run and transcript. With `--allow-volatile-instance`, usine logs a warning and continues.
2. **Instance lock.** usine holds an exclusive SQLite transaction on `.usine/instance.lock`, writes its process ID to `.usine/instance.pid`, and writes the [instance record](#instance-record) to `.usine/instance.json` ([`holdInstance`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/instance-lock.ts#L44)). A second `usine up` in the folder exits and prints that ID. The lock ends with the process, however it exits. usine removes both files when it exits, unless the OS kills it, for example with `SIGKILL`. usine then reads the instance ID from `.usine/instance-id`, or writes a new UUID there at the first start. The ID labels the instance's attempt containers on SSH workers, so that another instance folder with the same GitHub App doesn't remove them ([`instanceIdOf`](https://github.com/basaltbytes/usine/blob/main/apps/server/src/instance/id.ts)). If the file doesn't contain a UUID, usine exits.
3. **Port check.** usine refuses a port that another process listens on, and prints that process if `lsof` finds it.
4. **Instance load.** usine reads `usine.yaml`, `agents/`, and `loops/`, and exits with status 1 if `usine.yaml` is invalid or a folder is missing. Invalid loop and agent files don't stop startup ([Validation and quarantine](/reference/configuration/loop-files/#validation-and-quarantine)).
5. **GitHub App credentials.** usine reads `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, and fills a missing one from `.usine/github-app.json` ([`loadLocalCredentials`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/local-secrets.ts#L69)). If both variables are set, usine doesn't read the file. It accepts PKCS#1 keys (`BEGIN RSA PRIVATE KEY`, as GitHub downloads them) and PKCS#8 keys.
6. **Runtime.** usine opens the stores, reads each gateway's admin token, runs preflight on every worker, starts polling and schedules, and reattaches the attempts that an earlier process left running. It prints `usine is running at http://127.0.0.1:<port>`.

On macOS, after the port check, usine reads `pmset -g` and logs a warning if system sleep is on and `caffeinate` doesn't prevent it, since a sleep drops the SSH connections to workers and the gateway. The check doesn't stop startup. See [Keep the machine awake](/guides/#keep-the-machine-awake).

An expected startup failure prints one line with the file, setting, or worker at fault, such as a preflight check like `machine` or `harness-login`, and what to do, and exits with status 1. Only a defect in usine prints a full trace.

### Background start

`usine up --detach` checks that no `usine up` runs in the folder. It then starts `usine up` with the same Node.js binary, Node.js options, entry point, port, log level, and `--allow-volatile-instance` flag, in a new session and with no terminal. The new process appends its output to `.usine/usine.log`, which has owner-only permissions; usine doesn't rotate it. The command waits for the process to write its instance record and answer HTTP requests, and then prints:

```text
usine is running at http://127.0.0.1:7331 (pid 48120), with its output in .usine/usine.log.
```

The process answers only after startup recovery, which reconciles the checkouts that earlier attempts left on workers and can take minutes. So the command keeps waiting while the process writes to the log, and gives up after 120 seconds without a new line. At log level `warn` or `error`, startup recovery writes few lines, so a long recovery can exceed the wait.

If the process exits first, the command prints how it exited and the last 20 lines of the log, and exits with status 1. If the process neither answers nor writes to the log for 120 seconds, the command says so and exits with status 1, and the process keeps running. The process inherits the environment of the shell that runs the command, and reads the [environment file](#environment-file) itself.

### Instance record

`.usine/instance.json` describes the running `usine up`. It has owner-only permissions:

| Key | Description |
| --- | --- |
| `pid` | The process ID, which `.usine/instance.pid` also contains. |
| `version` | The `@usine/server` version of the process. |
| `startedAt` | When the process took the instance lock, in ISO 8601 format. |
| `launch` | How the process started: `node` (the Node.js binary), `nodeOptions`, `script` (the CLI entry point), `port`, `logLevel`, and `allowVolatileInstance`. `usine restart` starts the new process with these values, and at `info` if a version before `--log-level` wrote the record without `logLevel`. |
| `stoppingSince` | When the process received its first `SIGINT` or `SIGTERM`. Absent until then. |

The record says which process holds the instance, but the instance lock says whether one does. If a process stops without removing its files, for example after `SIGKILL`, `usine status` reports them as stale, and the next `usine up` replaces them.

### Setup mode

If the credentials are missing or invalid, usine starts in setup mode instead of the runtime. It logs `GitHub App credentials are absent; pollers are idle`, prints `usine is running in setup mode at http://127.0.0.1:<port>`, and opens that page in the browser. The page shows **GitHub App not set up**, the error, and the two ways to supply the credentials.

In setup mode, usine doesn't poll GitHub or fire schedules. You can read projects, runs, and transcripts, and reload the configuration. Every other action, such as approve, retry, cancel, pause, or a board move, fails with `BackendUnavailableError`. usine reads the credentials only at startup, so restart `usine up` after you add them.

The secrets file is JSON with two keys, and must be a regular file with mode `0600`. usine refuses any other mode, including `0400`:

```json title=".usine/github-app.json"
{
  "app_id": 123456,
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

### Reload

`usine up` doesn't watch its files. To load changes without a restart, send `SIGHUP`, select **Reload configuration** on any **Configuration** page, or send `POST /api/instance/reload`; the page and the response list what changed. usine reloads `usine.yaml`, `agents/`, and `loops/` as at startup, and lists invalid loop and agent files in **Needs attention** and on the **Loops** and **Agents** pages.

New runs, the next poll and schedule tick, and the next attempt use the new configuration. An open run keeps the agent, task, and parent model that it opened with, including on retries, and so does an event that waits behind a running run. An accepted reload starts the next poll immediately, or when a wait that GitHub requested ends, if that is later. If the set of loops that apply to a repository changes (a loop is added or removed, or its `on` or `if:` changes), that poll reads the repository's items from the start. It logs `Instance folder reloaded; new Runs use the new configuration` with the changes, or `Instance folder reload rejected; the running configuration is unchanged` with the reason, and keeps running.

A reload applies a worker's new `max_concurrent_attempts`, a new `local` or `ssh` worker, and a removed worker without stopping running attempts ([`workers`](/reference/configuration/usine-yaml/#workers)).

usine refuses the reload and changes nothing in these cases:

- `usine.yaml` is invalid or a folder is missing (`FactoryConfigError`).
- The `webhooks` or `tracing` block differs from the running one, or a `workers` change applies only at startup (`RestartRequiredError`, which includes the field name).
- A worker that the reload adds, a worker that it gives more slots, or an agent's harness, model, and effort that no running agent uses fails [preflight](/reference/configuration/agent-files/#preflight) on a worker (`ReloadPreflightError`). Fix the worker or the agent file, and reload again.

The `webhooks` and `tracing` blocks, those `workers` changes, and the GitHub App credentials apply only when `usine up` starts.

```sh title="Instance folder"
kill -HUP "$(cat .usine/instance.pid)"
```

### Shutdown

The first `SIGINT` or `SIGTERM` (Ctrl+C) starts a graceful drain: usine logs `Orchestrator shutdown started`, writes `stoppingSince` to the instance record, stops opening new work, and waits for active attempts to finish ([`withGracefulShutdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/shutdown.ts#L25)). The drain's deadline is `settings.max_attempt_minutes`, or none without that setting. After a full drain, the log shows `Orchestrator exiting after graceful drain`.

A second signal, or the deadline, stops the orchestrator without waiting. Running attempts stay recorded as open, and the next `usine up` reattaches them. Runs that wait for a worker and pending automatic retries continue at the next start. The process exits with status 130. Until it exits, the instance lock blocks a new `usine up`.

`usine stop` sends these signals for you and waits for the process to exit. With `--force`, it sends `SIGKILL` if the process still runs after its timeout.

## `usine status`

Reports whether `usine up` runs in the instance folder. It reads the instance lock and the instance record, and sends one `GET /api/overview` to the running orchestrator:

```text
usine is running in /home/me/factory.
  pid       48120
  address   http://127.0.0.1:7331
  engine    @usine/server 0.4.0, installed in the instance
  started   2026-10-25T16:04:00.000Z (2h 13m 5s ago)
  runs      1 running, 2 queued
  update    @usine/server 0.5.0 is available. Run usine upgrade.
```

- `engine` names the entry point if the engine runs from outside the instance's `node_modules`, such as a checkout.
- `runs` counts the open runs by state. If the orchestrator doesn't answer, it says `unavailable` and why.
- `installed` appears if the `usine` that you run has the orchestrator's entry point but another version, for example after an install without a restart.
- `update` appears for an engine that is installed in the instance from its `package.json` pin. It compares the running version with the `latest` version that `npm view` reports.
- A draining orchestrator reports `usine is stopping` and when the drain started.
- An orchestrator of an earlier usine version, which writes only `.usine/instance.pid`, is reported as running with its PID only.
- A stopped instance reports `usine is not running`, and the PID of stale files if a process left them.

The command exits with status 0 if a process holds the instance, and 3 if none does.

## `usine stop`

| Flag | Value | Default | Description |
| --- | --- | --- | --- |
| `--timeout <seconds>`, `--timeout=<seconds>` | whole number above 0 | `120` | How long to wait for the process to exit. |
| `--force` | none | off | Sends a second `SIGTERM`, which stops the orchestrator without waiting for running attempts, and `SIGKILL` if the process still runs after the timeout. The next `usine up` reattaches the attempts. |

Sends `SIGTERM` to the orchestrator, which starts the [drain](#shutdown), and waits until the process exits. It names the runs whose attempts the drain waits for. If no `usine up` runs, it prints `usine is not running in <folder>.` and exits with status 0. It also stops an orchestrator of an earlier usine version, through `.usine/instance.pid`.

If the process still runs after the timeout, the command exits with status 1, and the drain continues. Run `usine stop` again to keep waiting: the instance record shows the drain, so the command doesn't send the second signal. Run `usine stop --force` to stop without waiting.

With `--force`, a process that still runs after the timeout gets `SIGKILL`, and the command prints `usine (pid <pid>) did not exit within <timeout>. Sent SIGKILL: the next start reattaches the running attempts.` It then waits up to 5 seconds for the process to exit, and exits with status 1 if the process still runs.

## `usine restart`

Takes the same flags as `usine stop`. It applies `--timeout` to the stop, and to the start as the time without a new log line.

Stops the orchestrator as `usine stop` does, then starts it as a [background start](#background-start) with the Node.js binary, Node.js options, entry point, port, and flags from the instance record. After a rebuild of a checkout, the entry point is the rebuilt one. The new process inherits the environment of the shell that runs `usine restart`, not the environment of the process that it replaces, and reads the [environment file](#environment-file) again. A variable in `.env` doesn't need to be set in that shell.

If the orchestrator has no instance record that this `usine` can read, for example because an earlier usine version started it, the command stops the process in `.usine/instance.pid`. It then starts `usine up` as `usine up --detach` without flags would: with the `usine` that you run, and the port, log level, and volatile flag that the shell or `.env` sets, else the defaults. Before it stops the process, it lists the TCP ports that the process listens on, from `/proc` on Linux and from `lsof` elsewhere, and runs the checks below on the port where the process answers the operator API. That port can differ from the new one. The checks pass if no port answers. The command prints the port that it checks, if any, and the new port.

The command changes nothing and exits with status 1 in these cases:

- No `usine up` runs in the folder. Start it with `usine up --detach`.
- A process holds the instance lock, but `.usine/instance.pid` names no running process, because the orchestrator is still starting. Run the command again after it starts.
- A run has a running attempt, unless you pass `--force`. Without a deadline, the drain would keep the orchestrator down until the attempt ends.
- Neither the shell nor `.env` sets the `admin_token_env` variable of a gateway in the running configuration. The new process would stop at startup without it.
- The orchestrator has no readable instance record, and the command can't list the ports of its process, for example because another user started it. Run the command as that user, or run `usine stop` and then `usine up --detach`.

## `usine upgrade [<version>]`

| Flag | Value | Default | Description |
| --- | --- | --- | --- |
| `<version>` | a version, range, or dist-tag | `latest` | The `@usine/server` version to pin. |
| `--check` | none | off | Prints the running, pinned, and available versions, and changes nothing. |
| `--timeout <seconds>`, `--force` | | | As for `usine restart`. |

Moves the `@usine/server` pin in the instance's `package.json` and restarts the orchestrator on the new version. It applies to an instance that pins `@usine/server` to a registry version and runs the engine from its own `node_modules`. The command runs these steps in order:

1. **Version.** It resolves `<version>` with `npm view` in the instance folder, so the folder's `.npmrc` applies. Other `@usine/*` packages with a registry version in `package.json` move to the version that the new `@usine/server` depends on, or to their latest version.
2. **Checks.** It refuses, as `usine restart` does, while a run has a running attempt or neither the shell nor `.env` sets a gateway's admin token variable.
3. **Backup.** It copies `.usine/runtime.sqlite` and `.usine/durable.sqlite` into `.usine/backups/`, as `usine backup` does, named `runtime-<UTC time>-<running version>.sqlite` and `runtime-<UTC time>-<running version>.durable.sqlite`.
4. **Stop.** It stops the orchestrator as `usine stop` does.
5. **Install.** It rewrites the version of each pin in `package.json` and keeps the rest of the file as it is. Then it runs `install` with the instance's package manager: the one in the `packageManager` field, else the one whose lockfile exists (pnpm, npm, Yarn, or Bun), else npm. If the install fails, it restores `package.json` and the lockfile, and the orchestrator stays stopped.
6. **Commit.** It commits `package.json` and the lockfile, and no other file, as `Pin @usine/server to <version>`. If Git fails, it says so and continues.
7. **Start.** If the orchestrator was running, it starts it as `usine restart` does, and the new version runs its forward-only migrations at startup.

If the new version exits before it listens, for example because a migration failed, the command prints the last lines of `.usine/usine.log` and the steps to roll back: revert the commit, install, restore the backup, and start the orchestrator.

The command changes nothing in these cases:

- The orchestrator runs from outside the instance's `node_modules`, such as a checkout or a global install. The command exits with status 1 and says how to update that engine. `--check` still prints the versions.
- `package.json` is missing, or doesn't pin `@usine/server` to a registry version, for example because it links a local folder. The command exits with status 1.
- The pin already has the version. If the orchestrator runs another version, the command suggests `usine restart`.
- Without `<version>`, the `latest` version is older than the pin.

If no `usine up` runs, the command moves the pin and installs, and doesn't start the orchestrator.

## `usine backup <path>`

Copies the instance's runtime store, `.usine/runtime.sqlite`, to `<path>`, and its durable storage, `.usine/durable.sqlite`, next to it ([`backup`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/backup.ts#L19)). The durable copy's name is the destination name with `.durable` before the extension: `backup.sqlite` gives `backup.durable.sqlite`.

- It works while `usine up` runs, without the instance lock, through SQLite's backup API on read-only connections.
- Both copies have owner-only permissions.
- `<path>` is relative to the working directory. Its directory must exist and support hard links.
- It fails instead of overwriting a file at either destination.
- It copies the durable storage first, and removes that copy if the runtime copy fails.
- If the instance has no durable storage yet, it backs up only the runtime store and says so.

```sh title="Terminal"
cd ~/factory
usine backup ~/backups/factory-2026-10-16.sqlite
```

## `usine export-run <runId>`

Writes the evidence of one run to a new JSON file, read in one transaction: its event and approval, run, step and its result, attempts, effective task and agent, repository and revision, and transcript ([`exportRun`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/export-run.ts#L81)). It opens `.usine/runtime.sqlite` read-only, without credentials and without starting execution.

| Flag | Default | Description |
| --- | --- | --- |
| `-o <path>`, `--output <path>` | `run-<runId>.json` in the working directory, with the run ID URL-encoded | Where to write the file. |

The file has mode `0600` and the top-level keys `version` (`1`), `exportedAt`, `snapshot`, and `transcript`. The command never overwrites an existing destination. With an unknown run ID, the command exits with `Run <runId> was not found.`

## Environment variables

The `usine` process reads these variables from its environment, or from the [environment file](#environment-file) if the environment doesn't set them:

| Variable | Read by | Description |
| --- | --- | --- |
| `USINE_PORT` | `usine up` | The HTTP port if `--port` is absent. If the value isn't a whole number from 1 to 65535, `usine up` exits with status 1. `usine restart` passes the recorded port with `--port`, so this variable doesn't change it unless the instance record is missing or unreadable. |
| `USINE_LOG_LEVEL` | `usine up` | The log level if `--log-level` is absent. If the value isn't `trace`, `debug`, `info`, `warn`, or `error`, in any case, `usine up` exits with status 1. `usine restart` passes the recorded level with `--log-level`, so this variable doesn't change it unless the instance record is missing or unreadable. |
| `USINE_ALLOW_VOLATILE_INSTANCE` | `usine up` | `1` has the same effect as `--allow-volatile-instance`. usine ignores other values. |
| `TMPDIR` | `usine up` | Added to the temporary directories of the volatile path check. |
| `USINE_GITHUB_APP_ID` | `usine up` | The GitHub App ID, a positive integer. Takes precedence over `app_id` in the secrets file. |
| `USINE_GITHUB_PRIVATE_KEY` | `usine up` | The App's PEM-encoded RSA private key. Takes precedence over `private_key` in the secrets file. |
| the name in `admin_token_env` | `usine up` | One per SSH worker with a `gateway`: the token for the gateway's admin API. If it's unset, startup fails. |
| `OTEL_RESOURCE_ATTRIBUTES` | `usine up` with a [`tracing`](/reference/configuration/usine-yaml/#tracing) block | Resource attributes of exported spans, as comma-separated `key=value` pairs with percent-encoded keys and values. If a key or value isn't valid percent-encoding, `usine up` exits with status 1. |

usine starts in setup mode, without falling back to the file, if a GitHub App variable is set but invalid. It does the same if the secrets file is missing, unreadable, not mode `0600`, or not JSON with exactly the two keys.

Child processes don't inherit the orchestrator's environment. Git and `gh` commands for a local worker receive only `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, and `USER`. The `ssh` client for an SSH worker receives those and `SSH_AGENT_PID` and `SSH_AUTH_SOCK` ([`SSH_ENVIRONMENT_ALLOWLIST`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/executor/src/remote/commands.ts#L70)). Only the orchestrator process has the App private key and the gateway admin tokens.

### Environment file

Each `usine` command reads `.env` in the instance folder when it starts, before it reads any variable ([`instanceEnvironment`](https://github.com/basaltbytes/usine/blob/main/apps/server/src/instance/environment.ts)). As with [dotenv](https://github.com/motdotla/dotenv), a variable that the environment sets keeps its value, and `.env` sets the others. So `USINE_PORT=8080 usine up` overrides a `USINE_PORT` in `.env` for one start. Without `.env`, usine reads the environment alone. If `.env` exists but can't be read, the command exits with status 1 and names the file.

```sh title=".env"
# The variable that admin_token_env names in usine.yaml
USINE_GATEWAY_ADMIN_TOKEN=4f0c...
export HCLOUD_TOKEN=...
USINE_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
```

- Each line is `KEY=value`, optionally after `export`. A `#` outside quotes starts a comment, so quote a value that contains `#`.
- A value can be in single, double, or backtick quotes. In double quotes, `\n` is a newline.
- usine doesn't expand variables or run commands: `${HOME}` and `$(cat token)` stay as written.
- An empty value, as in `KEY=`, counts as unset.
- `usine up` reads `.env` only when it starts, and a reload doesn't read it. After you change it, run `usine restart`.
- usine doesn't add the variables to its process environment. A child process gets a variable from `.env` only if its list above includes it, such as `PATH`.

Unlike the [gateway's environment files](#usine-gateway), `.env` doesn't override the environment. It contains secrets, so make it readable only by you, and keep it out of git:

```sh title="Instance folder"
chmod 600 .env
echo .env >> .gitignore
```

## Exit status

| Status | When |
| --- | --- |
| `0` | `--help`, `--version`, a completed `backup`, `export-run`, `stop`, `restart`, or `upgrade`, a background start that listens, or `status` while a process holds the instance. |
| `1` | A usage error, an unreadable `.env`, a refused start (volatile path, instance in use, port in use, lock failure), an invalid `usine.yaml`, any other startup failure, a failed `backup` or `export-run`, or a refused, timed-out, or failed `stop`, `restart`, or `upgrade`. The message is on standard error. |
| `3` | `status` while no process holds the instance. |
| `130` | `usine up` stopped by `SIGINT` or `SIGTERM`. |

## `usine-gateway`

The gateway host runs a separate binary, `usine-gateway`, from `@usine/gateway`. It takes no arguments and logs one JSON object per line to the journal. The response to a refused request has the reason in its `x-usine-gateway-refusal` header, and the log records it. The binary reads the variables below from the environment files listed in `USINE_GATEWAY_ENVIRONMENT_FILES`, and from the process environment for any variable that no file sets ([`settingsFromEnvironment`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/environment.ts#L212)). If a required variable is missing, a value is invalid, or the allowlist can't be read, the binary exits before it starts listening.

On `SIGHUP`, which `systemctl reload usine-gateway` sends, the gateway reads its environment files and its allowlist file again and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, `USINE_GATEWAY_CHATGPT_AUTH_FILE`, the three upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST`. It also reads the ChatGPT auth file again, so a new `auth.json` copied over it replaces the login ([`reloadOnHangup`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/reload.ts#L226)). The attachments, the admin API, the listeners, and open tunnels don't change, so running attempts continue. The log line `Reloaded the gateway settings` lists the keys that changed. If the allowlist doesn't parse, the provider settings are invalid, or the ChatGPT auth file isn't a ChatGPT login, the gateway keeps the current settings and logs the reason. Variables that the process environment set at startup don't change on a reload.

The domain, the listeners, the admin token, and the caller key change only with a restart (`systemctl restart usine-gateway`). If a reload finds one of them changed, it logs `Settings changed that take effect only after a restart` with the variable names and applies the rest. A restarted gateway loses its attachments, and the executor registers each running attempt's attachment again within two minutes.

| Variable | Default | Description |
| --- | --- | --- |
| `USINE_GATEWAY_ENVIRONMENT_FILES` | none | Environment files separated by `:`, each with one `KEY=value` per line. Quote a value that contains `#`. A variable in a later file overrides the same variable in an earlier file and in the process environment. Read from the process environment only. |
| `USINE_GATEWAY_DOMAIN` | required | The private DNS domain. The same value as `gateway.domain` in `usine.yaml`. |
| `USINE_GATEWAY_ADMIN_TOKEN` | required | Bearer token of the admin API, at least 32 characters. The orchestrator's variable named by `admin_token_env` contains the same value. |
| `USINE_GATEWAY_CALLER_KEY` | required | HMAC key that signs caller tokens, at least 32 characters. Only the gateway has it. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | `/etc/usine-gateway/egress-allowlist` | File of hosts that the forward proxy allows. One rule per line: `host` or `*.domain`, optionally with `:port`. A rule without a port allows 443 and 80. `#` starts a comment. |
| `ANTHROPIC_API_KEY` | none | Anthropic API key that the gateway adds for Claude Code. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | none | Alternative Anthropic credential: a Claude subscription token from `claude setup-token`, valid for one year. Setting both Anthropic variables is an error. |
| `OPENAI_API_KEY` | none | OpenAI-compatible API key that the gateway adds for Codex. |
| `USINE_GATEWAY_CHATGPT_AUTH_FILE` | none | Alternative OpenAI credential: the absolute path of a Codex `auth.json` with a ChatGPT login, which the gateway refreshes and rewrites, so the service needs write access to its directory. Setting both OpenAI variables is an error. If the file isn't a ChatGPT login, the binary exits before it starts listening. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Base URL for Anthropic requests. |
| `USINE_GATEWAY_OPENAI_UPSTREAM` | `https://api.openai.com` | Base URL for OpenAI requests with `OPENAI_API_KEY`. |
| `USINE_GATEWAY_CHATGPT_UPSTREAM` | `https://chatgpt.com/backend-api/codex` | Base URL for OpenAI requests with `USINE_GATEWAY_CHATGPT_AUTH_FILE`. |
| `USINE_GATEWAY_PROXY_HOST`, `USINE_GATEWAY_PROXY_PORT` | `127.0.0.1`, `80` | Listener of the reverse proxy that workers call for GitHub and LLM providers. |
| `USINE_GATEWAY_EGRESS_HOST`, `USINE_GATEWAY_EGRESS_PORT` | `127.0.0.1`, `3128` | Listener of the forward proxy. |
| `USINE_GATEWAY_ADMIN_HOST`, `USINE_GATEWAY_ADMIN_PORT` | `127.0.0.1`, `7070` | Listener of the admin API. `admin_port` in `usine.yaml` is the same port. The executor forwards a local port to it over SSH. |
