---
title: Workers
description: Worker connections, containers, gateways, provisioners, and Cloudflare settings.
---

Manage workers in **Configuration > Workers**, or edit an existing worker with `usine config edit worker <name>`. All workers in an instance must use the same executor kind. Without an explicit worker list, an instance has one local worker named `local` with one slot.

This version of usine doesn't run `exe.dev` workers. Saving one in the configuration fails. When `usine up` starts running attempts, it refuses a stored one and stops. Both refusals use the same message:

```text
Worker "<name>" has kind exe.dev, which this version of usine doesn't run. Remove the worker or give it another kind.
```

Without GitHub App credentials, `usine up` still starts in setup mode, which runs no attempts. Setup mode accepts no worker change, so change the worker's kind with `usine config edit worker <name>`, or remove the worker with `usine config import`. Then restart `usine up`.

## Worker

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | kebab-case string | required | Unique worker identity used by attempts and recovery. |
| `kind` | `local`, `ssh`, `cloudflare`, or `exe.dev` | required | Executor adapter and applicable connection fields. |
| `max_concurrent_attempts` | integer ≥ 1 | `1` | Simultaneous attempts, including machines being created by a provisioner. |
| `paused` | boolean | `false` | When `true`, the worker takes no new attempts, and its running attempts finish. |

Edit a local worker as one record:

```yaml
name: local
kind: local
max_concurrent_attempts: 2
```

A paused worker keeps its slots and preflight. The scheduler gives its free slots only to a run that reattaches an attempt that already runs there, and sends every other run to the next unpaused worker in `workers` order. Pausing or resuming a worker applies on reload without a restart or a preflight. While a worker is paused, its page, the **Workers** line on **Overview**, and **Needs attention** show it. Exports omit `paused: false`. See [Pause a worker](/guides/pause-a-worker/).

Local children run as the orchestrator's Unix user and can read that user's credentials. Use local workers only for trusted agents. Cached clones, attempt worktrees, and Turbo outputs are under `.usine/workers/<name>/`. Children also share the user's pnpm store. Pi children require a local worker. Each child process and its tool commands receive the attempt base environment plus only that harness's configuration and credential wiring. Registering another harness does not add its variables to existing harnesses.

Preflight requires at least 1.5 GiB per concurrent attempt and warns below 3 GiB. Allocate enough memory for the repository's heaviest checks; the minimum is a tool-start requirement. A startup preflight failure stops startup. An explicit preflight failure on a running worker blocks new attempts there until a successful check.

## SSH connection

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `destination` | SSH destination | required without a provisioner | Host, address, `user@host`, or SSH configuration alias. |
| `port` | integer, 1–65535 | SSH configuration | Port for a fixed destination, refused with a provisioner. |
| `identity_file` | path | SSH configuration or agent | Private key on the orchestrator, required for Boat. |
| `root` | absolute path | required | Writable remote base for `workers/<name>/`. |
| `min_free_disk_gib` | integer ≥ 0 | 10 | Free disk space in GiB that the machine needs before an attempt starts; `0` turns the check off. |
| `container` | container settings | derived limits | Attempt image and resource limits. |
| `gateway` | gateway settings | omitted | GitHub and model credential proxy. |
| `tailnet.gateway_address` | IPv4 address in `100.64.0.0/10` | omitted | Gateway address for a long-lived machine already on Tailscale; requires `gateway` and `destination`. |
| `provisioner` | provisioner settings | omitted | Provider that creates machines for attempts. |

```yaml
name: worker-one
kind: ssh
destination: usine@203.0.113.20
identity_file: ~/.ssh/usine_worker
root: /home/usine/.usine
max_concurrent_attempts: 1
```

Set exactly one of `destination` or `provisioner`. SSH runs in batch mode and requires a trusted host key. Fixed destinations use your SSH configuration and known-hosts file. Provisioned machines use pinned keys in `.usine/known-hosts/`; the executor generates Hetzner keys before creation and obtains Boat keys from its API. boxd machines don't use SSH: usine runs their commands through boxd's `Exec` API.

