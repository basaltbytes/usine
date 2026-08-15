# Prior art: exe.dev as a remote worker target

Research for [issue #3](https://github.com/basaltbytes/usine/issues/3). All claims cite exe.dev's own
site, docs, or public repos (primary sources only). Snapshot taken 2026-08-15; exe.dev is a young,
fast-moving product ([release notes](https://exe.dev/docs/release-notes)), so re-verify before building.

A useful meta-fact for usine itself: every exe.dev docs page is also served as plain Markdown by
appending `.md` (e.g. `https://exe.dev/docs/api.md`), and the whole docs index is at
`https://exe.dev/docs.md` / `https://exe.dev/llms.txt` — designed for "progressive discovery" by
coding agents ([agent skill doc](https://exe.dev/docs/agent-skill)).

## What exe.dev is

exe.dev (by Bold Software; public repo and issue tracker at
[github.com/boldsoftware/exe.dev](https://github.com/boldsoftware/exe.dev)) is a subscription service
for Linux VMs with persistent disks, "immediately accessible over HTTPS," where "your VMs share
CPU/RAM—you pay for underlying resources, not per VM"
([What is exe.dev?](https://exe.dev/docs/what-is-exe)). Under the hood each VM runs on bare metal
under Cloud Hypervisor; a VM boots from a container image (default `exeuntu`) attached to a block
device, which "makes creating a new VM take about two seconds." VMs get no public IP; exe.dev
terminates HTTPS/TLS and proxies to the VM, and handles SSH routing for `ssh vmname.exe.xyz`
([How does exe.dev work?](https://exe.dev/docs/faq/how-exedev-works)). The Sandbox product page
pitches exactly usine's use case: "real Linux boxes" with "Real isolation. KVM virtual machines, not
shared kernels," persistent disks, for AI agents that "pick up where [they] left off"
([/sandbox](https://exe.dev/sandbox)). The editorial position is explicit: "exe.dev is a great place
to run a coding agent securely, with minimal supervision. Each exe.dev VM has little access to your
data … so there's very little to exfiltrate" ([Put your agent in a VM](https://exe.dev/docs/boxes)).

## API

**The API is SSH.** "The exe.dev API is SSH. Run commands like `ssh exe.dev ls --json` or
`ssh exe.dev new --json` directly from scripts and automation" ([API](https://exe.dev/docs/api)).
There are two SSH destinations: `ssh exe.dev <command>` (the "lobby" — lifecycle/control-plane
commands) and `ssh <vm>.exe.xyz` (a full shell on a VM: exec, scp, sftp, port forwarding)
([agent skill](https://github.com/boldsoftware/exe.dev/blob/main/skill/SKILL.md)). Every lobby
command takes `--json`, and `--help` on any command returns its flags as JSON without side effects
([HTTPS API FAQ](https://exe.dev/docs/https-api)). `ls --json` returns per-VM
`{https_url, region, ssh_dest, ssh_host, ssh_user, status, vm_name}` ([API](https://exe.dev/docs/api)).

**HTTPS API = the same commands over POST.** "The exe.dev HTTPS API is nothing but the SSH API
shoved into a POST body": `POST https://exe.dev/exec` with the command as body, bearer-token auth,
JSON output always on. Hard limits: **no stdin, no pty, 30-second timeout (504), 64KB body,
per-SSH-key rate limiting (429)** ([HTTPS API](https://exe.dev/docs/https-api)). So `/exec` is fine
for control-plane calls (create/list/delete) but unusable for running an agent.

**Tokens.** Bearer tokens (`exe0.` format) are SSH-signature-based: a permissions JSON payload signed
with an SSH key registered to the account, generatable server-side
(`ssh exe.dev ssh-key generate-api-key --exp=30d`) or fully offline with `ssh-keygen -Y sign`
([HTTPS API Local Key Creation](https://exe.dev/docs/https-api-local-key)). Permissions support
`exp`, `nbf`, `cmds` (an allowlist of lobby commands; the default set is
`["help","ls","new","whoami","ssh-key list","share show","exe0-to-exe1","team","team members"]` —
note `rm` is *not* in the defaults), and a free-form signed `ctx` field. Max token size 8KB. No
replay protection ("Use short-lived tokens"); revocation is by removing the signing SSH key. Opaque
short `exe1` handles can be minted from `exe0` tokens
([HTTPS API](https://exe.dev/docs/https-api)).

**VM-scoped tokens.** The same mechanism, signed with namespace `v0@VMNAME.exe.xyz`, authenticates to
a *VM's* HTTPS endpoint through the proxy. The proxy strips the token and forwards the request with
signed identity headers: `X-ExeDev-UserID`, `X-ExeDev-Email`, and `X-ExeDev-Token-Ctx` (the token's
`ctx`, verbatim, usable for the server's own authorization). Basic-auth mode makes it work with git
over HTTPS ([HTTPS Tokens for VMs](https://exe.dev/docs/https-tokens-for-vms)).

**No REST resource API, no official SDK.** There is no documented resource-oriented REST API, no
TypeScript/Go/Python client SDK, and no webhooks/event feed. The public repo contains helper tools
(`exe-ssh`, `sshminisig`, the agent skill), not an SDK
([github.com/boldsoftware/exe.dev](https://github.com/boldsoftware/exe.dev)). That absence is a
finding: an adapter drives `ssh`/`/exec` itself.

## Machine lifecycle

All lifecycle operations are lobby commands ([CLI reference](https://exe.dev/docs/cli-ls)):

- `new` — create a VM: `--name`, `--cpu`, `--memory`, `--disk` (default 25GB per
  [pricing](https://exe.dev/pricing)), `--image` (any container image, incl. private registries via
  `--registry-auth`), `--env KEY=VALUE`, `--integration` (attach at creation), `--tag`,
  `--setup-script` (first-boot script, max 10KiB), `--pool`, `--prompt` (kick off Shelley),
  `--json` ([cli-new](https://exe.dev/docs/cli-new)). Creation takes "about two seconds"
  ([how it works](https://exe.dev/docs/faq/how-exedev-works)).
- `rm <vmname>...` — delete ([cli-rm](https://exe.dev/docs/cli-rm)); `restart <vmname>`
  ([cli-restart](https://exe.dev/docs/cli-restart)).
- `cp <source-vm> [new-name]` — **clone an existing VM**, optionally resized — a warm-template
  primitive ([cli-cp](https://exe.dev/docs/cli-cp)).
- `resize <vmname> --cpu/--memory/--disk` (disk grow-only)
  ([cli-resize](https://exe.dev/docs/cli-resize)).
- `stat <vm-name> --range=24h|7d|30d` — vCPU/disk/IO/network metrics
  ([cli-stat](https://exe.dev/docs/cli-stat)); `tag`, `rename`, `comment` for metadata.

Disks are persistent by design ("Persistent disks, not serverless" —
[serverful](https://exe.dev/docs/serverful)); VMs survive restarts. Custom images are first-class:
the default image `exeuntu` is open source
([github.com/boldsoftware/exeuntu](https://github.com/boldsoftware/exeuntu)), and OCI labels like
`exe.dev/install-shelley=true` and `exe.dev/login-user=...` tune platform behavior
([Customizing VMs](https://exe.dev/docs/customization)). Each account is pinned to one region (PDX,
LAX, NYC, DAL, FRA, TYO, SYD, SGP, LON); all its VMs live there
([Regions](https://exe.dev/docs/regions)). Docker runs inside VMs
([FAQ](https://exe.dev/docs/faq/docker)).

Relevant to usine directly: VMs created from `exeuntu` come with **`claude`, `codex`, and `pi`
pre-installed**, plus exe.dev's own web agent Shelley on port 9999
([Running Agents](https://exe.dev/docs/use-case-agent),
[What is Shelley?](https://exe.dev/docs/shelley/intro)). There's even a lobby command to drive
Shelley remotely: `shelley prompt <vm> <prompt>` ([cli-shelley](https://exe.dev/docs/cli-shelley)).

## Workspace / checkout story

There is no built-in "clone this repo into the VM" provisioning; checkout happens inside the VM, with
two documented credential paths:

1. **GitHub integration (recommended by exe.dev).** A GitHub App connection plus per-repo
   integrations: `integrations add github --name blog --repository ghuser/blog --attach vm:my-vm`.
   From inside the VM: `git clone https://github.int.exe.xyz/ghuser/blog.git` — the exe.dev edge
   injects credentials, so you "work on private repos without managing tokens, and without having
   tokens on the VM itself." The `gh` CLI works via `GH_HOST=github.int.exe.xyz` (repo view, issues,
   PRs). Flags: `--readonly` (reads only, git + API) and `--act-as-user` (attribute pushes to your
   GitHub user instead of `exe-dev-github-integration[bot]`; not available on team integrations)
   ([GitHub Integration](https://exe.dev/docs/integrations-github)).
2. **Plain tokens on the VM.** `gh auth login` or a fine-grained PAT scoped to one repo, HTTPS
   remotes only ([GitHub token FAQ](https://exe.dev/docs/faq/github-token)).

Integrations attach to a VM (`vm:name`), a tag (`tag:prod` — any VM with the tag gets it), or all
VMs (`auto:all`), at creation (`new --integration`) or later; attachments can be **time-boxed**
(`--for 2h` / `--until <RFC3339>`), lapsing automatically
([Attaching Integrations](https://exe.dev/docs/integrations-attach),
[cli-integrations](https://exe.dev/docs/cli-integrations)). A VM can discover its own attached
integrations (and owner email, tags, comment) from inside via the Reflection integration at
`https://reflection.int.exe.xyz/` — this is how agents on the VM find out what they've been given
([Reflection](https://exe.dev/docs/integrations-reflection)).

## Auth and secrets transport

- **Control-plane auth**: SSH keys registered to the account (`ssh-key add`, optionally
  tag-scoped: `ssh-key add --tag=TAG` scopes a key to VMs with that tag)
  ([cli-ssh-key](https://exe.dev/docs/cli-ssh-key)); the exe.dev host key fingerprint is published
  (`SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`)
  ([host key FAQ](https://exe.dev/docs/faq/host-key)). Non-interactive/agent use is expected to pin
  identity files and use `-o StrictHostKeyChecking=accept-new`
  ([agent skill](https://github.com/boldsoftware/exe.dev/blob/main/skill/SKILL.md)). One SSH key ↔
  one account; multiple accounts need distinct keys
  ([ssh-key FAQ](https://exe.dev/docs/faq/ssh-key)).
- **Secrets are injected at the network edge, never stored on the VM.** Integrations "allow you to
  'inject secrets' on the network, so that those secrets cannot be extracted from the VM itself. …
  The VM — and any agent running on it — can *use* the integration but can never read the secret"
  ([What are Integrations?](https://exe.dev/docs/integrations)). The generic mechanism is the HTTP
  Proxy integration (inject arbitrary headers/bearer/basic-auth toward a target URL)
  ([HTTP Proxy Integration](https://exe.dev/docs/integrations-http-proxy)); a catalog of 100+
  services (Anthropic, GitLab, Bitbucket, Slack, …) builds on it
  ([Integration catalog](https://exe.dev/docs/integrations-catalog)). Secrets are passed to
  `integrations add` via stdin (`--openai-key=-`) to stay out of history; exe.dev redacts credential
  flags in server logs ([Integrations](https://exe.dev/docs/integrations)).
- **LLM credentials follow the same pattern.** The default `llm` integration exposes Anthropic /
  OpenAI / Fireworks at `https://llm.int.exe.xyz` with either exe.dev-managed credentials (billed to
  the account's LLM allocation) or BYO API keys stored server-side. Documented Claude Code setup:
  `ANTHROPIC_BASE_URL=https://llm.int.exe.xyz` with a placeholder `ANTHROPIC_API_KEY`
  ([LLM Integration](https://exe.dev/docs/integrations-llm)). Shelley token usage "tracks the
  underlying model providers' published rates (no token markup)"
  ([pricing](https://exe.dev/pricing)).
- **Cloud identity federation** exists for AWS/GCP (VMs assume IAM roles / impersonate service
  accounts via short-lived OIDC tokens) ([integrations index](https://exe.dev/docs/integrations)).
- **Inbound auth to VM services**: the HTTPS proxy gates VM web ports behind exe.dev login by
  default; sharing is per-email, per-link, or public
  ([Sharing](https://exe.dev/docs/sharing)); programmatic access uses the VM-scoped bearer tokens
  described above ([HTTPS Tokens for VMs](https://exe.dev/docs/https-tokens-for-vms)).

## Pricing and limits

From [exe.dev/pricing](https://exe.dev/pricing) and [usage-pricing](https://exe.dev/usage-pricing)
(public, no signup needed):

- **Personal $20/mo**: 50 VMs, 2 vCPU / 8 GB RAM *shared pool*, 100 GB pooled disk, 200 GB
  transfer. **Team $25/user/mo**: same per user, 250 GB transfer, SSO, teammates' resources as
  burstable capacity. **Reserved Cloud Pool $35.84/hr**: 512 vCPU / 2048 GB RAM, "thousands of VMs,"
  AWS VPC integration. Overages: $0.08/GB/mo disk, $0.05/GB transfer.
- Usage-based rates: **CPU $0.05/core-hour, active memory $0.016/GiB-hour — "billed by peak usage
  within each hour"; inactive VMs pay no CPU and memory at disk rates** ($0.000111/GiB-hr), disk
  $0.08/GiB-month averaged over the cycle, inbound traffic free
  ([usage-pricing](https://exe.dev/usage-pricing), [billing/usage](https://exe.dev/docs/billing/usage)).
  Idle workers are nearly free; only disk is a standing cost.
- Subscription tiers (small/medium/large/extra-large) map price to pooled resources; "an active
  subscription is needed to create and manage VMs"
  ([billing overview](https://exe.dev/docs/billing/overview)). A fully usage-based Cloud Pool plan is
  arranged via support ([billing/cloud-pool](https://exe.dev/docs/billing/cloud-pool)).
- Trials are invite-based (30 days) ([Invites](https://exe.dev/docs/invites)).
- Operational limits that bite an orchestrator: `/exec` 30s timeout / 64KB body / no stdin /
  per-key rate limit ([HTTPS API](https://exe.dev/docs/https-api)); one region per account
  ([Regions](https://exe.dev/docs/regions)); setup script ≤ 10KiB
  ([cli-new](https://exe.dev/docs/cli-new)); disk resize grow-only
  ([cli-resize](https://exe.dev/docs/cli-resize)).

**Not publicly documented** (verified absent, not guessed): compliance certifications (the
[security page](https://exe.dev/security) lists only a disclosure contact, "exe.dev does not have a
bounty program," and one 2026-02 bulletin — no SOC 2 / ISO claims); any SLA; SSH session concurrency
limits; per-tier resource tables beyond the three headline plans; free tier beyond invite trials.
Marketing copy says sandboxes are "billed by the second" ([exe.dev](https://exe.dev/)) while the
usage-pricing page describes hourly-peak billing for CPU/memory — treat granularity as unconfirmed.

## What this means for usine

**Fit.** exe.dev's model matches usine's Worker concept unusually well: a worker = a persistent VM
with a checkout on a persistent disk, near-free while idle, cloneable (`cp`) for parallel runs, with
coding agents pre-installed and repo/LLM credentials held *off* the machine. The security posture
(edge-injected secrets an agent cannot exfiltrate, time-boxed grants, read-only repo grants) is
exactly what "run an unattended coding agent per matched item" wants.

**Adapter shape.** An `ExeDevExecutor` implementing usine's executor seam would be a thin TypeScript
Effect service over two transports:

1. *Control plane* — spawn `ssh exe.dev <cmd> --json` (or `POST /exec` with a `cmds`-scoped bearer
   token) for `new` / `ls` / `rm` / `cp` / `integrations attach|detach`. All JSON, so it parses
   cleanly at the boundary. Provisioning recipe per worker: `new --name usine-<repo> --tag
   usine,repo-<slug> --setup-script …` (or `--image` a baked usine image; or `cp` a warm template),
   then attach a per-repo GitHub integration by tag.
2. *Data plane* — a long-lived `ssh <vm>.exe.xyz -- <agent command>` child process per run: real
   stdin/stdout/stderr streaming, exit codes, signals on disconnect. This is the only documented way
   to run something long on a VM from outside; `/exec` cannot do it (30s, no stdin). Alternative
   data plane: install a small usine worker daemon on the VM's HTTP port and talk HTTPS through the
   proxy with VM-scoped tokens, using signed `X-ExeDev-Token-Ctx` to carry per-run authorization —
   documented and CSP-free, at the cost of shipping a daemon.

**Constraints the target imposes on the executor seam** (these should shape the seam's contract so a
local-process executor and an exe.dev executor both fit):

- *Provisioning*: creation is fast (~2s) but parameterized by image/tag/integration, not by "here is
  a tarball of state"; the seam should express "ensure worker exists with capabilities X" rather
  than assume synchronous imperative setup. One account = one region; multi-region needs multiple
  accounts/keys. An active subscription (billing state) is a precondition the seam must surface as a
  typed error.
- *Checkout*: the platform will not clone for you — checkout is a command the adapter runs in-VM.
  Remote URLs differ per credential path (`github.int.exe.xyz` vs `github.com`), so the seam's
  worker contract should treat "repo remote URL + credential mode" as worker-provided config, not a
  global constant. Pushes attribute to a bot unless `--act-as-user`; PR-creating loops must decide
  which identity they want.
- *Credential injection*: secrets are attached to the machine (integration ↔ vm/tag), not passed per
  run. The seam should model credentials as machine capabilities with optional TTL (`--for`), and
  must not assume it can read secrets back or hand raw tokens to the agent. In-VM discovery of
  granted capabilities exists (Reflection) and could back a worker self-check.
- *Streaming*: assume an SSH-shaped channel (stdout/stderr byte streams + exit code), not a
  structured event API. usine's run-event protocol has to ride on top (e.g. NDJSON on stdout), which
  conveniently is the same thing the local-process executor produces.
- *Cancellation*: no platform-level "cancel run" API — cancellation is killing the SSH session /
  process group, or `restart`/`rm` of the VM as the blunt fallback. The seam's cancel contract
  should be "best-effort signal, then machine-level teardown," idempotent.
- *Cleanup*: `rm` deletes VM + disk; disk billing is time-averaged so ephemeral clones are cheap.
  But since workers are *persistent by default*, the seam needs an explicit policy slot: persistent
  worker per repo (reuse checkout, faster runs, standing disk cost) vs `cp`-per-run clones
  (isolation between concurrent items, cleanup after). Both are one lobby command.
- *Trust*: control-plane access is an SSH private key on the orchestrator host; scoped bearer tokens
  can narrow blast radius per component (mint with explicit `cmds` including `rm` only where
  needed). No webhooks: run-completion and VM-state changes must be polled (`ls --json`, exit of the
  SSH child).

**Bottom line.** exe.dev is a credible v2 remote-worker target: everything usine needs exists and is
scriptable, and the secrets story is better than what usine could build alone. The costs are (a) an
SSH-process-based adapter rather than a typed HTTP SDK, (b) no events/webhooks (poll or hold
connections), and (c) youth of the platform — undocumented commands are explicitly break-prone
([FAQ](https://exe.dev/docs/faq/undocumented)) and no SLA/compliance posture is published. Designing
the executor seam around "machine capabilities + SSH-shaped exec channel" keeps the local executor
and this adapter congruent.
