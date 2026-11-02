---
title: CLI
description: Commands, arguments, environment variables, lifecycle behavior, and exit statuses.
---

The `@usine/server` package provides `usine`. Run commands from the instance folder, where `.usine/runtime.sqlite` stores configuration and run history. Each command reads `.env` before resolving its environment. `usine --help` prints usage; `usine --version` prints the installed release.

## usine up

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--port` | integer, 1–65535 | `USINE_PORT`, then `7331` | HTTP port on `127.0.0.1`. |
| `--origin` | HTTP or HTTPS origin | `USINE_ORIGIN`, then loopback | Canonical browser address without a path, query, or fragment. |
| `--log-level` | `trace`, `debug`, `info`, `warn`, or `error` | `USINE_LOG_LEVEL`, then `info` | Minimum log level, without case sensitivity. |
| `--allow-volatile-instance` | flag | off | Permit an instance folder under temporary storage. |
| `--detach` | flag | off | Start a detached process with output in `.usine/usine.log`. |

```sh
usine up
usine up --detach --origin https://usine.example.com
```

Startup takes the instance lock, checks the listener, loads stored configuration, reads App and worker credentials, checks workers, and recovers attempts. Empty configuration tables accept a bootstrap import or initialize empty setup configuration. [Import and export format](/reference/configuration/import-export/) describes bootstrap input. Later starts read the database.

Missing or invalid App credentials start setup mode. Polling and schedules stay idle until setup completes. Worker preflight failure stops runtime startup. The App secrets file, `.usine/github-app.json`, must be a regular file with mode `0600`; environment values override corresponding file fields.

A second process cannot run the same instance folder. Temporary paths are refused by default because runtime state needs persistent storage. On macOS, startup warns if system sleep can interrupt remote sessions. Logs use ISO 8601 UTC timestamps.

### Background start

A detached start retains the selected Node binary, options, entry point, and launch flags. It waits for the process to answer after startup recovery. If the process exits, the command prints its exit and the log tail. After 120 seconds without an answer or new log line, the command reports a timeout while the process can still be starting. Logs have owner-only permissions and require operator-managed rotation.

### Instance record

`.usine/instance.json` records PID, release, start time, launch settings, systemd unit when applicable, and drain start time. The lock determines whether a process owns the instance; stale process records are replaced on the next start. `.usine/instance-id` identifies attempt containers and must remain with the instance during moves and restores.

### Instances that systemd runs

Lifecycle commands verify that the recorded unit owns the process. They use `systemctl stop --no-block` and `systemctl start` to preserve service management. Service starts use the service environment and the instance `.env`. The service user needs authorization to manage the unit. See [server deployment](/guides/run-the-orchestrator-on-a-server/).

## usine status

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| none | none | instance folder | Report the owning process, listener, version, uptime, open runs, and systemd unit. |

```sh
usine status
```

The command exits with `0` for an owned instance and `3` when stopped. It identifies stale process records and reports an active drain.

## usine stop

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `--timeout` | integer seconds > 0 | `120` | Wait for the process to exit before reporting a timeout. |
| `--force` | flag | off | Stop without waiting for attempts and send SIGKILL if the process exceeds the timeout. |

```sh
usine stop --timeout 300
```

The first stop request stops admission and drains running attempts. A command timeout leaves the drain active. Another ordinary stop waits without escalating; `--force` sends the second termination signal. A stopped instance returns success.

### Shutdown

Ctrl+C or SIGTERM starts a drain. Its deadline uses `settings.max_attempt_minutes` when set. A second signal stops immediately. Retained Pi parent tasks and checkouts can reattach on the next start. If a task cannot be confirmed stopped, its slot remains reserved and reconciliation retries rather than starting duplicate work.

## usine restart

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `--timeout` | integer seconds > 0 | `120` | Maximum wait for stop and restart lifecycle operations. |
| `--force` | flag | off | Permit interruption and later reattachment of active attempts. |

```sh
usine restart
```

Restart requires a running instance and retains its launch flags. It refuses active attempts unless forced and verifies required gateway credential variables before stopping. A detached restart appends to `.usine/usine.log`; systemd instances restart through their unit. The new process reads the instance environment again.

## usine upgrade

| Argument or option | Type | Default | Description |
| --- | --- | --- | --- |
| `<version>` | registry version, range, or tag | configured channel for managed global installs, otherwise `latest` | Release to install. |
| `--channel` | `latest` or `next` | configured channel | npm channel for managed global upgrades. |
| `--check` | flag | off | Report versions without changing packages or process state. |
| `--timeout` | integer seconds > 0 | `120` | Lifecycle wait for local pin upgrades. |
| `--force` | flag | off | Restart immediately and reattach active attempts. |

```sh
usine upgrade --check
usine upgrade
```

For a global installation managed by systemd, the command requests the separate upgrade helper and exits after acceptance. The default waits for admitted attempts to finish. **Settings** and the helper journal report the final outcome. The helper backs up stores, installs, restarts, and checks version and readiness. Installation or readiness failure restores the prior package and databases.

For an instance-local registry pin, upgrade backs up stores in `.usine/backups/`, changes package pins, installs with the instance package manager, commits manifest and lockfile changes, and restarts if the instance was running. It refuses active attempts unless forced. Failed installation restores manifests and lockfiles and leaves the instance stopped. Startup failure prints recovery instructions. A stopped instance receives the package update without starting.

A checkout installation requires updating and building its checkout, then restarting. [Upgrade an instance](/guides/upgrade-an-instance/) describes the procedure.

## usine backup

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `<path>` | new file path | required | Destination for the runtime database backup. |

```sh
usine backup /backups/instance.sqlite
```

The command uses SQLite’s backup API while the instance runs. It copies durable storage first and the runtime store second, with owner-only permissions, and refuses an existing destination. The directory must exist and support hard links. A runtime backup failure removes the durable copy. An instance without durable storage produces only the runtime copy and reports it.

The durable path inserts `.durable` before `.sqlite` or `.db`, or appends `.durable.sqlite` for another extension. Backups omit credentials and connection-record files. See [Back up instance state](/guides/back-up-instance-state/).

## usine export-run

| Argument or option | Type | Default | Description |
| --- | --- | --- | --- |
| `<runId>` | run ID | required | Run to read from the runtime store. |
| `-o`, `--output` | new file path | URL-encoded `run-<runId>.json` | Destination for run evidence and transcript. |

```sh
usine export-run <run-id> --output /evidence/run.json
```

The command reads a snapshot without starting execution. JSON contains `version`, `exportedAt`, `snapshot`, and `transcript`, including event, approval, attempts, results, and effective definitions. The file has mode `0600`; an existing path or unknown run is an error.

## usine sign-in

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `<origin>` | instance origin | `USINE_ORIGIN`, then `http://127.0.0.1:<port>` | Instance that issues the device token after GitHub authorization. |