SSH workers receive gateway tokens and provisioner API keys as a secret environment block on standard input, which each command reads before its command input or child protocol starts. Values stay out of command arguments, the SSH client's environment, and credential files. The worker needs a POSIX `sh` and `base64`; no sshd `AcceptEnv` setting is required.

## Attempt container

Fields belong to `container` on an SSH worker.

The default worker image tag and install packages come from the harness descriptors. The SSH attempt image, Hetzner cloud-init, and Cloudflare sandbox image use the same worker package versions. When building usine from source, run `pnpm worker-image:generate` after changing a descriptor's installation requirements; `pnpm check` checks the generated inputs. Preflight accepts any installed Claude Code version and checks Codex against its accepted versions.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `image` | image reference | release's worker image | Container image with Git, gh, Node.js, and the child harnesses. The release's image also has the boxd CLI, signed out and with telemetry off, for `boxd <command> --help`, unless boxd stopped serving the pinned version before the image was built. |
| `cpus` | number > 0 | host CPUs ÷ slots | CPU limit per attempt. |
| `memory_mib` | integer ≥ 256 | (host MiB − 1024) ÷ slots | Memory limit per attempt. |
| `pids` | integer ≥ 64 | (host process capacity − 1024) ÷ slots | Process limit per attempt. |

`shm_size_mib` and `tmpfs_size_mib` are positive integers under `container`. They set the memory-backed capacities of `/dev/shm` and `/tmp`, respectively, in MiB; each defaults to 2048 and is capped at the container memory limit. Docker and Podman set `TMPDIR=/tmp`, so temporary files avoid host disk sync latency. Both filesystems and running processes share the container memory limit; these capacities do not reserve additional memory. Container removal deletes the temporary files.

```yaml
container:
  memory_mib: 6144
  shm_size_mib: 2048
  tmpfs_size_mib: 2048
```

Derived limits round down to a hundredth of a CPU, a MiB, and a process, with minimums of 0.01 CPUs, 256 MiB, and 64 processes. For example, `container: { memory_mib: 4096 }` fixes memory while preflight derives the other limits. Provisioned machines derive limits for one attempt. **Workers** shows the applied limits and which were derived. Reducing concurrency keeps existing limits until the next preflight.

`/etc/usine/container-runtime` selects Podman or Docker. Without the file, installed Podman takes precedence. A selected runtime that fails checks blocks preflight. Without a usable runtime, fixed SSH workers can run as the SSH user in degraded mode, where attempts can read each other's credentials.

Containers mount the attempt checkout and credential directory, the SSH user's login files of the attempt's harness, and shared pnpm and Turbo volumes. A container mounts no login files for a harness whose provider credential comes from the gateway (`llm_providers`) or a provisioner API key; preflight logs, for each harness, which login files the worker's containers mount if the machine has them, and why. Other attempts' checkouts and tokens are outside these mounts. Custom images must use the SSH user's UID with home `/home/usine`. Rootless Podman requires cgroup v2, delegated CPU, memory, and PID controllers, subordinate UID/GID ranges, and a lingering user manager. Preflight checks resource enforcement and pulls the image.

Claude Code sessions in attempt containers persist in `<root>/workers/<name>/claude/<attempt>`, mounted writable at `/home/usine/.claude/projects`. This directory remains while the attempt checkout exists, so reattached children resume their saved conversations after an orchestrator restart recreates the container. Cleanup removes it after checkout removal; the sweep also removes orphan session directories that no attempt uses. Claude's credential file mount and seeded `.claude.json` remain separate. Shared-user SSH continues to use the SSH user's session directory.

Shared `usine-pnpm-store` and `usine-turbo-cache` volumes survive containers on a fixed machine; provisioned-machine deletion removes them. Preflight logs pnpm disk usage but does not prune it. To reclaim a volume, pause the worker's loops, let attempts finish, remove containers referencing it, then run `podman volume rm usine-pnpm-store` or `podman volume rm usine-turbo-cache`. Use `docker` for Docker workers. Run preflight to recreate empty volumes.

### Free disk space and older images

