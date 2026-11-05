---
title: Settings
description: Instance settings, webhook hints, browser origins, and tracing.
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
| `parent_model` | string | Pi selection | Parent model in `provider/model` form for agents without an override. |
| `parent_effort` | effort | agent effort | Parent reasoning effort for agents without an override. |
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
