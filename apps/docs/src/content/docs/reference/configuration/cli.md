---
title: CLI
description: The usine commands, their flags, the environment variables that the orchestrator and the gateway read, and exit statuses.
sidebar:
  order: 5
---

The `@usine/server` package provides the `usine` binary ([`main.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/main.ts#L47)). Run every command from the instance folder, the folder that contains `usine.yaml`.

```sh title="Usage"
usine up [--port <port>] [--allow-volatile-instance]
usine backup <path>
usine export-run <runId> [--output <path>]
usine --help
usine --version
```

For any other form, the parser prints the usage on standard error and exits with status 1 ([`parseCli`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/cli.ts#L192)).

| Command | Description |
| --- | --- |
| `usine up` | Starts the orchestrator and serves the UI. |
| `usine backup <path>` | Copies the runtime store and the durable storage while the orchestrator runs. |
| `usine export-run <runId>` | Writes one run's records and transcript to a JSON file. |
| `usine --help`, `usine -h` | Prints the usage. `usine up --help`, `usine backup --help`, and `usine export-run --help` do the same. |
| `usine --version`, `usine -v` | Prints the version of the installed `@usine/server`. |

## `usine up`

| Flag | Value | Default | Description |
| --- | --- | --- | --- |
| `-p <port>`, `--port <port>`, `--port=<port>` | integer 1 to 65535 | `USINE_PORT`, then `7331` | The HTTP port. The server listens only on `127.0.0.1`. |
| `--allow-volatile-instance` | none | off | Starts even if the instance folder is under a temporary directory. |

If a flag repeats, the last value wins.

### Startup

`usine up` runs these steps in order and stops at the first failure ([`up`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/up.ts#L104)):

1. **Volatile path check.** usine refuses an instance folder under `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, or `/var/folders`, by the given path or its real path, because the runtime store is the only copy of every run and transcript. With `--allow-volatile-instance`, usine logs a warning and continues.
2. **Instance lock.** usine holds an exclusive SQLite transaction on `.usine/instance.lock` and writes its process ID to `.usine/instance.pid` ([`holdInstance`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/instance-lock.ts#L44)). A second `usine up` in the folder exits and prints that ID. The lock ends with the process, however it exits.
3. **Port check.** usine refuses a port that another process listens on, and prints that process if `lsof` finds it.
4. **Instance load.** usine reads `usine.yaml`, `agents/`, and `loops/`, and exits with status 1 if `usine.yaml` is invalid or a folder is missing. Invalid loop and agent files don't stop startup ([Validation and quarantine](/reference/configuration/loop-files/#validation-and-quarantine)).
5. **GitHub App credentials.** usine reads `USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY`, and fills a missing one from `.usine/github-app.json` ([`loadLocalCredentials`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/local-secrets.ts#L69)). If both variables are set, usine doesn't read the file. It accepts PKCS#1 keys (`BEGIN RSA PRIVATE KEY`, as GitHub downloads them) and PKCS#8 keys.
6. **Runtime.** usine opens the stores, reads each gateway's admin token, runs preflight on every worker, starts polling and schedules, and reattaches the attempts that an earlier process left running. It prints `usine is running at http://127.0.0.1:<port>`.

An expected startup failure prints one line with the file, setting, or worker at fault, such as a preflight check like `machine` or `harness-login`, and what to do, and exits with status 1. Only a defect in usine prints a full trace.

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

The first `SIGINT` or `SIGTERM` (Ctrl+C) starts a graceful drain: usine logs `Orchestrator shutdown started`, stops opening new work, and waits for active attempts to finish ([`withGracefulShutdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/shutdown.ts#L25)). The drain's deadline is `settings.max_attempt_minutes`, or none without that setting. After a full drain, the log shows `Orchestrator exiting after graceful drain`.

A second signal, or the deadline, stops the orchestrator without waiting. Running attempts stay recorded as open, and the next `usine up` reattaches them. Runs that wait for a worker and pending automatic retries continue at the next start. The process exits with status 130. Until it exits, the instance lock blocks a new `usine up`.

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

The `usine` process reads these variables:

| Variable | Read by | Description |
| --- | --- | --- |
| `USINE_PORT` | `usine up` | The HTTP port if `--port` is absent. If the value isn't a whole number from 1 to 65535, `usine up` exits with status 1. |
| `USINE_ALLOW_VOLATILE_INSTANCE` | `usine up` | `1` has the same effect as `--allow-volatile-instance`. usine ignores other values. |
| `TMPDIR` | `usine up` | Added to the temporary directories of the volatile path check. |
| `USINE_GITHUB_APP_ID` | `usine up` | The GitHub App ID, a positive integer. Takes precedence over `app_id` in the secrets file. |
| `USINE_GITHUB_PRIVATE_KEY` | `usine up` | The App's PEM-encoded RSA private key. Takes precedence over `private_key` in the secrets file. |
| the name in `admin_token_env` | `usine up` | One per SSH worker with a `gateway`: the token for the gateway's admin API. If it's unset, startup fails. |

usine starts in setup mode, without falling back to the file, if a GitHub App variable is set but invalid. It does the same if the secrets file is missing, unreadable, not mode `0600`, or not JSON with exactly the two keys.

Child processes don't inherit the orchestrator's environment. Git and `gh` commands for a local worker receive only `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, and `USER`. The `ssh` client for an SSH worker receives those and `SSH_AGENT_PID` and `SSH_AUTH_SOCK` ([`SSH_ENVIRONMENT_ALLOWLIST`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/executor/src/remote/commands.ts#L70)). Only the orchestrator process has the App private key and the gateway admin tokens.

## Exit status

| Status | When |
| --- | --- |
| `0` | `--help`, `--version`, a completed `backup` or `export-run`. |
| `1` | A usage error, a refused start (volatile path, instance in use, port in use, lock failure), an invalid `usine.yaml`, any other startup failure, or a failed `backup` or `export-run`. The message is on standard error. |
| `130` | `usine up` stopped by `SIGINT` or `SIGTERM`. |

## `usine-gateway`

The gateway host runs a separate binary, `usine-gateway`, from `@usine/gateway`. It takes no arguments and logs one JSON object per line to the journal. The response to a refused request has the reason in its `x-usine-gateway-refusal` header, and the log records it. The binary reads the variables below from the environment files listed in `USINE_GATEWAY_ENVIRONMENT_FILES`, and from the process environment for any variable that no file sets ([`settingsFromEnvironment`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/environment.ts#L212)). If a required variable is missing, a value is invalid, or the allowlist can't be read, the binary exits before it starts listening.

On `SIGHUP`, which `systemctl reload usine-gateway` sends, the gateway reads its environment files and its allowlist file again and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, the two upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST` ([`reloadOnHangup`](https://github.com/basaltbytes/usine/blob/be90a084707dfe4796b68d26860efa8865aa1b07/packages/gateway/src/node/reload.ts#L226)). The attachments, the admin API, the listeners, and open tunnels don't change, so running attempts continue. The log line `Reloaded the gateway settings` lists the keys that changed. If the allowlist doesn't parse or the provider settings are invalid, the gateway keeps the current settings and logs the reason. Variables that the process environment set at startup don't change on a reload.

The domain, the listeners, the admin token, and the caller key change only with a restart (`systemctl restart usine-gateway`). If a reload finds one of them changed, it logs `Settings changed that take effect only after a restart` with the variable names and applies the rest. A restarted gateway loses its attachments, and the executor registers each running attempt's attachment again within two minutes.

| Variable | Default | Description |
| --- | --- | --- |
| `USINE_GATEWAY_ENVIRONMENT_FILES` | none | Environment files separated by `:`, each with one `KEY=value` per line. Quote a value that contains `#`. A variable in a later file overrides the same variable in an earlier file and in the process environment. Read from the process environment only. |
| `USINE_GATEWAY_DOMAIN` | required | The private DNS domain. The same value as `gateway.domain` in `usine.yaml`. |
| `USINE_GATEWAY_ADMIN_TOKEN` | required | Bearer token of the admin API, at least 32 characters. The orchestrator's variable named by `admin_token_env` contains the same value. |
| `USINE_GATEWAY_CALLER_KEY` | required | HMAC key that signs caller tokens, at least 32 characters. Only the gateway has it. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | `/etc/usine-gateway/egress-allowlist` | File of hosts that the forward proxy allows. One rule per line: `host` or `*.domain`, optionally with `:port`. A rule without a port allows 443 and 80. `#` starts a comment. |
| `ANTHROPIC_API_KEY` | none | Anthropic credential that the gateway adds for Claude Code. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | none | Alternative Anthropic credential. Setting both Anthropic variables is an error. |
| `OPENAI_API_KEY` | none | OpenAI credential that the gateway adds. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Base URL for Anthropic requests. |
| `USINE_GATEWAY_OPENAI_UPSTREAM` | `https://api.openai.com` | Base URL for OpenAI requests. |
| `USINE_GATEWAY_PROXY_HOST`, `USINE_GATEWAY_PROXY_PORT` | `127.0.0.1`, `80` | Listener of the reverse proxy that workers call for GitHub and LLM providers. |
| `USINE_GATEWAY_EGRESS_HOST`, `USINE_GATEWAY_EGRESS_PORT` | `127.0.0.1`, `3128` | Listener of the forward proxy. |
| `USINE_GATEWAY_ADMIN_HOST`, `USINE_GATEWAY_ADMIN_PORT` | `127.0.0.1`, `7070` | Listener of the admin API. `admin_port` in `usine.yaml` is the same port. The executor forwards a local port to it over SSH. |