Preflight and each attempt, before its checkout starts, check the free disk space on the filesystem of `root` and on the container runtime's image storage. If either has less than `min_free_disk_gib` GiB free, the check fails with a `disk` error that states the free space and the threshold. **Needs attention** shows the error, and no attempt starts on the worker until a preflight passes. Preflight runs again after 1, 2, 5, and then every 10 minutes. When the check fails before a checkout, the attempt fails with an infrastructure failure, which usine retries.

A threshold of `0` skips disk probes and logs that the check is disabled. When the container runtime cannot report its image storage path, or `df` cannot read that path, usine logs the skipped storage check at Info and checks the worker root. Cleanup also logs at Info when there are no older worker images to remove.

To change the threshold, set `min_free_disk_gib` on the worker, for example with `usine config edit worker worker-one`:

```yaml
name: worker-one
kind: ssh
destination: usine@203.0.113.20
root: /home/usine/.usine
min_free_disk_gib: 20
```

If one of usine's own commands on the worker, such as an image pull or a checkout, reports `ENOSPC` or `No space left on device` during preflight or attempt preparation, usine reports the same `disk` error. A report from the attempt's agent keeps its own outcome.

After each image pull, usine removes the older images of the attempt image's repository, such as the worker images of earlier releases. It keeps the current image, the newest older image so that a rollback doesn't download it again, and every image that a container uses. The server logs the images it removes; a failed removal is logged and doesn't fail preflight.

Cleanup recognizes Docker Hub names in both qualified and short form. When a mutable tag such as `latest` replaces an image and leaves it untagged, usine adds a local `usine-retained-<image-id>` tag in the same repository. Later pulls include that image in cleanup, so only the current image, the newest older image, and images in use remain. Unrelated untagged images are left alone.

## Gateway

Fields belong to `gateway` on an SSH worker.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `domain` | lowercase domain | required | DNS suffix for `git.<domain>`, `llm.<domain>`, and the forward proxy. |
| `destination` | SSH destination | required | Gateway host for forwarding the admin API. |
| `admin_port` | integer, 1–65535 | `7070` | Admin API port on the gateway's loopback interface. |
| `admin_token_env` | environment variable name | required | Orchestrator variable containing the gateway admin token. |
| `llm_providers` | unique list of `anthropic-messages` or `openai-responses` | `[]` | Wire protocols whose credentials the gateway injects. |

```yaml
gateway:
  domain: gw.internal
  destination: usine-gateway
  admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
  llm_providers: [anthropic-messages, openai-responses]
```

Gateway slots use wire protocols independently of the harness. `anthropic-messages` serves the Anthropic Messages API; `openai-responses` serves the OpenAI Responses API with an API key or a ChatGPT login. Their base paths are `/anthropic-messages` and `/openai-responses/v1` on `llm.<domain>`.

When upgrading a gateway and its orchestrator, replace `anthropic` with `anthropic-messages` and `openai` with `openai-responses` in `gateway.llm_providers`. Upgrade the gateway first, then the orchestrator. For one release, the gateway accepts `/anthropic` and `/openai` as deprecated aliases so running attempts can finish. Preflight accepts provider reports with the previous IDs and refuses gateways without credential reporting with an instruction to upgrade `@usine/gateway`. Imports and saved configurations with the previous IDs decode to the protocol IDs; exports write the protocol IDs. Gateway credential environment-variable names stay the same. Provisioner `api_keys` and Cloudflare provider records use `anthropic` and `openai`.

Each harness descriptor defines its credential environment and configuration files. The executor creates and mounts a separate writable home for a harness that requires one, then removes it when the attempt ends. Codex uses `<root>/workers/<worker>/codex/<attempt>` for both gateway credentials and provisioner API keys. An orderly orchestrator stop or a crash preserves these homes while the attempt checkout remains, allowing saved Codex child threads to resume after restart. Attempt cleanup removes a home only after its checkout is gone. Startup cleanup preserves homes with a live hold or an existing checkout and removes the remaining homes. Claude Code sessions in attempt containers persist in the attempt's Claude project directory while its checkout remains, so they survive container removal; see [Attempt container](#attempt-container).

