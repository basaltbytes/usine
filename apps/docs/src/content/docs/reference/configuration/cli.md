---
title: CLI
description: The usine commands, their flags, the environment variables the orchestrator and the Gateway read, and exit statuses.
sidebar:
  order: 5
---

The `@usine/server` package provides the `usine` binary ([`main.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/main.ts#L47)). Every command uses the current working directory as the instance folder: run it from the folder that contains `usine.yaml`.

```sh title="Usage"
usine up [--port <port>] [--allow-volatile-instance]
usine backup <path>
usine export-run <runId> [--output <path>]
usine --help
usine --version
```

The parser accepts exactly these forms ([`parseCli`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/cli.ts#L192)). For anything else, it prints the usage on standard error and exits with status 1.

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
2. **Instance lock.** usine creates `.usine/` and keeps an exclusive SQLite transaction open on `.usine/instance.lock`, then writes its process id to `.usine/instance.pid` ([`holdInstance`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/instance-lock.ts#L44)). A second `usine up` in the same folder exits and prints the first one's process id. The operating system releases the lock when the process exits for any reason.
3. **Port check.** usine refuses a port that another process listens on, and prints that process when `lsof` finds it.
4. **Instance load.** usine reads `usine.yaml`, `agents/`, and `loops/`. It exits with status 1 if `usine.yaml` is invalid or a folder is missing. It leaves out invalid Loop and Agent files, logs a warning for each, and lists them in **Needs you**; see [Loop files](/reference/configuration/loop-files/#validation-and-quarantine).
5. **GitHub App credentials.** usine reads `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, and fills a missing one from `.usine/github-app.json` ([`loadLocalCredentials`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/local-secrets.ts#L69)). usine doesn't read the file when both variables are set.
6. **Runtime.** usine opens the stores, reads each Gateway's admin token, runs Preflight on every Worker, and starts polling and schedules. It prints `usine is running at http://127.0.0.1:<port>`.

Every expected startup failure prints one plain line that names the file, setting, or Worker at fault and what to do, then exits with status 1. A failed Preflight names the Worker and the check that failed, such as `machine` or `harness-login`. Only a defect in usine prints a full error trace.

When the credentials are missing or invalid, usine starts in setup mode instead of the runtime. It serves the UI read-only, prints `usine is waiting for GitHub App setup at http://127.0.0.1:<port>`, and opens that page in the browser. usine doesn't poll GitHub, and it refuses operator actions. Restart `usine up` once the credentials are in place.

The secrets file is JSON with two keys and must be a regular file with mode `0600`:

```json title=".usine/github-app.json"
{
  "app_id": 123456,
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

### Reload

`SIGHUP` reloads the instance folder without a restart, as **Reload configuration** on the **Loops** page and `POST /api/instance/reload` do. usine reads `usine.yaml`, `agents/`, and `loops/` again with the startup loader: it leaves out invalid Loop and Agent files, logs a warning for each, and lists them in **Needs you**. New Runs, the next poll and schedule tick, and the next Attempt use the new configuration; an open Run keeps its Agent. An accepted reload starts the next poll at once, or at the time GitHub asked usine to wait for when that is later. The process keeps running whatever the outcome, and logs `Instance folder reloaded; new Runs use the new configuration` with what changed, or `Instance folder reload rejected; the running configuration is unchanged` with the reason.

A reload applies a Worker's new `max_concurrent_attempts`, a new `local` Worker, and a removed Worker without stopping running Attempts ([`workers`](/reference/configuration/usine-yaml/#workers)).

usine refuses the reload and keeps the running configuration when `usine.yaml` is invalid or a folder is missing (`FactoryConfigError`), when the `webhooks` block differs from the running one or a `workers` change applies only at startup (`RestartRequiredError`, which names the field), or when a Worker it adds, a Worker it gives more slots, or an Agent's harness, model, and effort that no running Agent uses fails [Preflight](/reference/configuration/agent-files/#preflight) on a Worker (`ReloadPreflightError`). The `webhooks` block, those `workers` changes, and the GitHub App credentials apply only when `usine up` starts.

```sh title="Instance folder"
kill -HUP "$(cat .usine/instance.pid)"
```

### Shutdown

The first `SIGINT` or `SIGTERM` (Ctrl+C) starts a graceful drain: usine stops opening new work and waits for active Attempts to finish ([`withGracefulShutdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/shutdown.ts#L25)). The drain has a deadline equal to `settings.max_attempt_minutes`, and no deadline when that setting is absent. A second signal, or the deadline, stops the orchestrator without waiting; usine recovers unfinished Attempts at the next start. The process then exits with status 130.

## `usine backup <path>`

Copies the instance's runtime store, `.usine/runtime.sqlite`, to `<path>`, and its durable storage, `.usine/durable.sqlite`, beside it ([`backup`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/backup.ts#L19)). The durable copy's name is the destination name with `.durable` before the extension: `backup.sqlite` gives `backup.durable.sqlite`.

- It works while `usine up` is running. It doesn't take the instance lock, and it reads both databases through SQLite's backup API on read-only connections.
- `<path>` is relative to the working directory. Its directory must exist and support hard links.
- The backup never overwrites an existing file at either destination; it fails instead.
- usine copies the durable storage first. If the runtime copy then fails, usine removes the durable copy it wrote.
- If the instance has no durable storage yet, usine backs up only the runtime store and prints a message that says so.

```sh title="Terminal"
cd ~/factory
usine backup ~/backups/factory-2026-10-16.sqlite
```

## `usine export-run <runId>`

Writes the evidence of one Run to a new JSON file: its Event, Run, Step, Attempts, rendered task, Agent, repository and revision, and its transcript ([`exportRun`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/export-run.ts#L81)). It reads `.usine/runtime.sqlite` without credentials and without starting execution.

| Flag | Default | Description |
| --- | --- | --- |
| `-o <path>`, `--output <path>` | `run-<runId>.json` in the working directory, with the Run id URL-encoded | Where to write the file. |

The file has mode `0600` and the top-level keys `version` (`1`), `exportedAt`, `snapshot`, and `transcript`. The command never overwrites an existing destination. With an unknown Run id, the command exits with `Run <runId> was not found.`

## Environment variables

The `usine` process reads these variables:

| Variable | Read by | Description |
| --- | --- | --- |
| `USINE_PORT` | `usine up` | The HTTP port when `--port` is absent. If the value isn't a whole number from 1 to 65535, `usine up` exits with status 1. |
| `USINE_ALLOW_VOLATILE_INSTANCE` | `usine up` | `1` has the same effect as `--allow-volatile-instance`. usine ignores other values. |
| `TMPDIR` | `usine up` | Added to the temporary directories of the volatile path check. |
| `USINE_GITHUB_APP_ID` | `usine up` | The GitHub App id, a positive integer. Takes precedence over `app_id` in the secrets file. |
| `USINE_GITHUB_PRIVATE_KEY` | `usine up` | The App's PEM-encoded RSA private key. Takes precedence over `private_key` in the secrets file. |
| the name in `admin_token_env` | `usine up` | One per SSH Worker with a `gateway`: the token for the Gateway's admin API. If it's unset, startup fails. |

If a GitHub App variable is set but invalid, usine doesn't fall back to the secrets file: `usine up` treats the credentials as missing and starts in setup mode. It does the same when the secrets file is missing, unreadable, not mode `0600`, or not valid JSON with exactly the two keys.

Child processes don't inherit the orchestrator's environment. Git and `gh` commands for a local Worker receive only `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, and `USER`. The `ssh` client for an SSH Worker receives those and `SSH_AGENT_PID` and `SSH_AUTH_SOCK` ([`SSH_ENVIRONMENT_ALLOWLIST`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/executor/src/remote/commands.ts#L70)). Only the orchestrator process has the App private key and the Gateway admin tokens.

## Exit status

| Status | When |
| --- | --- |
| `0` | `--help`, `--version`, a completed `backup` or `export-run`. |
| `1` | A usage error, a refused start (volatile path, instance in use, port in use, lock failure), an invalid `usine.yaml`, any other startup failure, or a failed `backup` or `export-run`. The message is on standard error. |
| `130` | `usine up` stopped by `SIGINT` or `SIGTERM`. |

## `usine-gateway`

The Gateway host runs a separate binary, `usine-gateway`, from `@usine/gateway`. It takes no arguments and logs one JSON object per line. It reads the variables below from the environment files that `USINE_GATEWAY_ENVIRONMENT_FILES` names, and from the process environment for any variable no file sets ([`settingsFromEnvironment`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/environment.ts#L212)). If a required variable is missing, a value is invalid, or the allowlist can't be read, it exits before it starts listening.

On SIGHUP, which `systemctl reload usine-gateway` sends, it reads its environment files and its allowlist file again and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, the two upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST` ([`reloadOnHangup`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/reload.ts#L226)). The attachments, the admin API, the listeners, and open tunnels stay as they are. An allowlist that does not parse, or invalid provider settings, keep what is in force, and the log says why. The domain, the listeners, the admin token, and the caller key change only with a restart; a reload that finds one of them changed logs `Settings changed that take effect only after a restart` with the variables' names and applies the rest. Variables the process environment set at startup do not change on a reload.

| Variable | Default | Description |
| --- | --- | --- |
| `USINE_GATEWAY_ENVIRONMENT_FILES` | none | Environment files separated by `:`, each with one `KEY=value` per line; quote a value that contains `#`. A variable in a later file overrides the same one in an earlier file and in the process environment. Read from the process environment only. |
| `USINE_GATEWAY_DOMAIN` | required | The private DNS domain; the same value as `gateway.domain` in `usine.yaml`. |
| `USINE_GATEWAY_ADMIN_TOKEN` | required | Bearer token of the admin API, at least 32 characters. The orchestrator's variable named by `admin_token_env` contains the same value. |
| `USINE_GATEWAY_CALLER_KEY` | required | HMAC key that signs caller tokens, at least 32 characters. Only the Gateway has it. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | `/etc/usine-gateway/egress-allowlist` | File of hosts the forward proxy allows. One rule per line: `host`, `*.domain`, either with `:port`. Without a port a rule allows 443 and 80. `#` starts a comment. |
| `ANTHROPIC_API_KEY` | none | Anthropic credential the Gateway adds for Claude Code. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | none | Alternative Anthropic credential. Setting both Anthropic variables is an error. |
| `OPENAI_API_KEY` | none | OpenAI credential the Gateway adds. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Base URL for Anthropic requests. |
| `USINE_GATEWAY_OPENAI_UPSTREAM` | `https://api.openai.com` | Base URL for OpenAI requests. |
| `USINE_GATEWAY_PROXY_HOST`, `USINE_GATEWAY_PROXY_PORT` | `127.0.0.1`, `80` | Listener of the reverse proxy Workers call for GitHub and LLM providers. |
| `USINE_GATEWAY_EGRESS_HOST`, `USINE_GATEWAY_EGRESS_PORT` | `127.0.0.1`, `3128` | Listener of the forward proxy. |
| `USINE_GATEWAY_ADMIN_HOST`, `USINE_GATEWAY_ADMIN_PORT` | `127.0.0.1`, `7070` | Listener of the admin API. `admin_port` in `usine.yaml` names the port, which the executor forwards a local port to over SSH. |