```sh
usine sign-in https://usine.example.com
```

Open the printed device page and enter the code. The token appears once. Store it securely and send it as a bearer token. Its permission ceiling is limited by current role bindings. See [Create a device token](/guides/create-a-device-token/).

## usine sign-in-link

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| none | none | local running instance | Issue a private one-time browser sign-in URL using local admin access. |

```sh
usine sign-in-link
```

The URL works once within ten minutes. Local lifecycle and link commands require a regular `.usine/admin-token` owned by the current user with mode `0600`. Startup replaces that file. See [Access](/reference/access/).

## Configuration commands

[`usine config`](/reference/configuration/config/) documents `export`, `import`, `edit`, and `log`. These commands access the local database directly and save configuration revisions.

## Environment variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `USINE_PORT` | integer, 1–65535 | `7331` | Port used when `--port` is absent. |
| `USINE_ORIGIN` | origin | loopback listener | Canonical origin used when `--origin` is absent. |
| `USINE_LOG_LEVEL` | log level | `info` | Minimum log level used when the flag is absent. |
| `USINE_ALLOW_VOLATILE_INSTANCE` | `1` | off | Equivalent to `--allow-volatile-instance`. |
| `TMPDIR` | path | OS default | Additional path considered temporary by the volatile-instance check. |
| `USINE_GITHUB_APP_ID` | positive integer | App secrets file | GitHub App ID. |
| `USINE_GITHUB_PRIVATE_KEY` | PEM string | App secrets file | App RSA private key in RSA-specific or generic PEM encoding. |
| `USINE_GITHUB_CLIENT_ID` | string | App secrets file | App client ID for member sign-in. |
| `USINE_GITHUB_CLIENT_SECRET` | secret string | App secrets file | App client secret for member sign-in. |
| `USINE_GITHUB_WEBHOOK_SECRET` | secret string | App secrets file | Signature secret for endpoint webhook hints. |
| `PI_CODING_AGENT_DIR` | path | `~/.pi/agent` | Pi parent configuration and credential directory. |
| Worker credential variable names | secret strings | required when configured | Provider tokens, API keys, gateway admin tokens, and Access credentials referenced by worker records. |
| `OTEL_RESOURCE_ATTRIBUTES` | percent-encoded `key=value` list | empty | Additional span resource attributes when tracing is enabled. |

Restart retains recorded port, origin, and log-level flags. Set a different flag on the next explicit start to change them. Invalid process settings fail with a diagnostic. Invalid App credentials enter setup mode. Child processes receive a restricted environment rather than all orchestrator secrets.

### Environment file

Every command reads `.env` in the instance folder. Shell environment values take precedence; empty values count as unset. A missing file is allowed; an unreadable file is an error. Each line is `KEY=value`, optionally prefixed by `export`. Quote values containing a hash character. Single, double, and backtick quotes are accepted; double-quoted `\n` becomes a newline. Variable and command substitutions stay literal.