The gateway stores the real installation token; the attempt receives a caller token. Listed model providers need no worker login. A provider using an API key counts under API keys on the run page; subscription credentials count under the matching plan. A harness without gateway injection uses its worker login through the forward proxy. See [Configure a gateway](/guides/configure-a-gateway/).

A long-lived SSH worker can set `tailnet: { gateway_address: 100.64.0.2 }` alongside `gateway`. The machine joins Tailscale before preflight and uses its existing identity; OAuth variables are not accepted here. Preflight uses passwordless `sudo -n` to configure gateway host entries and gh's systemd HTTP socket, then checks the gateway's missing-caller-token refusal. Install OpenSSH server, systemd, `systemd-socket-proxyd`, and curl first. Containers receive the same gateway host entries, while downloads use direct internet access. Cleanup keeps the machine's tailnet identity. Worker-level `tailnet` is refused with a provisioner; Boat and boxd use `provisioner.tailnet`. See [Home worker on a Mac](/guides/add-an-ssh-worker/#home-worker-on-a-mac).

## Provisioner

Fields belong to `provisioner` on an SSH worker.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `hetzner`, `boat`, or `boxd` | required | Machine provider. |
| `token_env` | environment variable name | required | Orchestrator variable containing the provider API token. |
| `api_keys.anthropic` | environment variable name | omitted | Key delivered as `ANTHROPIC_API_KEY` unless the gateway injects it. |
| `api_keys.openai` | environment variable name | omitted | Key delivered as `OPENAI_API_KEY` unless the gateway injects it. |
| `timings.ssh_wait` | integer seconds, 1–2147483 | `600` | Maximum wait for the endpoint, SSH, and gateway readiness. |
| `timings.creation_backoff_min` | integer seconds, 1–2147483 | `30` | First delay after a creation failure. |
| `timings.creation_backoff_max` | integer seconds, 1–2147483 | `600` | Maximum creation delay, at least the minimum. |
| `timings.machine_check_interval` | integer seconds, 1–2147483 | `86400` | Interval between successful machine checks. |
| `reuse.attempts` | integer, 1–100000 | omitted | Maximum attempts per machine, including the first. Hetzner and Boat only. |
| `reuse.max_age` | duration up to `24d` | omitted | Maximum machine age as a positive integer followed by `s`, `m`, `h`, or `d`. Hetzner and Boat only. |

For example, `reuse: { attempts: 5, max_age: 2h }` keeps a clean machine for up to five attempts or two hours. Both reuse limits are required together. Omit `reuse` to delete the machine after each attempt. A boxd worker ignores `reuse`: boxd restores a machine from its snapshot in under a second, so each attempt gets a new machine. A boxd worker that sets `reuse` loads, and its preflight logs a warning that names the worker.

Preflight checks provider credentials, available machine settings, and credentials for every rostered harness without creating a machine. Machine-dependent checks run on the first machine after startup and at the configured interval. Creation failures retry in the same attempt with exponential backoff; other workers continue. **Workers** shows the reason and next creation time. With `provisioner.tailnet`, a new machine checks that it reaches the gateway up to three times, 13 seconds each, with 3 seconds between tries, before usine deletes the machine. When a check fails during machine creation, such as the gateway check, **Workers** and the desk show the worker's preflight as failed until a machine creation succeeds. That success restores the worker's earlier preflight result, or records the new machine's check if it got one.

Reuse requires containers. Between attempts, usine removes the container, checkout, credentials, and attempt homes, including Claude project directories, and detaches gateway access, retaining the image and shared caches. Cleanup or preflight failure retires the machine. Retained salvage or reattachment prevents reuse. Idle machines retire at the age limit, worker removal, or orderly shutdown; active attempts can finish beyond the age limit. Reconciliation after recovery and every three minutes removes orphan machines. Stop the orchestrator before deleting machines manually.

## Hetzner provisioner

