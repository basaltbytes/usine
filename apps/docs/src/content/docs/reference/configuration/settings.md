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
| `max_attempt_tokens` | integer ≥ 1 | unlimited | Tokens per attempt across all its sessions. |
| `max_background_wait_minutes` | integer ≥ 1 | unlimited | Minutes a child that answered waits for its background work to end or start a turn. When the limit passes, the child returns its answer and its background work stops. See [Background work](#background-work). |
| `allow_usage_credits` | boolean | `false` | Whether a Claude Code child keeps working on usage credits after its Claude subscription plan reaches its usage limit. Other harnesses ignore it. See [Usage credits](#usage-credits). |
| `supervisor` | object | not configured | The harness, model, and effort of the supervisor. See [Supervisor](#supervisor). |
| `upgrade_channel` | `latest` or `next` | `latest` | npm channel checked for global installations managed by systemd or launchd. |
| `upgrade_mode` | `off`, `propose`, or `automatic` | `propose` | Disable upgrade checks, offer upgrades, or upgrade after admitted attempts finish. |

Earlier versions also read `coordinator`, `parent_model`, and `parent_effort` in `settings`. usine ignores these keys in an imported `usine.yaml` and removes them from the stored settings. Every attempt runs on the event-driven [coordinator](/reference/configuration/agents/#coordinator).

For example, edit the existing settings entity and keep its other fields:

```yaml
version: 2
settings:
  poll_interval: 30
  max_children: 4
  max_attempt_minutes: 120
  max_attempt_tokens: 5000000
```

A runaway guard sends the attempt one warning at 80% of either attempt limit and fails the attempt with `RunawayFailure` at 100%. The engine does not retry that failure automatically. A hold stops the wall-clock count, but tokens still count. A restart preserves usage; crash recovery can omit up to 30 seconds of elapsed time.

### Background work

A child can answer while background work that it started, such as a test suite or a CI watch, still runs. A child whose harness reports its background work waits by default for that work and for the turn the work starts, however long they take, so a child can fix what a background test run reports. When its background work ends and no turn starts within five minutes, usine returns the child's last answer as its report. Claude Code reports its background tasks. Codex and Pi report no background work, so their children return their answer at once. The run page shows each change to a child's background work as a note.

Set `max_background_wait_minutes` to bound that wait. If the child is still idle with background work when the limit passes, usine returns the child's last answer as its report, logs a warning with the limit and the IDs of the remaining work, and shows a warning note on the run page. If the work already ended, usine returns the answer at the limit without the warning, as it does after five minutes without a turn. Closing the child ends the Claude Code process, which stops its background tasks; their results never reach the attempt, even if the answer said that the work was still running. When the attempt ends, even as a success, cleanup salvages its checkout as after a failure: for a loop with `write` permissions, it commits uncommitted changes and pushes them, with local commits, to a salvage branch before it removes the checkout. A checkout at its base commit has nothing to salvage. Cleanup applies the limit that the attempt started with, so a change to the setting doesn't affect an attempt that is running. If the salvage doesn't push all the work, the checkout stays on the worker, and the next startup of usine salvages it again. A turn that starts within the limit runs to its own answer. An operator Hold or pause keeps the child open past the limit and past the five minutes. See [Agents](/reference/configuration/agents/) for the Hold and Release behavior.

### Usage credits

When a Claude subscription reaches its plan's usage limit and the account has usage credits turned on, Claude Code keeps working and bills the credits. Claude Code reports a change in the plan's rate-limit status after the request that caused it. By default, usine closes a Claude Code child at the first report that a request ran on usage credits. That request is already billed to the credits. Other requests that Claude Code sent before usine closed the child, such as those of parallel subagents, can be billed too. The attempt ends with a capacity refusal whose message names `settings.allow_usage_credits`, and the run waits in its capacity group until the plan window resets, as after a usage limit. See [Retry a failed run](/guides/retry-a-run/#a-run-that-waits-for-its-provider).

Set `allow_usage_credits: true` to let Claude Code children keep working on usage credits. An attempt applies the value that it started with. The setting covers attempts only: the supervisor keeps working on usage credits. Other harnesses ignore the setting.

Effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The selected model and harness must support the value. See [Agents](/reference/configuration/agents/#agent).

## Supervisor

The supervisor observes and operates the factory for a member, and reads the instance's source to answer questions about the code and the runs. It runs on the orchestrator host, in a read-only container, with the instance's gateway credential, and each turn reopens the conversation that the previous turn saved. In a conversation turn, it lists only the read operations of the [MCP endpoint](/guides/connect-an-mcp-client/)'s tools that the posting member can call in the conversation's scope, and every call goes through the operator API with a read-only credential for the turn, so the supervisor reads what the member can read and changes nothing. The setting selects and checks the supervisor's brain. Members talk to the supervisor in the web UI's supervisor inbox (see [Ask the supervisor](/guides/ask-the-supervisor/)) or through the [conversations](/reference/operator-api/#conversations) of the operator API.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `supervisor.harness` | harness ID | required | The harness that runs the supervisor. |
| `supervisor.model` | string | required | The model that the harness runs. |
| `supervisor.effort` | effort | required | The reasoning effort of the model. |
| `supervisor_image_pull_timeout_minutes` | positive integer | unset | Maximum time for each image pull, in minutes. Omit for no timeout. |

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

Each turn runs in its own container on the orchestrator host, which usine removes when the turn ends. Shutdown and the next startup remove containers by their instance and conversation labels. After a crash, containers can remain until startup cleanup. A conversation runs one turn at a time; if cleanup cannot remove an earlier container, usine refuses another turn.

- **Source.** Each repository that the turn reads is mounted read-only at `<owner>/<repo>` in the session's working directory, at the head of its default branch when the turn starts, without the git history. A turn keeps reading the head that it started on after a push. A turn of a project conversation reads the project's repositories, and a turn of an instance conversation reads every managed repo, each only if the posting member can read it. The orchestrator fetches each repository with a read-only GitHub App token that stays outside the container.
- **Files.** No other instance file is in the container: not the database, the GitHub App key, or a provider login. The harness's home, with its saved sessions, is an in-memory filesystem of `supervisor_limits.conversation_size_mib` in the container, and the kernel refuses writes past that size. No host path in the container is writable. Before the harness starts, usine copies the conversation's saved home into the container; when the turn ends, usine copies it back to the orchestrator. See [Saved conversations](#saved-conversations). Temporary writes use bounded `/tmp` and shared memory.
- **Network.** The container has no network. The harness reaches the model through a relay to the orchestrator, which sends each model request through the instance's gateway with the instance's credential. The relay accepts only the configured supervisor model, limits each request body to `supervisor_limits.model_request_mib` (32 MiB by default) and accepts at most eight simultaneous connections. Oversized requests receive HTTP 413. The session reaches usine only through the operator tools that its harness serves over the session's own connection.

### Tools per harness

| Harness | The harness's own tools in a supervisor session |
| --- | --- |
| Claude Code | `Read`, `Grep`, and `Glob` only. |
| Pi | `read`, `grep`, `find`, and `ls` only. Pi runs in the orchestrator process and runs these tools' file operations in the container. |
| Codex | All of its own tools, including its shell and `apply_patch`, because Codex lists them in every thread. Its shell runs inside the container. It can write files in its home that the next turn loads; it can read the source but cannot change it or reach the network. |

Pi's `read` accepts regular files of at most 2 MiB. Each host command limits combined stdout and stderr to 4 MiB. Pi refuses read-only tools without a host runner.

Pi's `grep` and `find` accept patterns that start with `-`, such as `--network`, so the supervisor can search for command-line flags and filenames that begin with a dash.

**Configuration > Settings** and the settings form say when the selected harness keeps all its own tools, with the reason that its descriptor gives.

### Host requirements

The orchestrator host needs Linux, Docker or Podman that the orchestrator's user can run, and cgroup v2 with CPU, memory, swap and PID controls. usine uses Podman when both runtimes are installed. Rootless Podman needs the setuid helpers `newuidmap` and `newgidmap`, which can't run in a service with `NoNewPrivileges=yes`, such as the unit in [Host usine on a Linux server](/guides/host-usine-on-linux/); use Docker there. On Debian 13, Docker is the `docker.io` and `docker-cli` packages, and the orchestrator's user needs to be in the `docker` group, which is equivalent to root on that host, so dedicate the host to usine. Rootless Docker needs no group; its daemon runs outside the usine unit, so `NoNewPrivileges` doesn't affect it, but it is untested. CI tests rootful Docker; the Podman path is untested on a real runtime. No FUSE, loop device, hardware virtualization, or other host privilege is required. Each container runs `ghcr.io/basaltbytes/usine-worker` with the content-derived tag pinned by the installed usine version. Startup prepares that image in the background, using a cached copy when available and pulling it otherwise. Failed preparation retries every minute without delaying the API or orchestrator startup. A turn waits up to 30 seconds for preparation before asking you to retry; it never pulls an image. Container startup times out after 30 seconds. The supervisor reaches the model through the gateway of the instance's first SSH worker that has one.

Image pulls have no timeout by default, so large layers can finish on slow connections. Set `settings.supervisor_image_pull_timeout_minutes` to a positive whole number to stop each pull after that many minutes and retry one minute later. Restart the orchestrator after changing this setting; choose a timeout long enough for the largest layer to download on your connection. Shutdown stops an active pull.

Once the image is ready, usine runs a startup check in the background: it starts a container with a turn's limits and in-memory home, verifies the cgroup limits, and copies a small home into the container and back out. **Configuration > Settings** and `GET /api/conversations/status` report the supervisor as ready only after the check passes. Until then, they say what usine is doing, such as preparing the image. If the check fails, they give the reason, and usine refuses turns until you fix the cause and restart it. A turn that arrives during the check waits up to 30 seconds for it.

Without a runtime, a gateway, or limits that leave the harness enough memory, the supervisor refuses turns. The instance still starts and logs the reason.

Supervisor Codex protocol frames are limited to `supervisor_limits.protocol_frame_mib` (4 MiB by default), including unfinished lines. If a long conversation exceeds this limit while resuming, increase the setting and restart the orchestrator. Ordinary Codex coding sessions have no app-server frame limit. Process-owner transport frames remain limited to 4 MiB; the owner splits harness output into smaller chunks.

### Host limits

Limits are always enabled, including when `supervisor_limits` is omitted. `cpus` must be positive; fractional values are accepted. The other values must be integers: `memory_mib` is at least 256, `pids` is at least 64, and filesystem and message sizes are at least 1 MiB. Changes take effect after restarting the orchestrator.

| Field in `settings.supervisor_limits` | Default | Description |
| --- | --- | --- |
| `cpus` | `1` | CPU quota in cores. Fractional values are accepted. |
| `memory_mib` | `1024` | Container memory limit in MiB, including the files in the home and `/tmp`. Swap is disabled. |
| `pids` | `256` | Maximum processes and threads in the container. |
| `tmpfs_size_mib` | `64` | Size of `/tmp` in MiB. Shared memory is separately capped at 16 MiB. |
| `model_request_mib` | `32` | Maximum model request body in MiB. Increase this for larger contexts or attachments. |
| `protocol_frame_mib` | `4` | Maximum incoming supervisor Codex protocol frame in MiB. Increase this for long saved histories. |
| `conversation_size_mib` | `128` | Size of the harness's in-memory home in MiB, and the most that usine saves for a conversation on the orchestrator. |

The home and `/tmp` are in-memory filesystems, so their files count against `memory_mib`. `conversation_size_mib` plus `tmpfs_size_mib` must be at most half of `memory_mib`, or usine refuses turns and names the settings. With the defaults, files can use 192 MiB, and the harness keeps at least 832 MiB.

The relay buffers up to eight request bodies at once, so the raw body budget is eight times `model_request_mib`, plus JSON decoding and forwarding overhead. The 32 MiB default accommodates text requests for million-token contexts; attachments may need a larger value. A 413 response names the setting to increase.

```yaml
settings:
  supervisor_limits:
    cpus: 1
    memory_mib: 1024
    pids: 256
    tmpfs_size_mib: 64
    conversation_size_mib: 128
```

### Saved conversations

usine saves each conversation's home as a tar archive at `.usine/supervisor/homes/<sha256>.tar`, where the hash is derived from the complete conversation ID. Only usine writes this file. A save writes a new file and renames it over the previous archive only when the copy is complete, so a failed save keeps the archive of an earlier turn. A conversation uses disk space for what its harness saved, up to `conversation_size_mib`.

When a turn ends, usine stops copying at `conversation_size_mib`. If the archive is larger, usine keeps the previous one and fails the turn with that reason, so the next turn reopens the session that the last saved turn left. A failed or canceled turn is saved too, when its container still runs. If the orchestrator crashes or is killed during a turn, that turn's changes to the home are lost, and the next turn resumes from the last saved archive.

Pi runs in the orchestrator process and writes its session files in the conversation's directory on the orchestrator, under `.usine/supervisor/conversations/<sha256>/workspace/.usine/pi`. usine adds up the size of these files before and after each turn. If they exceed `conversation_size_mib`, the turn fails, and later turns of the conversation are refused until you start a new conversation or raise the limit.

Earlier `next` versions kept each conversation in an ext4 image under `.usine/supervisor/disks`, mounted in `.usine/supervisor/conversations`, where turns could write. When `.usine/supervisor/disks` exists, startup removes every image and every conversation directory, and logs one line for each. The next turn of such a conversation starts a new harness session; its messages and events stay.

Source caches and exported trees use hashes of their repository names. Fetches verify received objects and finish automatic Git maintenance before the source is ready for a turn. Source exports remove absolute symbolic links.

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
