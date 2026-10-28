# Hosted sandboxes and the primitives under them

Research on one sandbox per Attempt for usine. Snapshot date: 2026-10-25. Every source was read on
that date: vendor docs, pricing pages, source repositories, changelogs, and the vendors' engineering
posts. Facts not found are marked "not documented", and cells nobody checked are marked "not
checked". Prices are in the vendor's currency and exclude VAT.

This note complements [`agent-sandboxes.md`](./agent-sandboxes.md) and doesn't repeat it: that note
has the vocabulary, the exe.dev study, the open-source isolation layers, platforms, and credential
proxies, and EU bare-metal prices.

The question changed during the research. It started as "replace the self-hosted SSH Worker with a
hosted sandbox" and became "finish the self-hosted Worker with the primitives the vendors use". The
operator's ranking applies throughout: Hetzner, then Cloudflare, then AWS, and no bare metal, owned
or rented.

## Requirements

- One sandbox per Attempt, alive for minutes to hours.
- An image with Node 22, pnpm, git, gh, Claude Code, and the Codex CLI.
- Long-running stdio children. Claude Code runs under the Claude Agent SDK and Codex as
  `codex app-server` over JSON-RPC (`packages/agents/src/pi/codex/app-server.ts`). Each is one SSH
  command through `RemoteShell` (`packages/agents/src/child-host/child-host.ts`). A sandbox that
  accepts plain OpenSSH fits that child host unchanged. Any other needs a new child host over the
  vendor's exec API, which must stream stdin and let a restarted orchestrator reattach to a running
  process.
- An orchestrator whose public IP changes: token authentication, no IP allowlist.
- Per-Attempt secrets: the one-hour installation token, renewed during the Attempt
  ([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)), and provider API keys,
  ideally held outside the sandbox as the gateway holds them
  ([ADR 0027](../adr/0027-gateway-credential-proxy.md)).
- EU residency preferred, and a known cost per Attempt-hour.

## 1. Hosted providers