These fields also belong to `provisioner` when `provider` is `hetzner`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `server_type` | string | required | Server type, such as `cx33` or `cax21`. |
| `location` | string | required | Location in the private network's zone, such as `fsn1`. |
| `image` | string | required | Image name, snapshot ID, or description selecting the newest matching snapshot. |
| `ssh_key` | string | required | Hetzner SSH key name for the public key used by the orchestrator. |
| `ssh_user` | Unix user name | `usine` | User authorized by the snapshot. |
| `network` | string | omitted | Private network name, required with a gateway. |
| `firewall` | string | omitted | Firewall attached to created servers. |
| `labels` | map of strings | `{}` | Extra labels whose keys do not start with `usine-`. |

```yaml
provisioner:
  provider: hetzner
  token_env: HCLOUD_TOKEN
  server_type: cx33
  location: fsn1
  image: usine-worker
  ssh_key: usine-worker
  api_keys: { anthropic: USINE_ANTHROPIC_API_KEY }
```

The token needs **Read & Write** access to its Hetzner project. The image must run cloud-init on first boot to apply the pinned SSH host key. Snapshot and server architectures must match. Gateway workers get private addresses and connect through the gateway; other workers get public IPv4 addresses. Recovery uses provider labels for the instance, worker, run, process, and attempt. See [Add a Hetzner worker](/guides/add-a-provisioned-worker/).

## Boat provisioner

These fields also belong to `provisioner` when `provider` is `boat`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `small`, `default`, `large`, or `xlarge` | `default` | Sandbox size offered by the Boat account. |
| `snapshot` | string | omitted | Ready saved snapshot name, required with a gateway. |
| `tailnet.gateway_address` | IPv4 address in `100.64.0.0/10` | required with a gateway | Gateway address reachable through Tailscale. |
| `tailnet.client_id_env` | environment variable name | required with a gateway | Tailscale OAuth client ID variable. |
| `tailnet.client_secret_env` | environment variable name | required with a gateway | Tailscale OAuth secret variable with `auth_keys` write access for `tag:usine-attempt`. |

```yaml
provisioner:
  provider: boat
  token_env: BOAT_API_KEY
  size: default
  api_keys: { anthropic: USINE_ANTHROPIC_API_KEY }
```

Boat requires `identity_file` and its adjacent public key. Gateway settings require both `snapshot` and `tailnet`; `tailnet` is refused without a gateway. Boat supplies the SSH endpoint and host key and offers no region setting. Instances use no account secrets, automatic snapshots, command monitoring, or automatic stop. Without a gateway, tokens and provider keys are readable inside the attempt. With a gateway over Tailscale, package downloads still use Boat's direct internet access. See [Add a Boat worker](/guides/add-a-boat-worker/) and [Connect Boat to a gateway](/guides/connect-boat-to-a-gateway/).

## boxd provisioner

These fields also belong to `provisioner` when `provider` is `boxd`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | lowercase `https://` URL with a host and an optional port from 1 to 65535, without a path; `http://` only for `localhost`, `127.0.0.0/8`, or `[::1]` | `https://boxd.sh:9443` | Account endpoint of the boxd cluster, which serves account calls and `ListRegions`. Set it for a self-hosted or bring-your-own-cloud cluster, for example `https://boxd.example.com:9443`. usine derives the cluster's token exchange URL from it; see [Endpoints and authentication](#boxd-endpoints-and-authentication). |
| `region` | region id | none | Machine and snapshot region: the lowercase id of a region that boxd lists at `endpoint` for your org, as `boxd manage regions` shows. `fra` (Frankfurt) and `nyc` (New York) are the hosted regions. Without it, usine creates machines where `endpoint` runs them: Frankfurt on the hosted service, or the only location of a cluster that runs in one place. Preflight fails if boxd lists no region with this id and an API endpoint for the org, including a region that isn't enabled, and names the ids it lists. It also fails when boxd lists no regions at all, because the cluster runs in one place. |
| `size` | `<vcpu>x<GiB>`, such as `2x8` or `1x32` | omitted | Size that the snapshot must have, as positive whole numbers of vCPUs and GiB of memory. A restore keeps its snapshot's size, so the size only asserts it: preflight fails when the snapshot has another vCPU count or memory size. Omit it to accept the snapshot's size. |
| `snapshot` | lowercase name, 1–63 characters | required | Ready snapshot containing the attempt image. boxd creates machines only from a snapshot that it stores locally; preflight logs a warning that names the storage state of an archived one. |
| `isolated` | boolean | `true` | Excludes the in-machine boxd CLI, integrations, agent logins, and default private network. A machine restored from an isolated snapshot is isolated even when this is false; `infra/boxd/build-snapshot.mjs` builds an isolated snapshot unless you pass `--no-isolated`. |
| `egress` | list of 1–256 host names, `*.` wildcards, public IPv4 addresses, or CIDR ranges with a prefix length of 8 or more, or `[none]` | the snapshot's | Complete egress allowlist for each machine. boxd combines a restore request's list with the snapshot's, so when the new machine reports other entries, usine replaces its list with this one, and deletes the machine if boxd keeps entries that this list doesn't name. boxd admits HTTP and HTTPS by host name and other traffic by address. `none` admits nothing and must be the only entry. Omit the field to keep the snapshot's allowlist: a snapshot from `infra/boxd/build-snapshot.mjs` carries the gateway's checked-in list, and a snapshot without one leaves egress unrestricted. |
| `tailnet.gateway_address` | IPv4 address in `100.64.0.0/10` | required with a gateway | Gateway address reachable through Tailscale. |
| `tailnet.client_id_env` | environment variable name | required with a gateway | Tailscale OAuth client ID variable. |
| `tailnet.client_secret_env` | environment variable name | required with a gateway | OAuth secret variable with `auth_keys` write access for `tag:usine-attempt`. |

