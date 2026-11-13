---
title: Settings
description: Instance settings, webhook hints, browser origins, trusted proxies, and tracing.
---

Edit stored instance settings in **Configuration > Settings** or with `usine config edit settings instance`. The editor contains `version`, `settings`, `operator`, `webhooks`, `auth`, and `tracing`. Secrets come from the instance environment; they are separate from configuration revisions.

## Instance settings

Fields in this table belong to `settings`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `poll_interval` | integer ≥ 1 | `60` | Seconds between GitHub poll cycle starts, subject to rate-limit backoff. |
| `max_children` | integer ≥ 1 | `4` | Child sessions one attempt can start over its lifetime, including sequential sessions. |
| `max_attempt_minutes` | integer ≥ 1 | unlimited | Wall-clock minutes per attempt, excluding operator holds and orchestrator downtime. |
| `max_attempt_tokens` | integer ≥ 1 | unlimited | Tokens per attempt across the parent and all children. |
| `coordinator` | `session` or `events` | `session` | What coordinates attempts of agents without an override: a parent session, or rules on lifecycle events. See [Coordinator](/reference/configuration/agents/#coordinator). |
| `parent_model` | string | Pi selection | Parent model in `provider/model` form for agents without an override. Not allowed with `coordinator: events`. |
| `parent_effort` | effort | agent effort | Parent reasoning effort for agents without an override. Not allowed with `coordinator: events`. |
| `supervisor` | object | not configured | The harness, model, and effort of the supervisor. See [Supervisor](#supervisor). |
| `upgrade_channel` | `latest` or `next` | `latest` | npm channel checked for global installations managed by systemd or launchd. |
| `upgrade_mode` | `off`, `propose`, or `automatic` | `propose` | Disable upgrade checks, offer upgrades, or upgrade after admitted attempts finish. |

For example, edit the existing settings entity and keep its other fields:

```yaml
version: 2
settings:
  poll_interval: 30
  max_children: 4
  max_attempt_minutes: 120
  max_attempt_tokens: 5000000
```

A runaway guard warns the parent once at 80% of either attempt limit and fails the attempt with `RunawayFailure` at 100%. The engine does not retry that failure automatically. A hold stops the wall-clock count, but tokens still count. A restart preserves usage; crash recovery can omit up to 30 seconds of elapsed time.

Effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The selected model and harness must support the value. See [Agents](/reference/configuration/agents/#parent-selection).

## Supervisor

The supervisor observes and operates the factory for a member, and reads the instance's source to answer questions about the code and the runs. It runs on the orchestrator host, in a read-only container, with the instance's gateway credential, and each turn reopens the conversation that the previous turn saved. It lists the operator tools that the member's token allows, the same tools that the [MCP endpoint](/guides/connect-an-mcp-client/) serves, and every call goes through the operator API with that token, so the supervisor can do no more than the member. The setting selects and checks the supervisor's brain; this release has no interface that opens a conversation with it.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `supervisor.harness` | harness ID | required | The harness that runs the supervisor. |
| `supervisor.model` | string | required | The model that the harness runs. |
| `supervisor.effort` | effort | required | The reasoning effort of the model. |

```yaml
version: 2
settings:
  supervisor:
    harness: claude
    model: claude-sonnet-5-5
    effort: medium
```

Without `supervisor`, the instance starts and **Configuration > Settings** reports the supervisor as not configured. Saving refuses a harness that can't serve the role and names what it lacks: the harness must serve usine tool sets, reopen a saved conversation, take steering and interrupts, and report token usage. Claude Code, Codex, and Pi serve the role.

### Where the supervisor runs

Each turn runs in its own container on the orchestrator host, which usine removes when the turn ends. A container whose orchestrator stops ends itself within seconds, and the next start removes any that remain. A conversation runs one turn at a time.

- **Source.** Each repository that the turn reads is mounted read-only at `<owner>/<repo>` in the session's working directory, at the head of its default branch when the turn starts, without the git history. A turn keeps reading the head that it started on after a push. In this release, no interface opens a turn, so the orchestrator doesn't choose or prepare these repositories.
- **Files.** No other instance file is in the container: not the database, the GitHub App key, or a provider login. Only the conversation's own directory, which keeps the harness's saved session, is writable.
- **Network.** The container has no network. The harness reaches the model through a relay to the orchestrator, which sends each model request through the instance's gateway with the instance's credential. The session reaches usine only through the operator tools that its harness serves over the session's own connection.

### Tools per harness

| Harness | The harness's own tools in a supervisor session |
| --- | --- |
| Claude Code | `Read`, `Grep`, and `Glob` only. |
| Pi | `read`, `grep`, `find`, and `ls` only. Pi runs in the orchestrator process and runs these tools' file operations in the container. |
| Codex | All of its own tools, including its shell and `apply_patch`, because Codex lists them in every thread. The container limits what they reach: they read the source, can't change it, and reach no network. |

Pi's `grep` and `find` accept patterns that start with `-`, such as `--network`, so the supervisor can search for command-line flags and filenames that begin with a dash.

**Configuration > Settings** and the settings form say when the selected harness keeps all its own tools, with the reason that its descriptor gives.

### Host requirements

The orchestrator host needs Podman or Docker. usine uses Podman when both are installed, and rootless Podman is the recommended runtime. The host needs no hardware virtualization, so a cloud VM works. Each container runs the attempt image, `ghcr.io/basaltbytes/usine-worker`, which the runtime pulls on the first turn. The supervisor reaches the model through the gateway of the instance's first SSH worker that has one.

On a host without a container runtime, or an instance without a gateway, the instance still starts. It logs `The configured supervisor is unavailable on this orchestrator` with the reason, and **Configuration > Settings** shows the supervisor container as unavailable, with the reason.

## Instance metadata

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | integer | required | Configuration format version, `2`. |
| `operator` | GitHub login | omitted | Login used for initial instance enrollment when configured. |

Interactive API actions record the authenticated actor. Local configuration commands record **local admin**.

## Webhook hints

Fields in this table belong to `webhooks`. Polling detects changes in every mode; hints request an earlier refresh.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `off`, `deliveries`, or `endpoint` | `off` | Source of GitHub webhook hints. |
| `public_url` | URL | required for `endpoint` | Full public delivery URL ending in `/webhooks/github`, accepted only in endpoint mode. |

```yaml
webhooks:
  mode: endpoint
  public_url: https://usine.example.com/webhooks/github
```

`deliveries` reads the App's delivery summaries about every ten seconds and keeps its cursor across restarts. It ignores ping deliveries and unregistered repositories and requires an active App webhook.

`endpoint` accepts signed GitHub requests on the operator server. Set `USINE_GITHUB_WEBHOOK_SECRET` in the instance environment, expose the route over HTTPS, and keep the App webhook active. Startup updates the App's delivery URL. **Settings** shows the running mode and last hint. After ten minutes without a verified delivery, endpoint mode adds a Needs attention entry. Check the URL, secret, active flag, and startup log. A verified delivery, including a ping, clears the warning.

## Browser origins

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `auth.origins` | list of origins | `[]` | Additional exact origins allowed for browser API requests. |

```yaml
auth:
  origins: [https://client.example.com]
```

The canonical origin from `--origin` or `USINE_ORIGIN` is allowed automatically. An origin includes a scheme, host, and optional port, with no path or trailing slash. HTTPS is required except on loopback. Wildcards and `null` are invalid. Origin access does not grant authentication or roles. See [HTTPS access](/guides/expose-an-instance/).

## Trusted proxies

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `auth.trusted_proxies` | list of networks in CIDR notation | `[]` | Reverse proxies whose `X-Forwarded-For` header names the client address. |

```yaml
auth:
  trusted_proxies: [127.0.0.1/32, ::1/128]
```

Sign-in endpoints allow 60 requests per minute per operation from one client address, and 600 per minute for the whole instance. The client address is the address of the connection to usine. When that address is in `auth.trusted_proxies`, usine reads `X-Forwarded-For` from the right, skips addresses in the list, and uses the first other address. An entry can carry a port, such as `203.0.113.7:4711` or `[2001:db8::1]:443`. If the entry it reaches isn't an IP address, such as `unknown`, usine uses the connection address and logs a warning. A request from any other address keeps its connection address, whatever its headers say. With the default empty list, usine ignores `X-Forwarded-For`, so every request through a reverse proxy on the same machine counts as `127.0.0.1`. The warning logged for each refused request names the client address and its `source`: `forwarded`, or the reason usine used the connection address.

Write each entry as a network without host bits, such as `127.0.0.1/32` or `10.0.0.0/8`. List only proxies that you run: a client that connects from a listed address can choose its own client address. Changes require a restart.

## Tracing

Fields in this table belong to the optional `tracing` object. Omit it to disable span export.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `otlp_url` | HTTP or HTTPS URL | required | Exact OTLP/HTTP traces endpoint, without credentials or a query string. |
| `service_name` | non-blank string | `usine` | `service.name` resource attribute that distinguishes instances. |

```yaml
tracing:
  otlp_url: http://localhost:4318/v1/traces
  service_name: usine-eu
```

The orchestrator exports protobuf batches every five seconds and flushes on shutdown. It sends the configured URL unchanged, so include `/v1/traces` when the collector requires it. Authenticate through a local collector; usine sends no authentication headers.

Each poll cycle, HTTP request, and run has a trace. Run traces include attempts and link to the action that started them. Spans include repository, run, attempt, and worker identities; SQL spans exclude parameter values. Worker harnesses export no spans. `OTEL_RESOURCE_ATTRIBUTES` adds percent-encoded, comma-separated `key=value` resource attributes. Failed export requests retry up to three times, then discard buffered spans and pause export for 60 seconds.

SQLite statement caching releases references to completed request spans and API response bodies while preserving SQL trace relationships. This applies with span export on or off.

Changes to `tracing` and `auth` require a restart. See [Revision application](/reference/configuration/config/#revision-application).
