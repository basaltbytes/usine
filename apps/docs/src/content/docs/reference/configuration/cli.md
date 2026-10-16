---
title: CLI
description: The usine commands, their flags, the environment variables the orchestrator and the Gateway read, and exit statuses.
sidebar:
  order: 5
---

The `usine` binary is published by `@usine/server` ([`main.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/main.ts#L47)). Every command uses the current working directory as the instance folder: run it from the folder that holds `usine.yaml`.

```sh title="Usage"
usine up [--port <port>] [--allow-volatile-instance]
usine backup <path>
usine export-run <runId> [--output <path>]
usine --help
usine --version
```

The parser accepts exactly these forms ([`parseCli`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/cli.ts#L192)). Anything else prints the usage on standard error and exits with status 1.

| Command | Description |
| --- | --- |
| `usine up` | Starts the orchestrator and serves the UI. |
| `usine backup <path>` | Copies the runtime store and the durable storage while the orchestrator runs. |
| `usine export-run <runId>` | Writes one Run's records and transcript to a JSON file. |
| `usine --help`, `usine -h` | Prints the usage. `usine up --help`, `usine backup --help`, and `usine export-run --help` do the same. |
| `usine --version`, `usine -v` | Prints the version of the installed `@usine/server`. |

## `usine up`

| Flag | Value | Default | Description |
| --- | --- | --- | --- |
| `-p <port>`, `--port <port>`, `--port=<port>` | integer 1 to 65535 | `USINE_PORT`, then `7331` | The HTTP port. The server listens on `127.0.0.1` only. |
| `--allow-volatile-instance` | none | off | Starts even when the instance folder is under a temporary directory. |

When a flag repeats, the last value wins.

### Startup

`usine up` starts in this order and stops at the first failure ([`up`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/up.ts#L104)):

1. **Volatile path check.** usine refuses an instance folder under `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, or `/var/folders`, comparing both the path as given and its real path. The runtime store in that folder is the only copy of every Run and transcript. With `--allow-volatile-instance` it logs a warning and continues.
2. **Instance lock.** usine creates `.usine/` and holds an exclusive SQLite transaction on `.usine/instance.lock`, then writes its process id to `.usine/instance.pid` ([`holdInstance`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/instance-lock.ts#L44)). A second `usine up` in the same folder exits and names the first one's process id. The operating system releases the lock when the process exits, however it exits.
3. **Port check.** usine refuses a port another process listens on, and names that process when `lsof` can find it.
4. **Instance load.** usine reads `usine.yaml`, `agents/`, and `loops/`. An invalid `usine.yaml` or a missing folder exits with status 1. Invalid Loop and Agent files are left out; see [Loop files](/reference/configuration/loop-files/#validation-and-quarantine).
5. **GitHub App credentials.** usine reads `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, and fills a missing one from `.usine/github-app.json` ([`loadLocalCredentials`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/local-secrets.ts#L69)). The file is not read when both variables are set.
6. **Runtime.** usine opens the stores, reads each Gateway's admin token, runs Preflight on every Worker, and starts polling and schedules. It prints `usine is running at http://127.0.0.1:<port>`.

When the credentials are missing or invalid, usine starts in setup mode instead of the runtime. It serves the UI read-only, prints `usine is waiting for GitHub App setup at http://127.0.0.1:<port>`, and opens that page in the browser. Nothing polls GitHub and operator actions are refused. Restart `usine up` once the credentials are in place.

The secrets file is JSON with two keys and must be a regular file with mode `0600`:

```json title=".usine/github-app.json"
{
  "app_id": 123456,
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

### Shutdown

The first `SIGINT` or `SIGTERM` (Ctrl+C) starts a graceful drain: usine stops opening new work and waits for active Attempts to finish ([`withGracefulShutdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/shutdown.ts#L25)). The drain has a deadline equal to `settings.max_attempt_minutes`, and no deadline when that setting is absent. A second signal, or the deadline, stops the orchestrator without waiting; unfinished Attempts are recovered at the next start. The process then exits with status 130.

## `usine backup <path>`

Copies the instance's runtime store, `.usine/runtime.sqlite`, to `<path>`, and its durable storage, `.usine/durable.sqlite`, beside it ([`backup`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/backup.ts#L19)). The durable copy takes the destination's name with `.durable` before the extension: `backup.sqlite` gives `backup.durable.sqlite`.

- It runs while `usine up` runs. It does not take the instance lock and reads both databases through SQLite's backup API on read-only connections.
- `<path>` is resolved from the working directory. Its directory must exist and support hard links.
- An existing file at either destination is never overwritten: the backup fails instead.
- The durable storage is copied first. If the runtime copy then fails, usine removes the durable copy it wrote.
- An instance without durable storage yet backs up the runtime store alone and says so.

```sh title="Terminal"
cd ~/factory
usine backup ~/backups/factory-2026-10-16.sqlite
```

## `usine export-run <runId>`

Writes the evidence of one Run to a new JSON file: its Event, Run, Step, Attempts, rendered task, Agent, repository and revision, and its transcript ([`exportRun`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/export-run.ts#L81)). It reads `.usine/runtime.sqlite` without credentials and without starting execution.

| Flag | Default | Description |
| --- | --- | --- |
| `-o <path>`, `--output <path>` | `run-<runId>.json` in the working directory, with the Run id URL-encoded | Where to write the file. |

The file has mode `0600` and the top-level keys `version` (`1`), `exportedAt`, `snapshot`, and `transcript`. An existing destination is never overwritten. An unknown Run id exits with `Run <runId> was not found.`

## Environment variables

The `usine` process reads these variables:

| Variable | Read by | Description |
| --- | --- | --- |
| `USINE_PORT` | `usine up` | The HTTP port when `--port` is absent. A value that is not a whole number from 1 to 65535 exits with status 1. |
| `USINE_ALLOW_VOLATILE_INSTANCE` | `usine up` | `1` has the effect of `--allow-volatile-instance`. Other values are ignored. |
| `TMPDIR` | `usine up` | Added to the temporary directories of the volatile path check. |
| `USINE_GITHUB_APP_ID` | `usine up` | The GitHub App id, a positive integer. Takes precedence over `app_id` in the secrets file. |
| `USINE_GITHUB_PRIVATE_KEY` | `usine up` | The App's PEM-encoded RSA private key. Takes precedence over `private_key` in the secrets file. |
| the name in `admin_token_env` | `usine up` | One per SSH Worker with a `gateway`: the token for the Gateway's admin API. Unset, startup fails. |

A GitHub App variable that is set but invalid does not fall back to the secrets file: `usine up` treats the credentials as missing and starts in setup mode. So does a secrets file that is missing, unreadable, not mode `0600`, or not valid JSON with exactly the two keys.

Child processes do not inherit the orchestrator's environment. Git and `gh` commands for a local Worker receive only `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, and `USER`. The `ssh` client for an SSH Worker receives those and `SSH_AGENT_PID` and `SSH_AUTH_SOCK` ([`SSH_ENVIRONMENT_ALLOWLIST`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/executor/src/remote/commands.ts#L70)). The App private key and the Gateway admin tokens stay in the orchestrator.

## Exit status

| Status | When |
| --- | --- |
| `0` | `--help`, `--version`, a completed `backup` or `export-run`. |
| `1` | A usage error, a refused start (volatile path, instance in use, port in use, lock failure), an invalid `usine.yaml`, any other startup failure, or a failed `backup` or `export-run`. The message is on standard error. |
| `130` | `usine up` stopped by `SIGINT` or `SIGTERM`. |

## `usine-gateway`

The Gateway host runs a separate binary, `usine-gateway`, from `@usine/gateway`. It takes no arguments, reads its settings from the environment once at startup, and logs one JSON object per line ([`settingsFromEnvironment`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/gateway/src/node/environment.ts#L64)). A missing required variable, an invalid value, or an unreadable allowlist stops it before it listens.

| Variable | Default | Description |
| --- | --- | --- |
| `USINE_GATEWAY_DOMAIN` | required | The private DNS domain; the same value as `gateway.domain` in `usine.yaml`. |
| `USINE_GATEWAY_ADMIN_TOKEN` | required | Bearer token of the admin API, at least 32 characters. The orchestrator's variable named by `admin_token_env` holds the same value. |
| `USINE_GATEWAY_CALLER_KEY` | required | HMAC key that caller tokens are signed with, at least 32 characters. Only the Gateway holds it. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | `/etc/usine-gateway/egress-allowlist` | File of hosts the forward proxy allows. One rule per line: `host`, `*.domain`, either with `:port`. Without a port a rule allows 443 and 80. `#` starts a comment. |
| `ANTHROPIC_API_KEY` | none | Anthropic credential the Gateway adds for Claude Code. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | none | Alternative Anthropic credential. Setting both Anthropic variables is an error. |
| `OPENAI_API_KEY` | none | OpenAI credential the Gateway adds. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Base URL for Anthropic requests. |
| `USINE_GATEWAY_OPENAI_UPSTREAM` | `https://api.openai.com` | Base URL for OpenAI requests. |
| `USINE_GATEWAY_PROXY_HOST`, `USINE_GATEWAY_PROXY_PORT` | `127.0.0.1`, `80` | Listener of the reverse proxy Workers call for GitHub and LLM providers. |
| `USINE_GATEWAY_EGRESS_HOST`, `USINE_GATEWAY_EGRESS_PORT` | `127.0.0.1`, `3128` | Listener of the forward proxy. |
| `USINE_GATEWAY_ADMIN_HOST`, `USINE_GATEWAY_ADMIN_PORT` | `127.0.0.1`, `7070` | Listener of the admin API, which `admin_url` in `usine.yaml` reaches. |