```yaml
provisioner:
  provider: boxd
  token_env: BOXD_API_KEY
  region: fra
  snapshot: usine-attempt
  isolated: true
  api_keys: { anthropic: USINE_ANTHROPIC_API_KEY }
```

A boxd worker takes no `identity_file`: usine runs each command on a boxd machine through boxd's gRPC `Exec` API, with the API key as the bearer, so neither the account nor the snapshot needs an SSH key. Each machine is created with SSH off, as boxd recommends for untrusted code. A boxd worker that still sets `identity_file`, as earlier releases required, loads and ignores it, and its preflight logs a warning that names the file. If boxd doesn't answer while the driver connects to the region, the attempt waits and tries again. Auto-hibernate and auto-suspend are disabled on creation. Each attempt gets a new machine, which usine deletes after the attempt; a boxd worker ignores `reuse`, and its preflight warns when it is set. Preflight logs the snapshot's size in `boxd provisioner verified`. A gateway requires `tailnet`; tailnet settings are refused without a gateway. Snapshots retain the attempt image, so rebuild after an upgrade changes the image. See [Add a boxd worker](/guides/add-a-boxd-worker/).

### boxd endpoints and authentication

The driver sends account calls and `ListRegions` over gRPC to `endpoint`. With `region`, it sends machine, snapshot, and `Exec` calls to the API endpoint that `ListRegions` lists for the region, or to `endpoint` when `endpoint` serves that region itself. Without `region`, every call goes to `endpoint`. Allow egress to each endpoint that the worker uses.

Over TLS, or to a loopback address, each call carries the API key as the bearer. When boxd refuses the key as a bearer, the driver exchanges the key for a session over HTTPS and sends every later call with the session. The exchange URL is `https://app.<host>/api/v1/auth/token`, where `<host>` is the host of `endpoint` without its port: `https://app.boxd.sh/api/v1/auth/token` on the hosted service, and `https://app.boxd.example.com/api/v1/auth/token` for `https://boxd.example.com:9443`. For a `localhost`, IP address, or `app.` host, the exchange URL keeps the scheme, host, and port of `endpoint`. Allow egress to the exchange URL too. `Exec` calls carry the same bearer as the other calls: the API key, or the session once boxd refuses the key. Before the first `Exec` call, if no other call has shown which bearer boxd takes, the driver calls `whoami` to find out.

usine sends the API key over plain HTTP only to a loopback address, so `endpoint` accepts `http://` only for `localhost`, `127.0.0.0/8`, and `[::1]`. When boxd lists the worker's region at an `http://` API endpoint on another host, the driver doesn't connect: worker preflight and machine creation fail with a configuration fault that names the endpoint.