Eight providers, plus Boat, which Amp's self-hosted Orbs page lists as a backend
([Orbs](https://ampcode.com/docs/orbs/self-hosted)) and which is hosted only.

### EU placement and legal terms

| Provider | EU compute regions | What leaves the EU | Entity and DPA |
| --- | --- | --- | --- |
| Fly Machines | `ams` Amsterdam, `arn` Stockholm, `cdg` Paris, `fra` Frankfurt; `lhr` London is outside the EU ([regions](https://docs.fly.io/reference/regions)) | control-plane location not documented; sub-processors are almost all US entities ([sub-processors](https://fly.io/legal/sub-processors/)) | Fly.io; a DPA "pre-signed by Fly.io", active once signed ([compliance](https://fly.io/compliance.md)) |
| Daytona | target `eu`; the docs name no city ([regions](https://www.daytona.io/docs/en/regions)); the homepage lists Frankfurt and London ([home](https://www.daytona.io/)) | residency not documented; sub-processors Leaseweb, Latitude.sh, OVHcloud, Stripe, AWS, with no locations ([trust](https://trust.daytona.io/)) | Daytona Platforms Inc., New York; DPA with SCCs, updated 2026-10-13 ([DPA](https://www.daytona.io/dpa)) |
| E2B | `eu-west-1`, which is Google Cloud `europe-west1` ([egress IPs](https://docs.e2b.dev/faq/egress-ip-ranges.md)), in St. Ghislain, Belgium ([GCP zones](https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances)); a separate project, key, and domain, enabled by support ([EU FAQ](https://docs.e2b.dev/faq/eu-region), [migrate](https://docs.e2b.dev/faq/migrate-between-regions.md)) | control plane and metadata: not documented | FoundryLabs, Inc., Delaware; DPA through the trust centre ([FAQ](https://docs.e2b.dev/faq/security-and-compliance)) |
| Modal | `eu` (EEA, price ×1.15), `eu-west`, `eu-north`, `eu-south` (×1.75) ([region selection](https://modal.com/docs/guide/region-selection)) | create and terminate go through the `us-east` control plane; logs, snapshots, Images, Volumes, and Secrets are stored in the US ([data residency](https://modal.com/docs/guide/data-residency)) | DPA on the Trust Center ([security](https://modal.com/docs/guide/security)) |
| Cloudflare | `jurisdiction: "eu"` (EEUR and WEUR) under the `default` scheduling policy only; see [section 2](#2-cloudflare-sandboxes-and-containers) | the Durable Object ID is logged outside the jurisdiction ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)) | DPA: not checked |
| Vercel Sandbox | `fra1` Frankfurt, `cdg1` Paris, `dub1` Dublin, `arn1` Stockholm; `lhr1` London is outside the EU ([regions](https://vercel.com/docs/sandbox/concepts/regions)) | the DPA puts primary processing in the US, under SCCs ([DPA](https://vercel.com/legal/dpa)) | Vercel; DPA effective 2026-03-31 |
| Blaxel | `eu-fra-1` Frankfurt; `eu-lon-1` London is outside the EU; regions may need enabling ([regions](https://docs.blaxel.ai/Infrastructure/Regions)) | not documented | DPA: not found |
| Northflank | `europe-west` (no city), `europe-west-frankfurt`, `europe-west-netherlands`; `europe-west-zurich` is outside the EU ([regions](https://northflank.com/cloud/northflank/regions)) | control plane on Google Cloud London or Amsterdam ([security](https://northflank.com/security)); the terms transfer data "to and processed in the United Kingdom" ([terms](https://northflank.com/legal/terms)) | Northflank Ltd, London; public DPA: not found |
| Boat | Germany, Finland, and France; no region choice ([compliance](https://docs.boat.dev/compliance)) | "Snapshot copies can be stored outside the EU" (same page) | DEDALE AI on bank statements ([plan changes](https://docs.boat.dev/billing/plan-changes)); DPA: not found; SOC 2 "In progress" |

### Isolation, start time, and lifetime

| Provider | Isolation | Start time, vendor figure | Maximum lifetime | Idle policy |
| --- | --- | --- | --- | --- |
| Fly Machines | Firecracker microVM ([architecture](https://docs.fly.io/architecture/)) | create "low double digit seconds"; start a stopped Machine "well under a second" ([overview](https://docs.fly.io/machines/overview)) | not documented; a Machine runs until it exits | proxy autostop only ([autostop](https://docs.fly.io/reference/fly-proxy-autostop-autostart)) |
| Daytona | containers by default, with Sysbox per the Trust Center; a VM class with "its own kernel", hypervisor not named ([isolation](https://www.daytona.io/docs/en/isolation.md), [trust](https://trust.daytona.io/)) | "<90ms" for containers ([sandboxes](https://www.daytona.io/docs/en/sandboxes.md)); VM resume "under a second" ([VM post](https://www.daytona.io/dotfiles/vms-pause-and-fork)) | not stated; `ttl_minutes` destroys a sandbox in any state | auto-stop after 15 min by default, "even if there are internal processes running" (sandboxes page) |
| E2B | Firecracker ([FAQ](https://docs.e2b.dev/faq/security-and-compliance)) | about 80 ms from a template snapshot ([how it works](https://docs.e2b.dev/template/how-it-works)); resume about 1 s ([persistence](https://docs.e2b.dev/sandbox/persistence.md)) | 1 h on Hobby, 24 h on Pro; pause and resume reset it ([lifetime](https://docs.e2b.dev/faq/sandbox-lifetime.md)) | timeout, 5 min by default |
| Modal | gVisor by default; `runtime="vm"` is a KVM VM since SDK 1.6.0 (2026-09-28), VMM not named ([networking](https://modal.com/docs/guide/sandbox-networking), [changelog](https://modal.com/docs/reference/changelog)) | "Sub-second cold-starts" ([product](https://modal.com/products/sandboxes)) | 24 h ([sandboxes](https://modal.com/docs/guide/sandboxes)) | optional `idle_timeout` |
| Cloudflare | Firecracker microVM per instance | 1 to 3 s cold; 648 ms median on the new scheduler | none; hosts restart irregularly | inactivity timeout up to 6 h; processes don't count as activity |
| Vercel Sandbox | Firecracker microVM ([concepts](https://vercel.com/docs/sandbox/concepts)) | "Milliseconds" (same page); 0.41 s warm start from a snapshot ([KB](https://vercel.com/kb/guide/how-to-use-snapshots-for-faster-sandbox-startup)) | 45 min on Hobby, 24 h on Pro, per session; resuming resets it ([pricing](https://vercel.com/docs/sandbox/pricing)) | session timeout only |
| Blaxel | Firecracker fork with a VPP network layer ([blog](https://blaxel.ai/blog/2025-blaxel-our-year-end-round-up)) | resume "under 25 milliseconds" ([overview](https://docs.blaxel.ai/Sandboxes/Overview)) | none by default; 7 and 30 days on tiers 0 and 1 ([expiration](https://docs.blaxel.ai/Sandboxes/Expiration)) | standby about 15 s after the last connection closes, "even if processes are still running" ([KB](https://docs.blaxel.ai/knowledge-base/configuration-and-operation/sandbox-inactivity-with-long-running-processes)) |
| Northflank | Kata Containers with Cloud Hypervisor for CPU sandboxes, gVisor for GPU ([sandboxes](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud), [security](https://northflank.com/security)) | "under a second" ([quickstart](https://northflank.com/docs/v1/application/sandboxes/quickstart)); 0.8 s with a cached image ([product](https://northflank.com/product/sandboxes)) | until deleted; optional `expiryTime` of 300 s to 7 days ([API](https://northflank.com/docs/v1/api/project/services/create-deployment-service.md)) | none automatic |
| Boat | a full VM with its own kernel, VMM not documented ([virtualization](https://docs.boat.dev/machines/virtualization)) | not documented | `--ttl` auto-stop: 1 h by default, 30 days at most, not reset by `exec` or SSH ([CLI](https://docs.boat.dev/cli-reference)) | "boat has no idle timer" ([FAQ](https://docs.boat.dev/faq)) |

### Image and persistence

| Provider | Custom image | Limits that bind | Persistence |
| --- | --- | --- | --- |
| Fly Machines | any registry image, pinned by digest ([warm pools](https://docs.fly.io/blueprints/warm-pool-user-machines)) | suspend works only up to 2 GB of memory ([suspend](https://docs.fly.io/reference/suspend-resume)) | volumes on one host, volume snapshots ([pricing](https://docs.fly.io/about/pricing)) |
| Daytona | registry image or Dockerfile; the VM class takes a registry image only ([snapshots](https://www.daytona.io/docs/en/snapshots.md)) | 4 vCPU, 8 GB RAM, 10 GB disk per sandbox ([sandboxes](https://www.daytona.io/docs/en/sandboxes.md)) | stop and archive; VM pause and fork; FUSE volumes on object storage ([volumes](https://www.daytona.io/docs/en/volumes.md)) |
| E2B | template from a registry image or a Dockerfile without multi-stage builds; CPU and RAM fixed per template ([base image](https://docs.e2b.dev/template/base-image.md), [build](https://docs.e2b.dev/template/build.md)) | Hobby: 8 vCPU, 8 GiB, 10 GiB disk ([billing](https://docs.e2b.dev/billing.md)) | pause keeps memory and disk, with no TTL; snapshots; volumes in private beta ([snapshots](https://docs.e2b.dev/sandbox/snapshots.md)) |
| Modal | `Image.from_registry` or `from_dockerfile`, linux/amd64 ([images](https://modal.com/docs/guide/existing-images)) | not checked | filesystem snapshots with a 30-day TTL by default; memory snapshots in alpha, 7 days ([snapshots](https://modal.com/docs/guide/sandbox-snapshots)) |
| Cloudflare | Dockerfile built by Wrangler; a digest-pinned image in Cloudflare's registry under the `durable_object` policy | 4 vCPU, 12 GiB, 20 GB at most; at least 3 GiB per vCPU | ephemeral disk; root-filesystem snapshots under the `durable_object` policy only |
| Vercel Sandbox | OCI image from Vercel Container Registry; `ENTRYPOINT` and `CMD` don't run; managed `node:22` and `universal` images ([images](https://vercel.com/docs/sandbox/concepts/images)) | Hobby: 4 vCPU, 8 GB; Pro: 8 vCPU, 16 GB ([pricing](https://vercel.com/docs/sandbox/pricing)) | persistent by default: a filesystem snapshot on stop, kept 30 days after last use ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)) |
| Blaxel | Dockerfile that includes the `sandbox-api` binary ([templates](https://docs.blaxel.ai/Sandboxes/Templates)) | writable tmpfs of about half the RAM, so about 4 GB at 8 GB ([overview](https://docs.blaxel.ai/Sandboxes/Overview)) | standby keeps memory and filesystem; manual snapshots in private preview ([fork](https://docs.blaxel.ai/Sandboxes/Fork)) |
| Northflank | any public or private image ([quickstart](https://northflank.com/docs/v1/application/sandboxes/quickstart)) | not checked | volumes outlive the sandbox ([examples](https://northflank.com/docs/v1/application/sandboxes/examples)); pausing "ends any running processes" ([manage](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes)) |
| Boat | none: one Ubuntu 24.04 image on Linux 6.8, and saved snapshots instead ([FAQ](https://docs.boat.dev/faq)); Node 24 by default and Node 22 through nvm, pnpm 10, git, gh, `claude`, `codex`, and `pi` preinstalled ([tools](https://docs.boat.dev/machines/tools)) | sizes `small`, `default` (4 vCPU, 8 GB), `large`, `xlarge` ([billing](https://docs.boat.dev/billing)) | disk saved every minute ([concepts](https://docs.boat.dev/concepts)) and kept 14 days after a stop; memory isn't saved ([FAQ](https://docs.boat.dev/faq)) |

### Exec, reattach, and SSH

| Provider | stdin into a running process | Reattach after the client disconnects | OpenSSH from a changing IP | API authentication |
| --- | --- | --- | --- | --- |
| Fly Machines | no: `exec` returns in one response ([OpenAPI](https://docs.fly.io/api/machines/openapi.json)) | not documented | yes: a WireGuard peer and a `fly ssh issue` certificate; Machines listen on port 22 on the private network ([opensshd](https://docs.fly.io/blueprints/opensshd), [ssh issue](https://docs.fly.io/flyctl/cmd/fly_ssh_issue)) | bearer token; 1 request per second per action per Machine ([Machines API](https://docs.fly.io/machines/api/working-with-machines-api/)) |
| Daytona | yes: session command input and PTY input ([process](https://www.daytona.io/docs/en/process-code-execution.md), [PTY](https://www.daytona.io/docs/en/pty.md)) | PTY by session id; async commands not documented | yes: `ssh <token>@ssh.app.daytona.io` ([SSH](https://www.daytona.io/docs/en/ssh-access.md)) | bearer API key ([API keys](https://www.daytona.io/docs/en/api-keys.md)) |
| E2B | yes: a background command with stdin, `sendStdin` ([streaming](https://docs.e2b.dev/commands/streaming.md)) | yes with `timeoutMs: 0`, through `commands.connect(pid)`; output sent while away reaches only the starting client ([background](https://docs.e2b.dev/commands/background.md)) | only through a websocat `ProxyCommand` ([SSH](https://docs.e2b.dev/sandbox/ssh-access.md)) | API key ([API key](https://docs.e2b.dev/api-key.md)) |
| Modal | yes: `stdin.write` on an exec ([spawn](https://modal.com/docs/guide/sandbox-spawn)) | the sandbox through `from_id`; an exec's streams: not documented ([Sandbox](https://modal.com/docs/sdk/py/latest/Sandbox)) | through an experimental unencrypted TCP tunnel, relayed globally and open to any IP ([forward](https://modal.com/docs/reference/modal.forward), [networking](https://modal.com/docs/guide/sandbox-networking)) | token id and secret ([service users](https://modal.com/docs/guide/service-users)) |
| Cloudflare | yes: `exec` with `stdin: "pipe"` | the process outlives the request; reattaching to its stdin: not documented | `wrangler containers ssh` as a `ProxyCommand` | whatever the operator's Worker implements |
| Vercel Sandbox | yes: `stdin: true` with `detached`, then `writeStdin` ([SDK](https://vercel.com/docs/sandbox/sdk-reference)) | `getCommand(cmdId)` from another process; stdin writes resume at the right offset ([source](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/command.ts)) | no: `sandbox connect` goes through Vercel's API ([CLI](https://vercel.com/docs/sandbox/cli-reference)) | `VERCEL_TOKEN` ([authentication](https://vercel.com/docs/sandbox/concepts/authentication)) |
| Blaxel | yes: `writeStdin` or `POST /process/{id}/stdin`; the pipe survives standby ([processes](https://docs.blaxel.ai/Sandboxes/Processes)) | yes: processes detach by design; `streamLogs` by name ([logs](https://docs.blaxel.ai/Sandboxes/Log-streaming)) | no native SSH; a Tailscale image ([Tailscale](https://docs.blaxel.ai/Tutorials/Tailscale)) | bearer API key ([ports](https://docs.blaxel.ai/Sandboxes/Ports)) |
| Northflank | yes: exec sessions over WebSocket ([exec](https://northflank.com/docs/v1/api/execute-command)) | not documented | through `northflank ssh service --proxyOnly` ([SSH](https://northflank.com/docs/v1/application/run/access-services-with-ssh)) | bearer token; 1,000 requests per hour by default ([API](https://northflank.com/docs/v1/api/use-the-api)) |
| Boat | over SSH, which "streams stdin, stdout and stderr" ([setup](https://docs.boat.dev/setup)); the API's exec has no stdin | detached commands: output streamed by offset, reconnecting every 10 min ([API](https://docs.boat.dev/llms-full.txt)) | yes: `POST /sandboxes/{id}/sshkey`, then `ssh user@<machineIp>` on port 22 ([SSH key](https://docs.boat.dev/api/reference/agent/configure-sandbox-ssh-key)) | bearer API key; 10,000 requests per 60 s per IP ([FAQ](https://docs.boat.dev/faq)) |

### Egress and secrets

| Provider | Per-sandbox egress allowlist | Secrets kept outside the sandbox | Plain per-sandbox environment |
| --- | --- | --- | --- |
| Fly Machines | no: port and protocol rules only, applied on restart ([network policies](https://docs.fly.io/machines/guides-examples/network-policies/)) | no: app-level secrets injected as env ([secrets](https://docs.fly.io/apps/secrets)) | `config.env`, `config.files` |
| Daytona | on Tier 3 (a $500 top-up) and Tier 4 only: a CIDR list (10 at most), a domain list (100 at most), or block all; Tiers 1 and 2 get a fixed list ([network limits](https://www.daytona.io/docs/en/network-limits)) | yes: placeholders swapped in HTTPS headers for listed hosts ([secrets](https://www.daytona.io/docs/en/secrets.md)) | `env_vars` |
| E2B | yes: `allowOut` and `denyOut` by IP, CIDR, or domain, changed live ([internet access](https://docs.e2b.dev/network/internet-access.md)) | yes: header rules filled outside the sandbox; "the proxy fails open" ([inject](https://docs.e2b.dev/secrets/inject.md)) | `envs` |
| Modal | yes: a CIDR allowlist; a domain allowlist in beta ([networking](https://modal.com/docs/guide/sandbox-networking)) | beta: HTTP/1.1 only, not combinable with an allowlist ([secret injection](https://modal.com/docs/guide/sandbox-secret-injection)) | `secrets`, `env` |
| Cloudflare | yes: `allowedHosts`, `deniedHosts`, and per-host handlers, changed live | yes: Worker handlers hold the secret | `start({env})`, `exec({env})` |
| Vercel Sandbox | yes: a deny-by-default domain and CIDR policy, changed live ([firewall](https://vercel.com/docs/sandbox/concepts/firewall)) | yes: header transforms outside the VM, with a per-sandbox CA (same page) | `env` |
| Blaxel | public preview: `allowedDomains`, `forbiddenDomains` ([proxy](https://docs.blaxel.ai/Sandboxes/Proxy)) | yes: `{{SECRET:name}}` through a TLS-intercepting proxy ([injection](https://docs.blaxel.ai/Sandboxes/Proxy-secrets-injection)) | `envs` |
| Northflank | network policies with `egress.allowTo` (IP, CIDR, FQDN) by tag; the guide scopes them to BYOC clusters ([network policies](https://northflank.com/docs/v1/application/network/configure-network-policies)) | `egressSecretInjection` in the API schema; mechanism not documented ([API](https://northflank.com/docs/v1/api/team/network-policies/create-network-policy.md)) | `runtimeEnvironment`, secret groups ([secrets](https://northflank.com/docs/v1/application/secure/inject-secrets)) |
| Boat | no: "boat has no API setting for network rules"; firewall rules inside the VM, lost on resume ([firewall](https://docs.boat.dev/hosting/firewall)) | API keys and Claude or ChatGPT sign-ins through the AI credentials proxy, $1 per day plus $1 per 1,000 requests ([AI credentials](https://docs.boat.dev/ai-credentials), [billing](https://docs.boat.dev/billing); checked 2026-10-28) | account environments with variables and secret files ([FAQ](https://docs.boat.dev/faq)) |

### Price of one 4 vCPU, 8 GB sandbox for one hour

| Provider | vCPU-hour | GB-hour | One hour at 4 vCPU and 8 GB | Also billed |
| --- | --- | --- | --- | --- |
| Boat | flat per size | flat per size | $0.036 (`default`) | a plan from $20 per seat per month, which includes 555 h of `default` ([billing](https://docs.boat.dev/billing)) |
| Northflank | $0.01667 | $0.00833 | 4 × 0.01667 + 8 × 0.00833 = $0.133 | per second; disk $0.11657 per GiB-month ([pricing](https://northflank.com/pricing)) |
| Fly, performance CPU | $0.0458, with 2 GB included | $0.0083 beyond that | $0.183; ×1.0385 in `ams` and `arn` = $0.190; ×1.1346 in `cdg` = $0.208; ×1.1538 in `fra` = $0.212 | from the page's embedded formula: its table renders empty ([pricing](https://docs.fly.io/about/pricing)) |
| Cloudflare | $0.072, active CPU only | $0.009, provisioned | no 8 GB size: `standard-4` (12 GiB) is $0.41 at full CPU, $0.15 at 10% | Workers Paid, $5 per month |
| Daytona | $0.0504 | $0.0162 | 0.2016 + 0.1296 = $0.331 | disk beyond 5 GiB ([pricing](https://www.daytona.io/pricing)) |
| E2B | $0.0504 | $0.0162 | $0.331 | Pro, $150 per month, for runs over 1 h ([pricing](https://e2b.dev/pricing)) |
| Blaxel | not billed | $0.0414 | 8 × 0.0414 = $0.331 | storage ([pricing](https://blaxel.ai/pricing)) |
| Vercel Sandbox, `fra1` | $0.184, active CPU only | $0.0304 | $0.98 at full CPU; $0.32 at 10% | Pro for runs over 45 min ([pricing](https://vercel.com/docs/sandbox/pricing)) |
| Modal, `eu` | $0.0710 × 1.15; a core is 2 vCPU | $0.0240 × 1.15 | 0.476 × 1.15 = $0.547; `eu-west` ×1.75 = $0.833 | egress at $0.04 per GiB past the plan's allowance ([pricing](https://modal.com/pricing)) |

Fly's shared CPUs cost $0.073 per hour at this size in `ams`, with a 6.25% baseline and a burst
balance of up to 500 s ([CPU performance](https://docs.fly.io/machines/cpu-performance)), too little
for builds.

### Open source and the two harnesses

| Provider | Open source | Self-hosting | Claude Code inside | Codex inside |
| --- | --- | --- | --- | --- |
| Fly Machines | flyctl, Apache-2.0 | not documented | no Machines example; Sprites preinstall Claude Code and Codex ([Sprites](https://docs.fly.io/sprites/working-with-sprites)) | same |
| Daytona | v0.190.0 (2026-06-23), AGPL-3.0; the repository is archived ([repo](https://github.com/daytonaio/daytona)) | Compose setup "not safe to use in production" ([docker](https://github.com/daytonaio/daytona/blob/v0.190.0/docker/README.md)) | `ANTHROPIC_API_KEY` with `claude -p` ([guide](https://www.daytona.io/docs/en/claude-code-run-tasks-stream-logs-sandbox/)) | the Codex SDK with a placeholder Secret ([guide](https://daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox)) |
| E2B | `e2b-dev/runtime`, Apache-2.0 | E2B Embed, one node ([section 4](#4-self-host-stacks)) | `claude` template with `ANTHROPIC_API_KEY` ([Claude Code](https://docs.e2b.dev/agents/claude-code.md)) | `codex` template with `CODEX_API_KEY` ([Codex](https://docs.e2b.dev/agents/codex.md)) |
| Modal | clients, Apache-2.0 | no | `ANTHROPIC_API_KEY` from a Secret ([example](https://modal.com/docs/examples/sandbox_agent)) | `CODEX_API_KEY`, in OpenAI's docs ([OpenAI](https://developers.openai.com/api/docs/guides/agents-api/environments/providers/modal)) |
| Cloudflare | `cloudflare/sandbox-sdk` and `cloudflare/containers`, Apache-2.0 | local development only | yes ([section 2](#claude-code-and-codex)) | yes |
| Vercel Sandbox | `vercel/sandbox`, Apache-2.0 | no | `sandbox create claude` ([CLI](https://vercel.com/docs/sandbox/cli-reference)); a Vercel post runs it with `ANTHROPIC_AUTH_TOKEN` ([blog](https://vercel.com/blog/how-we-built-aeo-tracking-for-coding-agents)) | `sandbox create codex`; `codex exec` in the same post |
| Blaxel | `sandbox-api`, MIT | "bring-your-own-server arrangements" through sales ([overview](https://docs.blaxel.ai/Overview)) | interactive login; API-key steps only in a GitHub issue ([tutorial](https://docs.blaxel.ai/Tutorials/Claude-Code)) | `OPENAI_API_KEY` in `envs` ([tutorial](https://docs.blaxel.ai/Tutorials/Codex)) |
| Northflank | clients, MIT | BYOC, and a forward-deployed control plane ([product](https://northflank.com/product/sandboxes)) | `ANTHROPIC_API_KEY` in `runtimeEnvironment` ([examples](https://northflank.com/docs/v1/application/sandboxes/examples)) | Cloud Harness runs Codex with an API key ([quickstart](https://northflank.com/docs/v1/application/cloud-harness/quickstart)) |
| Boat | no repository | no | preinstalled; "Claude Code prefers these variables to a sign-in" ([AI credentials](https://docs.boat.dev/ai-credentials)) | preinstalled |

### Conflicts between vendor pages

- **E2B, pricing page against docs.** The pricing page gives a 2 vCPU and 4 GiB default and a 1 to 8
  vCPU range; the docs give 1,024 MiB and list Pro as "8+"
  ([pricing](https://e2b.dev/pricing), [build](https://docs.e2b.dev/template/build.md),
  [billing](https://docs.e2b.dev/billing.md)).
- **Vercel, pricing table against regional data.** The table includes transfer in Pro's flat rate,
  while each region's data gives $0.15 per GB. A changelog says "all 20 Vercel compute regions"; the
  regions and pricing pages list 19. The concepts page says sandboxes "do not persist data
  long-term", while the persistence pages make them persistent by default.
- **Fly Sprites, pricing page against overview.** Billed "hourly" on the pricing page and "by the
  second" in the overview.
- **Fly creation time.** "Milliseconds" in one blueprint, "low double digit seconds" in the overview,
  and "a minute or more" with an app and a volume in another blueprint.
- **Daytona.** No city for `eu` in the docs, Frankfurt and London on the homepage. The homepage says
  "No shared compute"; an April 2026 advisory describes runners hosting more than one tenant
  ([advisory](https://www.daytona.io/dotfiles/updates/security-update-cve-2026-31431-copy-fail)).
  The limits page gives Tier 1 memory as 10 GiB in one table and 20 GiB in another
  ([limits](https://www.daytona.io/docs/en/limits.md)).
- **Northflank.** The network-policy guide scopes egress rules to BYOC; the product page offers FQDN
  egress and egress secret injection with no caveat. The product page lists bare metal for BYOC; the
  BYOC docs don't.
- **Cloudflare.** The placement page offers `jurisdiction: "eu"`; the Wrangler reference rejects it
  under the `durable_object` policy. The security page says a container starts with
  `enableInternet: false`; the outbound page says the Container class allows internet access by
  default.
- **Blaxel.** A 16 GB sandbox has 6 cores on two pages and 8 on a third.

## 2. Cloudflare Sandboxes and Containers

### Lifecycle owner

Each container instance belongs to one Durable Object, reached by name, which starts it with
`ctx.container.start()` ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)).
The Sandbox SDK 1.0 (`@cloudflare/sandbox`, Apache-2.0) is a helper library inside that Durable
Object: "The package does not start, stop, or monitor the container"
([reference](https://developers.cloudflare.com/sandbox/reference/)). Cloudflare hosts no sandbox
API. The operator deploys a Worker, and the orchestrator calls it; the 0.x bridge Worker "is not a
Cloudflare-hosted shared API" ([bridge](https://developers.cloudflare.com/sandbox/sdk/bridge/)).

Two scheduling policies exist
([scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)):

| | `default` | `durable_object` |
| --- | --- | --- |
| SDK | Sandbox SDK 0.x, built on the Container class; fixes until 2026-12-31, no new features ([migrate](https://developers.cloudflare.com/sandbox/sdk/migrate/)) | Sandbox SDK 1.0; the move "cannot be undone … even after `wrangler rollback`" (same page) |
| Status | GA | public beta ([sandbox](https://developers.cloudflare.com/sandbox/)) |
| Placement | `constraints`, including `jurisdiction: "eu"` | rejected: "Wrangler rejects every other Container application field for this policy, including … placement constraints" ([Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/)) |
| Image and size | one `image` and one `instance_type` per container application | per instance |
| Snapshots | none | `snapshotContainer()`, root filesystem only, beta ([snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)) |
| Start, ComputeSDK benchmark median | 4.049 s | 648 ms ([faster sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)) |
| Deploys | a container change starts a rollout: SIGTERM, up to 15 min, SIGKILL, fresh disk ([rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/)) | "A running instance keeps running" ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)) |

No timeline for placement under the `durable_object` policy appears in the 2026-09-30 changelog
entry or the rebuild post
([changelog](https://developers.cloudflare.com/changelog/post/2026-09-30-durable-object-scheduling-policy/)).
Whether SDK 1.0 runs under the `default` policy is not documented.

### Isolation

"Each container instance runs in a Firecracker microVM with its own kernel and network. No other
workload on the Cloudflare network shares that kernel"; images must be linux/amd64
([architecture](https://developers.cloudflare.com/containers/concepts/architecture/)). The hosts are
multi-tenant. A cross-tenant data leak through a shared storage block pool was reported on
2026-09-04 and fixed fleet-wide by 2026-09-07
([incident post](https://blog.cloudflare.com/containers-cross-tenant-vulnerability/)).

### EU placement guarantees

- `jurisdiction: "eu"` restricts containers "to compliance boundaries", mapped to the EEUR and WEUR
  regions; `regions` limits placement "to specific geographic areas". Both are constraints, not hints
  ([placement](https://developers.cloudflare.com/containers/concepts/placement/),
  [changelog](https://developers.cloudflare.com/changelog/post/2026-04-05-regional-placement/)).
- Which countries EEUR and WEUR contain, and so whether London or Zurich can host an instance: not
  documented.
- Where images are stored and pulled from under the EU jurisdiction: not documented. Images are in
  `registry.cloudflare.com` and distributed "across its network"
  ([architecture](https://developers.cloudflare.com/containers/concepts/architecture/)).
- Logs: Workers Logs, kept seven days ([FAQ](https://developers.cloudflare.com/containers/faq/)).
  The Data Localization Suite table has no Containers row, and for Durable Objects notes "Logs /
  Analytics not available outside US region"
  ([compatibility](https://developers.cloudflare.com/data-localization/compatibility/)).
- A Durable Object created with `env.NS.jurisdiction("eu")` runs and stores data only in that region,
  but its ID "will be logged outside of the specified jurisdiction"; location hints are "best effort"
  ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
- An EU Durable Object with an EU `default`-policy container isn't documented as a combination, and a
  container "may start in a different location than its Durable Object"
  ([architecture](https://developers.cloudflare.com/containers/concepts/architecture/)).

So EU placement today means SDK 0.x or the Container class under the `default` policy: one image and
size per application, no snapshots, a 4 s start, and rollouts that replace running instances.

### Instance sizes and cost per Attempt-hour

| Type | vCPU | Memory | Disk |
| --- | --- | --- | --- |
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

Custom sizes reach 4 vCPU, 12 GiB, and 20 GB, with at least 3 GiB per vCPU, so no 4 vCPU, 8 GB size
exists. Account defaults allow 1,500 vCPU, 6 TiB of memory, and 30 TB of disk at once, about 375
`standard-4` instances ([limits](https://developers.cloudflare.com/containers/platform/limits/)).

Memory and disk are billed while provisioned and CPU only while active: $0.000020 per vCPU-second,
$0.0000025 per GiB-second, $0.00000007 per GB-second
([pricing](https://developers.cloudflare.com/containers/platform/pricing/)), plus Durable Object
duration at $12.50 per million GB-seconds on 128 MB, $0.0056 per hour
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Before the
monthly allowances:

| Size | Memory | Disk | CPU at 100% | Total at 100% | At 25% | At 10% |
| --- | --- | --- | --- | --- | --- | --- |
| `standard-4` | 12 × 3600 × 2.5e-6 = $0.108 | $0.005 | 4 × 3600 × 2e-5 = $0.288 | $0.407 | $0.191 | $0.147 |
| `standard-3` | $0.072 | $0.004 | $0.144 | $0.226 | $0.118 | $0.096 |
| `standard-2` | $0.054 | $0.003 | $0.072 | $0.135 | $0.081 | $0.070 |

Polling every 5 s adds about $0.0003 per hour in Worker and Durable Object requests. A WebSocket held
with `accept()` bills Durable Object duration while connected. Workers Paid costs $5 per month
([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

### Lifetime

- No fixed maximum runtime, and no guarantee that "any container instance will run for a set period".
  Hosts restart on an irregular cadence: SIGTERM, up to 15 minutes, SIGKILL, and a new instance may
  start elsewhere. An out-of-memory kill restarts the instance; there is no swap
  ([FAQ](https://developers.cloudflare.com/containers/faq/)).
- The inactivity timeout goes up to 6 hours, and "Code that runs inside the instance does not count
  as activity", so a running Attempt needs a Durable Object alarm or requests to stay alive
  ([DO Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
  [lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)). The Container class
  sets `sleepAfter` to 10 minutes by default.

### Egress and credentials

- Per instance: `enableInternet: false`, `allowedHosts` and `deniedHosts` with globs, and
  `outbound`/`outboundByHost` handlers, changed at runtime with `setOutboundByHost()`,
  `removeOutboundByHost()`, and `setAllowedHosts()`. Handlers run in the Worker, "outside the
  container sandbox — they can hold secrets that the container itself never sees", and scope to one
  instance with `ctx.containerId`
  ([outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)).
  This is ADR 0027's attach and detach as a platform feature.
- Under the DO Container API, "You cannot remove an intercept while the container runs"; registering
  a target again replaces its handler without dropping connections. The limit is 128 entries
  ([DO Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)).
- HTTPS interception needs the container to trust an ephemeral CA at
  `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Cloudflare's coding-agent runner sets
  `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, and `SSL_CERT_FILE` for Claude Code and
  Codex ([runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/)).
  Codex reads `CODEX_CA_CERTIFICATE`, then `SSL_CERT_FILE`
  ([source](https://github.com/openai/codex/blob/main/codex-rs/http-client/src/custom_ca.rs)).
- Plain HTTP avoids the CA: with the internet off, an intercepted hostname resolves to a placeholder
  address, and "Calls to `http://my.worker` from the container invoke the handler", which must fetch
  upstream over HTTPS itself
  ([security](https://developers.cloudflare.com/sandbox/concepts/security/)). git, Claude Code
  (`ANTHROPIC_BASE_URL`), and Codex (a custom `model_provider`) can use that path; gh insists on
  HTTPS.

### Orchestrator access

- The orchestrator calls the operator's Worker over HTTPS, authenticated however the Worker decides,
  for example Cloudflare Access service tokens
  ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).
  Nothing depends on the caller's IP.
- `exec()` takes `stdin: "pipe"` and returns writable `stdin`, readable `stdout` and `stderr`, and a
  `pid` ([DO Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)).
  The handle "belongs to the request that started it"; later requests manage the process through
  `setsid` and pid, log, and exit-code files
  ([background processes](https://developers.cloudflare.com/sandbox/commands/run-background-processes/)).
- A WebSocket path from an external client into a process is documented only as a browser terminal:
  the Durable Object accepts a `WebSocketPair` and runs `tmux` under a PTY, and "The shell keeps
  running when the page reloads or the connection drops"
  ([terminal](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)).
  A non-PTY pipe fed from an external WebSocket, and reattaching to one, are not documented.
- `wrangler containers ssh` works as an OpenSSH `ProxyCommand` with the Cloudflare account's
  credentials and ed25519 keys, but "An active SSH connection alone will not keep a Container alive"
  ([SSH](https://developers.cloudflare.com/containers/guides/ssh/)).

### Claude Code and Codex

Cloudflare documents both. Claude Code runs as `claude --print --output-format stream-json`, with
`ANTHROPIC_BASE_URL` pointing at AI Gateway and a placeholder `ANTHROPIC_API_KEY`; the Worker adds
the real credential
([Claude Code](https://developers.cloudflare.com/sandbox/coding-agents/claude-code/)). Codex runs as
`codex exec --json` with a custom `model_provider`
([Codex](https://developers.cloudflare.com/sandbox/coding-agents/codex/),
[examples](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/coding-agents)).

### Fit for usine

Cloudflare has the best credential model of the hosted set, with per-instance handlers outside the
VM, and costs $0.15 to $0.41 per Attempt-hour at `standard-4`. Three things count against it today:
the EU jurisdiction is unavailable with the Sandbox SDK 1.0; a child needs an alarm to stay alive
and a reattach mechanism of usine's own; and usine would ship and deploy a Worker as its sandbox API.

## 3. Vendor infrastructure

| Vendor | VMM or runtime | Hardware or cloud underneath | Sources |
| --- | --- | --- | --- |
| exe.dev | Cloud Hypervisor on KVM | mostly bare metal at Latitude.sh | [`agent-sandboxes.md`](./agent-sandboxes.md), section 1 |
| E2B | Firecracker | Google Cloud; AWS for US West; machine types and nested virtualization not documented | [security](https://e2b.dev/security), [FAQ](https://docs.e2b.dev/faq/security-and-compliance) |
| Daytona | Sysbox containers; the VM class's hypervisor not named | "runs directly on bare metal with a proprietary scheduler"; sub-processors Leaseweb, Latitude.sh, OVHcloud, AWS | [trust](https://trust.daytona.io/), [case study](https://www.daytona.io/customers/trajectory) |
| Modal | gVisor (`runsc`) by default; a KVM VM with an unnamed VMM for `runtime="vm"` | AWS, GCP, and OCI (`cloud` parameter); bare metal or VMs not documented | [GPU post](https://modal.com/blog/truly-serverless-gpus), [App reference](https://modal.com/docs/sdk/py/latest/App) |
| Vercel Sandbox | Firecracker in Hive, Vercel's build platform | "metal instances with NVMe disks"; snapshots in S3; region codes map to AWS regions, though AWS isn't named for Hive | [snapshots post](https://vercel.com/blog/optimizing-vercel-sandbox-snapshots), [Hive post](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure) |
| Cloudflare | Firecracker per container instance | Cloudflare's network; the scheduler is "built on Cloudflare Workers, Durable Objects, and KV", with one scheduler per location; ownership of the hosts not stated | [incident post](https://blog.cloudflare.com/containers-cross-tenant-vulnerability/), [platform post](https://blog.cloudflare.com/container-platform-preview/) |
| Blaxel | forked Firecracker with VPP networking, on "a custom micro-VM orchestration and deployment stack on top of Kubernetes" | not documented | [year-end post](https://blaxel.ai/blog/2025-blaxel-our-year-end-round-up) |
| Northflank | Kata Containers with Cloud Hypervisor; gVisor where nested virtualization is missing | Google Cloud VMs with nested virtualization, "over 2 million microVMs per month"; BYOC on GKE, EKS, AKS, and others | [isolation post](https://northflank.com/blog/your-containers-arent-isolated-heres-why-thats-a-problem-micro-vms-vmms-and-container-isolation), [BYOC](https://northflank.com/docs/v1/application/bring-your-own-cloud/use-other-cloud-providers-with-northflank) |
| Fly | Firecracker, booted by the `flyd` orchestrator, with containerd devmapper on LVM thin pools | "dedicated physical servers with 8-32 physical CPU cores"; hosting providers CacheNetworks, DataPacket, Latitude, NetActuate, and Vultr | [stack](https://docs.fly.io/hiring/stack), [architecture](https://docs.fly.io/architecture/), [sub-processors](https://fly.io/legal/sub-processors/) |
| Boat | not documented | dedicated AMD Ryzen 9 9950X hosts with `/dev/kvm` passed through; when full, Hetzner Cloud VMs without KVM, about 3x slower for CPU-heavy work | [virtualization](https://docs.boat.dev/machines/virtualization) |

Five of the ten use Firecracker. Cloud Hypervisor appears twice, directly at exe.dev and through Kata
at Northflank. exe.dev, Fly, and Daytona name rented hosting providers, and Vercel runs on "metal
instances". Northflank shows that microVMs on nested-virtualization cloud VMs work at scale.

## 4. Self-host stacks

Open-source orchestrators that run many sandboxes behind an API, plus Amp's provider program.

| Stack | Licence | Hardware | API | Multi-node | Maturity |
| --- | --- | --- | --- | --- | --- |
| Amp self-hosted Orbs | proprietary CLI: "© Sourcegraph Inc. All rights reserved" (`@sourcegraph/amp` LICENSE.md) | any backend: Docker, Kubernetes, E2B, Modal, Vercel, Daytona, exe.dev, Boat | Amp's control plane sends spawn, pause, and delete jobs over an outbound HTTPS connection; each job runs a dispatch program with `ORB_*` variables, idempotent, within five minutes ([Orbs](https://ampcode.com/docs/orbs/self-hosted)) | per backend | no standalone mode: unusable without Amp |
| E2B Embed (`e2b-dev/runtime`; `e2b-dev/infra` redirects to it) | Apache-2.0 | x86-64 or arm64 with `/dev/kvm`, "bare metal, or a VM created with nested virtualization"; Ubuntu 24.04, kernel 6.8 or newer, cgroup v2, Docker 27, 2 MiB hugepages for sandbox memory ([compose](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)) | `envd`: processes, PTYs, files, watchers, port forwarding over Connect RPC and REST, the E2B SDK; per-sandbox nftables and SNI/Host domain lists; secret injection is enterprise only ([architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)) | one node "by design"; "Private cloud, in development" ([Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md)) | 2026.30 (2026-09-10), pushed 2026-10-25 |
| CubeSandbox | Apache-2.0 | CubeHypervisor, a Cloud Hypervisor fork; multi-node compute nodes must be a "Physical machine or bare-metal server (nested virtualization is not supported)" ([multi-node](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/multi-node-deploy.md)); a PVM mode runs on "an ordinary cloud server" with Tencent's PVM host kernel ([PVM](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/pvm-deploy.md)) | E2B-compatible, with E2B's `envd`; L7 egress and credential injection | control node with MySQL, Redis, MinIO plus Cubelet nodes | v0.7.3 (2026-10-12), created 2026-04 |
| OpenSandbox, Firecracker mode | Apache-2.0 | bare metal or nested virtualization, kernel 5.10 or newer, XFS with reflink ([Firecracker](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/firecracker.md)) | stdin streaming not documented | through the separate `fast-sandbox` platform on Kubernetes, 52 stars, no releases ([fast-sandbox](https://github.com/opensandbox-group/fast-sandbox)) | 1.1.1 (2026-10-09) |
| Kata Containers with Cloud Hypervisor, under `kubernetes-sigs/agent-sandbox` | Apache-2.0 | Kubernetes nodes with `/dev/kvm`, including nested-virtualization cloud VMs ([hypervisors](https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md)) | Kubernetes exec; warm pools and claims; L3/L4 NetworkPolicy egress; no memory snapshot ([agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)) | yes | Kata 4.3.1 (2026-10-21), agent-sandbox v1.0.8 (2026-10-22) |
| Flintlock, with Brigade | MPL-2.0; Brigade Apache-2.0 | Firecracker or Cloud Hypervisor on a host with KVM | gRPC and HTTP create and delete; exec, snapshots, SSH not documented ([flintlock](https://github.com/liquidmetal-dev/flintlock)) | Brigade, 2 stars ([brigade](https://github.com/liquidmetal-dev/brigade)) | building block |
| firecracker-containerd | Apache-2.0 | KVM | a containerd runtime, not a sandbox API; "multi-tenant use cases are at the user's own risk" ([repo](https://github.com/firecracker-microvm/firecracker-containerd)) | no | no releases |
| Ubicloud | AGPL-3.0 | "cloudifies bare metal instances leased from Hetzner" ([README](https://github.com/ubicloud/ubicloud/blob/main/README.md)) | VMs with SSH, REST API; block storage is now `ubiblk`, no longer SPDK | yes | no releases |
| Daytona v0.190.0 | AGPL-3.0 | privileged Docker containers ([runner](https://github.com/daytonaio/daytona/blob/v0.190.0/apps/runner/pkg/docker/container_configs.go)) | toolbox API, SSH gateway | Compose "not safe to use in production" | archived |

Under the no-bare-metal rule, Ubicloud and CubeSandbox's multi-node mode drop out, and Daytona and
firecracker-containerd were never candidates. E2B Embed's AWS Terraform module defaults to
`m8i.xlarge` with nested virtualization and says it "was validated on m8i.xlarge"
([variables.tf](https://github.com/e2b-dev/runtime/blob/main/embed/terraform/aws/variables.tf)). Its
GCP module uses `n4-standard-4` with nested virtualization
([variables.tf](https://github.com/e2b-dev/runtime/blob/main/embed/terraform/gcp/variables.tf)). An
open issue reports a dead guest network after snapshot resume on a nested GCE instance
([#3745](https://github.com/e2b-dev/runtime/issues/3745)).

## 5. EU compute with KVM

### Hetzner

- Cloud servers have no nested virtualization: "No, this is not possible on cloud server"
  ([FAQ](https://docs.hetzner.com/cloud/servers/faq/)).
- Hetzner Cloud added no container, Kubernetes, or sandbox product in 2026: the changelog has none
  ([changelog](https://docs.hetzner.cloud/changelog)), and the Cloud page lists servers, networks,
  firewalls, load balancers, volumes, object storage, and one-click apps such as Docker CE and
  Coolify, with Kubernetes only as something to run yourself ([Cloud](https://www.hetzner.com/cloud/)).
- Per-Attempt isolation without nested virtualization is therefore one Cloud server per Attempt,
  separated by Hetzner's hypervisor: CX33 (4 shared vCPU, 8 GB) at €0.0144 per hour
  ([Cost-Optimized](https://www.hetzner.com/cloud/cost-optimized/)), CPX32 (4 vCPU, 8 GB) at €0.0577
  ([Regular Performance](https://www.hetzner.com/cloud/regular-performance/)). Every started hour is
  billed in full, and a server is billed while it exists
  ([billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)). On 2026-10-25 every Cost-Optimized and
  Regular Performance plan showed "This product is currently unavailable"; General Purpose (dedicated
  vCPU) starts at €43.49 per month. Server creation time: not documented.
- Dedicated AX servers are rented bare metal, which the operator refuses. For reference: AX42 at
  €99.00 per month or €0.1586 per hour plus €49 setup
  ([AX42](https://www.hetzner.com/dedicated-rootserver/ax42/)); AX102 at €259.00 or €0.4150 plus €129
  ([AX102](https://www.hetzner.com/dedicated-rootserver/ax102/)). The price-adjustment table lists
  €97.30 and €257.30 without the IPv4 address
  ([price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)).

### AWS

- Nested virtualization on virtual instances: C8i, M8i, and R8i since 2026-02-16
  ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual));
  C7i, M7i, R7i, the -flex and -id variants, I7i, and X8i since 2026-06-18
  ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/06/nested-virtualization-intel-us-gov-cloud/));
  all commercial regions. KVM and Hyper-V are the supported L1 hypervisors, it costs nothing extra,
  and it's enabled with `--cpu-options "NestedVirtualization=enabled"`. AWS recommends bare metal for
  "performance sensitive" work ([user guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)).
  Graviton has none (E2B's `variables.tf` above).
- Firecracker's tested platforms are all `.metal` instances, and the README says nothing about nested
  virtualization ([README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)).
- On-demand Linux prices, from the data behind the
  [EC2 pricing page](https://aws.amazon.com/ec2/pricing/on-demand/), published 2026-10-23:

  | Instance | vCPU | GiB | eu-central-1 Frankfurt | eu-west-3 Paris | eu-north-1 Stockholm |
  | --- | --- | --- | --- | --- | --- |
  | `c7i.xlarge` | 4 | 8 | $0.2037 | $0.2121 | $0.1911 |
  | `m8i.xlarge` | 4 | 16 | $0.2536 | $0.2470 | not listed |
  | `m7i.8xlarge` | 32 | 128 | $1.9320 | $1.8816 | $1.7136 |
  | `m8i.8xlarge` | 32 | 128 | $2.0286 | $1.9757 | not listed |
  | `r7i.8xlarge` | 32 | 256 | $2.5536 | $2.4864 | $2.2512 |

- Metal, for reference: the cheapest x86 metal in eu-central-1 is `c5.metal` (96 vCPU, 192 GiB) at
  $4.656 per hour; `c7i.metal-24xl` is $4.889.

### GCP, the self-hosted Firecracker path

- Nested virtualization supports KVM only and excludes E2, memory-optimized, Arm, and AMD machines
  except N4D. Nested VMs can lose 10% or more on CPU-bound work and more on I/O
  ([overview](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)).
  The `compute.disableNestedVirtualization` constraint "is not enforced by default"
  ([constraint](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/managing-constraint)),
  and a VM enables it with `--enable-nested-virtualization`
  ([enabling](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/enabling)).
- Per-zone machine-series availability in europe-west regions: not captured. Bare-metal C3, C4, and
  Z3 machines are offered in europe-west1, europe-west3, europe-west4, and europe-west8
  ([bare metal](https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances)).
- Prices: not captured; the pricing page renders its tables in the browser.

### Other rented bare metal

Refused by the operator, listed for completeness: Scaleway Elastic Metal bills hourly from €0.11
(EM-A610R-NVMe), with no commitment fee for hourly billing
([Elastic Metal](https://www.scaleway.com/en/pricing/elastic-metal/)); OVHcloud Rise starts at
€56.99 per month, with the visible models marked "Soon available"
([Rise](https://eco.ovhcloud.com/en-ie/rise/)).

## 6. Shortlists

Costs are per Attempt-hour for 4 vCPU and 8 GB.

### Path (a): hosted, cheapest with EU compute

1. **Boat, $0.036.** EU-only machines (Germany, Finland, France), a full VM per sandbox, and plain
   OpenSSH, so `RemoteShell`, pid files, salvage, and ADR 0026's token file work as on the SSH
   Worker today. Node 22, pnpm, git, gh, Claude Code, and Codex are preinstalled. Trade-off: no
   network rules, so no gateway posture. The token is on the VM as in ADR 0026 stage 1, and egress
   control is an in-VM firewall that root can undo, applied again after every resume. Also: no custom
   image, snapshot copies that may leave the EU, fallback machines on Hetzner Cloud without KVM and
   about 3x slower on CPU-heavy work, no DPA found, and SOC 2 in progress.
2. **Northflank, $0.133.** Frankfurt or the Netherlands, Kata with Cloud Hypervisor, bidirectional
   exec, OpenSSH through the CLI proxy, and egress rules with secret injection in the API. Trade-off:
   a UK company whose terms process data in the UK, a control plane on Google Cloud London or
   Amsterdam, egress policies documented for BYOC, reattach not documented, and 1,000 API requests
   per hour by default.

Cloudflare, the operator's second choice, costs $0.15 to $0.41 and has the best credential model,
but its EU jurisdiction excludes the Sandbox SDK 1.0 ([section 2](#fit-for-usine)). Fly Machines
($0.19 in `ams`) also takes plain OpenSSH, over WireGuard, but its egress rules cover only ports and
protocols.

### Path (b): self-hosted, one microVM per Attempt in the EU, no bare metal

1. **E2B Embed on AWS nested virtualization.** Apache-2.0 Firecracker with `envd` (processes with
   stdin, PTYs, files), per-sandbox domain egress lists, and the E2B SDK, so E2B Cloud's `eu-west-1`
   is a fallback by URL. The Terraform module targets `m8i` instances with nested virtualization. On
   one `m8i.8xlarge` in Frankfurt ($2.0286 per hour), 7 Attempts without CPU overcommit cost $0.29
   each, and 14 (memory-bound at 8 GB each, CPU overcommitted 1.75 times) cost $0.145, before EBS
   and data transfer. Trade-off: one node by
   design, so usine places Attempts across independent hosts; Firecracker isn't tested under nested
   virtualization; secret injection is enterprise only, so ADR 0027's gateway stays; a new child host
   over `envd` replaces `RemoteShell`; and it costs more per Attempt-hour than Boat or Northflank.
2. **Kata with Cloud Hypervisor under `agent-sandbox`, on EKS nodes with nested virtualization.** The
   combination Northflank runs in production on Google Cloud. Trade-off: usine operates Kubernetes,
   exec goes through the Kubernetes API, egress is L3/L4 only, and there's no memory snapshot.

Hetzner, the operator's first choice, has no microVM path without rented bare metal. CubeSandbox's
PVM mode is the only documented way to run microVMs on an ordinary cloud server, and it needs
Tencent's host kernel. One Hetzner Cloud server per Attempt gives a hypervisor boundary per Attempt
for €0.0144 to €0.0577 per hour with today's SSH Worker and gateway unchanged, but the plans were
out of stock on 2026-10-25 and every started hour is billed.

## Facts most likely to change the decision

1. AWS nested virtualization on virtual C7i, M7i, C8i, and M8i instances (2026) gives `/dev/kvm`
   without bare metal, and E2B Embed's AWS module is validated on it. Firecracker itself still lists
   only `.metal` hosts as tested.
2. Boat sells an EU-only VM with plain OpenSSH and both harnesses for $0.036 per hour, a quarter of
   Northflank's price and a tenth of Daytona's, E2B's, or Blaxel's, but with no egress controls.
3. Cloudflare's EU jurisdiction works only under the `default` scheduling policy: SDK 0.x, whose
   fixes end on 2026-12-31, or the bare Container class. The Sandbox SDK 1.0 can't use it, and no
   timeline exists for placement under the `durable_object` policy. Placement there would make
   Cloudflare the strongest hosted fit.