```dotenv
USINE_ORIGIN=https://usine.example.com
USINE_PORT=7331
```

Keep `.env` private, set mode `0600`, and exclude it from git. Changes take effect when a command starts; the running orchestrator does not reread it on configuration changes.

### Reload

`SIGUSR1` requests a reread of stored configuration. It does not import files or reread `.env`. Most revisions apply automatically. See [revision application](/reference/configuration/config/#revision-application).

## Exit status

| Status | Type | Default | Description |
| --- | --- | --- | --- |
| `0` | exit code | success | Command completed or help printed. |
| `1` | exit code | failure | Invalid usage, refused operation, timeout, or operational error on standard error. |
| `3` | exit code | status only | No process owns the instance. |
| `130` | exit code | signaled shutdown | Foreground orchestrator stopped after SIGINT or SIGTERM. |

## usine-gateway

The `@usine/gateway` package provides a separate `usine-gateway` binary with no arguments. It logs one JSON object per line. Refused proxy requests include `x-usine-gateway-refusal` and a logged reason.

Environment files listed by `USINE_GATEWAY_ENVIRONMENT_FILES` override process values, with later files taking precedence. This differs from the instance `.env`. Missing required values, invalid settings, or an unreadable allowlist stop startup.

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `USINE_GATEWAY_ENVIRONMENT_FILES` | string | none | Environment files separated by `:`, each with one `KEY=value` per line. Quote a value that contains `#`. A variable in a later file overrides the same variable in an earlier file and in the process environment. Read from the process environment only. |
| `USINE_GATEWAY_DOMAIN` | string | required | The private DNS domain. The same value as `gateway.domain` in the stored configuration. |
| `USINE_GATEWAY_ADMIN_TOKEN` | string | required | Bearer token of the admin API, at least 32 characters. The orchestrator's variable named by `admin_token_env` contains the same value. |
| `USINE_GATEWAY_CALLER_KEY` | string | required | HMAC key that signs caller tokens, at least 32 characters. Only the gateway has it. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | string | `/etc/usine-gateway/egress-allowlist` | File of hosts that the forward proxy allows. One rule per line: `host` or `*.domain`, optionally with `:port`. A rule without a port allows 443 and 80. `#` starts a comment. |
| `ANTHROPIC_API_KEY` | string | none | Anthropic API key that the gateway adds for Claude Code. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | string | none | Alternative Anthropic credential: a Claude subscription token from `claude setup-token`, valid for one year. Setting both Anthropic variables is an error. |
| `OPENAI_API_KEY` | string | none | OpenAI-compatible API key that the gateway adds for Codex. |
| `USINE_GATEWAY_CHATGPT_AUTH_FILE` | string | none | Alternative OpenAI credential: the absolute path of a Codex `auth.json` with a ChatGPT login, which the gateway refreshes and rewrites, so the service needs write access to its directory. Setting both OpenAI variables is an error. If the file isn't a ChatGPT login, the binary exits before it starts listening. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM` | string | `https://api.anthropic.com` | Base URL for Anthropic requests. |
| `USINE_GATEWAY_OPENAI_UPSTREAM` | string | `https://api.openai.com` | Base URL for OpenAI requests with `OPENAI_API_KEY`. |
| `USINE_GATEWAY_CHATGPT_UPSTREAM` | string | `https://chatgpt.com/backend-api/codex` | Base URL for OpenAI requests with `USINE_GATEWAY_CHATGPT_AUTH_FILE`. |
| `USINE_GATEWAY_PROXY_HOST`, `USINE_GATEWAY_PROXY_PORT` | host string, integer port 0–65535 | `127.0.0.1`, `80` | Listener of the reverse proxy that workers call for GitHub and LLM providers. |
| `USINE_GATEWAY_EGRESS_HOST`, `USINE_GATEWAY_EGRESS_PORT` | host string, integer port 0–65535 | `127.0.0.1`, `3128` | Listener of the forward proxy. |
| `USINE_GATEWAY_ADMIN_HOST`, `USINE_GATEWAY_ADMIN_PORT` | host string, integer port 0–65535 | `127.0.0.1`, `7070` | Listener of the admin API. `admin_port` in the stored configuration is the same port. The executor forwards a local port to it over SSH. |

For example, set `USINE_GATEWAY_DOMAIN=gw.internal`, private listener addresses, and the required secrets in the gateway environment files.

`systemctl reload usine-gateway` sends SIGHUP and rereads provider settings, ChatGPT auth, upstreams, and the egress allowlist. An invalid reload keeps the accepted settings and logs the reason. Attachments and open tunnels continue. Domain, listener, admin-token, and caller-key changes require restart. After a gateway restart loses attachments, the executor registers running attempts again within two minutes. [Configure a gateway](/guides/configure-a-gateway/) describes setup.