A cluster whose certificate comes from a private certificate authority needs that authority in Node.js. Set `NODE_EXTRA_CA_CERTS` to the authority's PEM file in the orchestrator's environment before usine starts. Both the gRPC calls and the token exchange use it.

The driver names each machine `usine-<worker name>-<8 hex digits>`, shortened to 63 characters. boxd may refuse a machine name, for example one that it reserves. When boxd refuses a creation request as invalid, worker preflight fails with boxd's message, which names the machine. Machine creation on the worker pauses for the creation backoff and fails the same way until you rename the worker or correct the provisioner settings.

With `egress`, the driver sends the allowlist in the machine spec of the restore request, so each machine is created with it. Processes that the snapshot resumes can reach hosts outside the list after the restore: in measurements, for up to about 1.2 seconds after the restore request started, and until about 650 milliseconds after boxd answered it. The driver waits one second after boxd answers the restore request before it connects to the machine. boxd refuses an entry it doesn't accept as an invalid creation request. If boxd reports the new machine unrestricted, the driver deletes the machine and retries creation. With a gateway, the list must include `*.tailscale.com`, and must not admit `github.com`, `api.github.com`, or the API and login hosts of a provider in `gateway.llm_providers`: `api.anthropic.com` and `platform.claude.com` for `anthropic-messages`, `api.openai.com`, `chatgpt.com`, and `auth.openai.com` for `openai-responses`. The gateway serves those at `git.<domain>` and `llm.<domain>`. usine refuses the configuration and names the host otherwise. A `*.` entry counts as admitting its domain in this check. Address entries are not checked against the gateway rule; behind a gateway, preflight logs a warning that names them. Like boxd, usine refuses a wildcard other than one leading `*.`, an address or range with host bits set, and one that overlaps a private (RFC 1918), CGNAT, loopback, link-local, multicast, or reserved range. usine also refuses a range with a prefix length under 8. It names the entry and the reason. See [Restrict egress](/guides/add-a-boxd-worker/#restrict-egress).

## Cloudflare connection

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `worker_url` | HTTPS origin | required | Deployed sandbox Worker's origin without a path, credentials, query, or fragment. |
| `access_client_id_env` | environment variable name | required | Access service-token client ID variable. |
| `access_client_secret_env` | environment variable name | required | Access service-token secret variable. |
| `image` | image name | required | Name from the deployed Worker's `containers[].images`. |
| `instance_type` | Cloudflare instance type | `standard-4` | Container capacity: `lite`, `basic`, or `standard-1` through `standard-4`. |
| `llm_providers` | list of provider records | `[]` | Unique `provider` and `api_key_env` pairs for `anthropic` or `openai`. |

```yaml
name: cf-one
kind: cloudflare
worker_url: https://usine-sandboxes.acme.workers.dev
access_client_id_env: USINE_CF_ACCESS_CLIENT_ID
access_client_secret_env: USINE_CF_ACCESS_CLIENT_SECRET
image: usine
llm_providers:
  - provider: anthropic
    api_key_env: ANTHROPIC_API_KEY
```

The sandbox receives placeholder credentials; outbound handlers inject real GitHub tokens and provider keys. Preflight checks Access credentials, image availability, provider keys, and harness versions in a temporary sandbox. Pi children and interactive terminals are unsupported. Placement cannot guarantee EU-only execution. See [Run attempts in Cloudflare sandboxes](/guides/cloudflare-sandboxes/).

SSH and Cloudflare connection revisions apply to new attempts. SSH revisions include `destination`, `identity_file`, `port`, `root`, `gateway`, `tailnet`, `container`, and `provisioner`. Cloudflare revisions include `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type`, and `llm_providers`.

Retained attempts keep their original host or endpoint, credential references, and container settings through reattachment, salvage, and cleanup, including after restart. Preflight checks the revised connection without changing a retained attempt's isolation. Changing a provisioned SSH worker to a fixed destination stops creation retries and clears provisioning pauses; an allocated machine stays assigned to its attempt and its original provider deletes it after cleanup. Keep the original credential variables and SSH keys available until recovery finishes. [Revision application](/reference/configuration/config/#revision-application) lists restart requirements.
