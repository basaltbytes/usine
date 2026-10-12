# Self-hosted agent sandboxes in exe.dev's shape

Research for [issue #223](https://github.com/basaltbytes/usine/issues/223): an EU-hosted Worker that
usine controls, as a replacement for exe.dev. Snapshot taken
2026-10-12. Every claim cites a primary source: vendor docs, source repositories, release pages, and
posts or recorded interviews by the people who built the thing. Where a fact is not documented, the
note says so. It extends the August study of exe.dev's product surface,
[`docs/research/exe-dev.md`](https://github.com/basaltbytes/usine/blob/research/exe-dev/docs/research/exe-dev.md),
and does not repeat it.

Why this matters for usine: an exe.dev Worker today is one persistent VM per Worker, reached with
`ssh <vm>.exe.xyz`, with Claude Code and Codex children started as one SSH command each and a pid
file beside the worktree (`packages/agents/src/child-host/child-host.ts`), and a per-repository
GitHub grant attached through exe.dev's GitHub integration for the Attempt's window
([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)). Harness logins are on the VM
([ADR 0006](../adr/0006-executor-contract-run-host-attempt-channel.md)). A replacement has to keep
that shape: an SSH destination, a checkout on a persistent disk, and credentials attached to the
machine without reaching the agent.

## 1. How exe.dev is built

exe.dev is run by Bold Software, Inc. David Crawshaw (Tailscale co-founder) and Josh Bleecher Snyder
founded it after building the Sketch coding agent, which ran each agent in a local Docker container
([meet exe.dev](https://blog.exe.dev/meet-exe.dev),
[building a cloud](https://crawshaw.io/blog/building-a-cloud),
[Sketch README](https://github.com/boldsoftware/sketch)). Blog bylines name Ian Lance Taylor, Maisem
Ali, and Philip Zeyliger among the engineers ([blog](https://blog.exe.dev/)). It raised a $35m Series
A in April 2026 ([announcement](https://blog.exe.dev/series-a)). Most of the stack is closed. The
public sources are the docs, the blog, two recorded interviews with Crawshaw, and a few repositories.
The table lists what each source says, layer by layer.

| Layer | What is public | Source |
| --- | --- | --- |
| Hardware | "Most of our machines we buy are physical bare metal devices." Latitude.sh hosts much of it; AWS bare metal for customers who ask; "We don't use Hetzner". A narrow range of AMD EPYC CPUs so live migration works. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| Sub-processors | AWS, Google Cloud, Latitude.sh, NetActuate for compute; ClickHouse for logs. | [sub-processors](https://exe.dev/docs/sub-processors) |
| VMM | Cloud Hypervisor on KVM, called "an implementation detail (and may change!)". One VMM process per VM, all of an account's VMs in one cgroup per pool. | [how it works](https://exe.dev/docs/faq/how-exedev-works), [architecture](https://exe.dev/docs/architecture) |
| Kernel and init | exe.dev builds a stock kernel with module support turned off; customers cannot choose a kernel. An injected init "gets out of the way and lets systemd take over". The init (`exetini`, `exe-init` in the image comments) is not public. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Boot | "We turn an OCI image into a virtual block device and then start it as a machine." Creating a VM takes about two seconds. The default image mounts `/dev/vda` as ext4 and grows it on first boot. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [how it works](https://exe.dev/docs/faq/how-exedev-works), [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Memory | Ballooning and tiered swap; "there's a bit more RAM than is advertised"; "the vast majority of the VMs we run are idle". | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| CPU isolation | Linux core scheduling cookies per team, so VMs of different teams never share a physical core. | [hyper-thread post](https://blog.exe.dev/crossing-the-hyper-thread-boundary) |
| Disk | Local NVMe. Changes stream to another server in the region; the docs say "a few seconds behind", the interview says "at most one-minute-old". `cp` clones a VM copy-on-write in a couple of seconds. Historical disk snapshots are announced but not launched. The storage software is not documented. | [architecture](https://exe.dev/docs/architecture), [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [January update](https://blog.exe.dev/jan26-update), [High Leverage ep. 11](https://www.heavybit.com/library/podcasts/high-leverage/ep-11-why-agents-need-computers-with-david-crawshaw) |
| Live migration | The block diff and RAM are shipped to another host; SSH connections are cut and HTTP requests paused. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| HTTPS edge | An anycast network from a provider and a global load balancer exe.dev wrote, at "dozens of sites". A TLS proxy routes on SNI and the Host header; private by default behind exe.dev login. | [architecture](https://exe.dev/docs/architecture), [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [proxy](https://exe.dev/docs/proxy) |
| SSH front door | `vm.exe.xyz` is a CNAME to one of a pool of shared IPv4 addresses. Each address is used by at most one VM per owner, so the SSH proxy routes on the pair (client public key's user, destination IP). It needs the local destination IP, which "is easy on bare metal". | [SSH has no Host header](https://blog.exe.dev/ssh-host-header) |
| Connection handling | A separate `exepipe` process owns sockets. The proxy authenticates and passes both file descriptors over a Unix socket; `exepipe` copies with `splice`, and on upgrade hands its listeners to a new `exepipe` so open connections survive deploys. | [exepipe post](https://blog.exe.dev/adding-features-without-interrupting-network-connections) |
| Control plane | Go, `sqlc`, one central database behind a single writer process; proxies around the world cache rows and receive invalidations. The lobby (`ssh exe.dev`) is in the United States for every account. | [sqlc post](https://blog.exe.dev/we-taught-sqlc-to-invalidate-our-caches), [regions](https://exe.dev/docs/regions) |
| Credential proxies | The VM calls `<name>.int.exe.xyz`; exe.dev checks the integration is attached to that VM and adds a header, basic auth, a bearer token, an AWS SigV4 signature, or a minted OAuth token before forwarding. GitHub runs through exe.dev's own GitHub App at `github.int.exe.xyz/OWNER/REPO`, optionally read-only. How the edge identifies the calling VM is not documented. | [integrations](https://exe.dev/docs/integrations), [HTTP proxy](https://exe.dev/docs/integrations-http-proxy), [token mint](https://exe.dev/docs/integrations-token-mint), [GitHub](https://exe.dev/docs/integrations-github), [GitHub URLs](https://blog.exe.dev/github-integration-improvements), [secrets post](https://blog.exe.dev/http-proxy-secrets) |
| LLM gateway | `llm.int.exe.xyz` serves Anthropic, OpenAI, and Fireworks with exe.dev's keys, the customer's API key, a ChatGPT subscription connected by device code, or workload identity federation with Anthropic or OpenAI. Claude Code runs with `ANTHROPIC_BASE_URL` set to it and a placeholder key; Codex with a custom `model_provider`. | [LLM integration](https://exe.dev/docs/integrations-llm), [Anthropic WIF](https://exe.dev/docs/integrations-anthropic-wif) |
| Workload identity | exe.dev runs an OIDC issuer; a VM obtains a short-lived token proving which VM it is and exchanges it with AWS, GCP, Anthropic, OpenAI, or Tailscale. | [OAuth for agents](https://blog.exe.dev/oauth-for-agents), [integrations](https://exe.dev/docs/integrations) |
| HTTPS API | `POST /exec` runs a lobby command, including `ssh <vm> <cmd>`; tokens are SSH signatures (`sshminisig` is in the public repo). | [run on VM](https://exe.dev/docs/https-api-run-on-vm), [sshminisig](https://github.com/boldsoftware/exe.dev/tree/main/sshminisig) |
| Default image | `exeuntu`: Ubuntu 24.04 with systemd, Docker, headless Chromium, and `claude`, `codex`, `pi`, and `opencode` installed by its own updater; Tailscale installed and disabled. | [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Enterprise | Single-tenant hosts, or BYOC hosts in the customer's account that "need hardware virtualization and local NVMe drives", operated by exe.dev; 99.9% monthly uptime SLA. | [single tenant](https://exe.dev/docs/enterprise-single-tenant), [BYOC](https://exe.dev/docs/enterprise-byoc), [SLA](https://exe.dev/docs/enterprise-sla) |

Since the August note, exe.dev added pools (a reserved vCPU/memory allotment, $0.105 per 2 vCPU /
4 GiB unit-hour on Work) and standalone VMs billed hourly while running
([pools](https://exe.dev/docs/pools), [standalone VMs](https://exe.dev/docs/standalone-vms)).

Crawshaw on why VMs and not containers, from the Sketch work: "Even almost all of a Linux kernel,
which is gVisor, isn't enough" and "You need to give an agent just a computer"
([High Leverage ep. 11](https://www.heavybit.com/library/podcasts/high-leverage/ep-11-why-agents-need-computers-with-david-crawshaw)).
On speed: "it wasn't really Firecracker or the VMMs that made VMs fast"
([Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw)).

### What comes from Tailscale's open source

The public record shows little direct reuse. All of it:

- `execonnect`, the customer-side daemon that opens outbound tunnels from a private network to exe.dev
  (Apache-2.0), imports `github.com/tailscale/wireguard-go` and `tailscale.com/types/key`, and uses
  a WireGuard-derived netstack TUN on gVisor's `tcpip` package
  ([go.mod](https://github.com/boldsoftware/exe.dev/blob/main/execonnect/go.mod),
  [wgnet.go](https://github.com/boldsoftware/exe.dev/blob/main/execonnect/vpctunnel/wgnet/wgnet.go)).
- exe.dev's internal infrastructure runs on a tailnet ("we use it to connect much of our internal
  infrastructure", [tailmix post](https://blog.exe.dev/a-tale-of-two-tailnets)); Crawshaw says of Tailscale
  "now I'm a big customer of it"
  ([Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw)).
- Crawshaw's `httpts` package ("Serve HTTP on a tailnet", 2024) has a Bold Software fork
  ([crawshaw/httpts](https://github.com/crawshaw/httpts)).

No public source shows `tsnet`, Tailscale SSH (`tailssh`), or DERP in exe.dev's product path. The
SSH front door is exe.dev's own mechanism (routing on key plus destination IP), unlike Tailscale SSH,
which is an SSH server inside each tailnet node built on `tailscale/gliderssh` and
`golang.org/x/crypto/ssh`
([tailssh.go](https://github.com/tailscale/tailscale/blob/main/ssh/tailssh/tailssh.go)). Bold Software
keeps a fork of `tg123/sshpiper` (an SSH reverse proxy, MIT) with two unmerged branch commits, one by
Josh Bleecher Snyder in May 2025 and one by Crawshaw in October 2025 ("add ssh cert signature
advertising") ([boldsoftware/sshpiper](https://github.com/boldsoftware/sshpiper/branches)). Whether
the production SSH proxy is built on it is not documented.

### Data protection position

The lobby is in the United States for all accounts ([regions](https://exe.dev/docs/regions)); the
terms are governed by California law
([terms](https://exe.dev/docs/terms-of-service)); the infrastructure sub-processors are AWS, Google Cloud,
Latitude.sh, and NetActuate, with Standard Contractual Clauses for transfers out of the EEA
([sub-processors](https://exe.dev/docs/sub-processors)). The privacy notice refers to exe.dev acting
as a processor on customers' behalf, but no data processing agreement is published
([privacy notice](https://exe.dev/docs/privacy-notice)). A Frankfurt region and Enterprise BYOC exist,
but in both cases exe.dev operates the hosts. None of this meets "EU infrastructure that we
control".

## 2. Open-source projects with the same idea

Stars, licences, and release dates below come from the GitHub API on 2026-10-12, at the repository
linked in each row.

### Isolation layers

| Project | Kind | Needs KVM | Boot claim | Snapshot / restore | Boots OCI images | Licence | Stars | Latest release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | microVM VMM (AWS) | yes | ≤125 ms to guest init, ≤5 MiB overhead ([spec](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)) | full GA, diff in preview | no, needs tooling | Apache-2.0 | 37.3k | v1.17.0, 2026-09-10 |
| [Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) | VMM (Linux Foundation) | yes (or MSHV) | <100 ms to userspace with direct kernel boot ([site](https://www.cloudhypervisor.org/)) | yes, three restore modes; live migration | no | Apache-2.0 and BSD-3-Clause | 6.3k | v53.0, 2026-07-12 |
| [Kata Containers](https://github.com/kata-containers/kata-containers) | OCI runtime, one VM per pod | yes | not documented | VM templating only | yes | Apache-2.0 | 8.9k | 4.2.0, 2026-09-15 |
| [Flintlock](https://github.com/liquidmetal-dev/flintlock) | microVM manager over containerd (Firecracker or Cloud Hypervisor) | yes | not documented | not documented | kernel and volumes from OCI | MPL-2.0 | 1.5k | v0.16.0, 2026-10-03 |
| [Ignite](https://github.com/weaveworks/ignite) | Firecracker manager | yes | 125 ms | not documented | yes | Apache-2.0 | 3.5k | archived 2023-12 |
| [gVisor](https://github.com/google/gvisor) | user-space kernel | no (systrap) | not published | `runsc checkpoint` | yes | Apache-2.0 | 19.7k | 2026-10-08 |
| [Sysbox](https://github.com/nestybox/sysbox) | system containers, shared kernel | no | not documented | not documented | yes | Apache-2.0 | 3.9k | v0.7.1, 2026-07-31 |
| [microvm.nix](https://github.com/microvm-nix/microvm.nix) | NixOS modules for eight VMMs | yes | not claimed | depends on VMM | no | MIT | 3.0k | no releases |
| [Incus](https://github.com/lxc/incus) | containers and QEMU VMs, REST API, clustering | VMs only | not documented | ZFS/Btrfs/LVM snapshots | containers only | Apache-2.0 | 6.4k | v7.5.1, 2026-09-25 |
| [libkrun](https://github.com/containers/libkrun) | VMM as a library | yes (HVF on macOS) | not documented | not documented | through krunvm and others | Apache-2.0 | 2.8k | v1.19.6, 2026-09-29 |

Details that bear on a coding-agent Worker:

- Firecracker has no virtio-fs ([microvm.nix](https://github.com/microvm-nix/microvm.nix)) and
  networks only through TAP devices
  ([network setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md)).
  Its snapshot docs say network connectivity is not guaranteed after resume, vsock connections close,
  and resuming one snapshot several times is insecure because randomness and tokens are replicated
  ([snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)).
  Hocus moved from Firecracker to QEMU because Firecracker never returned guest memory to the host
  (an idle VM kept 32 GB) and did not reclaim disk; the evaluation took two months
  ([Hocus](https://hocus.dev/blog/qemu-vs-firecracker/)).
- Cloud Hypervisor restores in `copy`, `ondemand` (userfaultfd lazy paging, merged 2026-03-13), or
  `copyonwrite` mode, where clones from one snapshot share page cache
  ([snapshot docs](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md),
  [PR #7800](https://github.com/cloud-hypervisor/cloud-hypervisor/pull/7800)). Snapshots and live
  migration do not work across major versions, which ship every six weeks
  ([releases](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/releases.md)). It has
  virtio-fs through an external `virtiofsd`
  ([fs docs](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/fs.md)).
- gVisor does not support io_uring by default, block-device filesystems such as ext4, KVM inside the
  sandbox, or full iptables ([compatibility](https://gvisor.dev/docs/user_guide/compatibility/)).
  Anthropic's deployment guide measures file I/O heavy work at "up to 10-200× slower"
  ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)), which is what a
  compiler or `pnpm install` does. Crawshaw's view from running Sketch on it: "Even almost all of a
  Linux kernel, which is gVisor, isn't enough"
  ([High Leverage ep. 11](https://www.heavybit.com/library/podcasts/high-leverage/ep-11-why-agents-need-computers-with-david-crawshaw)).
- Sysbox shares the host kernel and its README calls it weaker than VMs; Docker sponsors it but does
  not officially support it ([sysbox](https://github.com/nestybox/sysbox)).
- Incus has projects confined to a certificate and a multi-user daemon that creates one project per
  user ([projects](https://linuxcontainers.org/incus/docs/main/explanation/projects/)); OCI images are
  documented for containers only ([instances](https://linuxcontainers.org/incus/docs/main/explanation/instances/)).

### Platforms that hand an agent a machine

| Project | Isolation | Access | Persistence | Self-hosting | Credential injection | Egress policy | Licence | Stars | Latest release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [E2B runtime](https://github.com/e2b-dev/runtime) | Firecracker, snapshot restore with lazy memory | REST and SDKs; SSH only through a websocat template ([docs](https://docs.e2b.dev/sandbox/ssh-access)) | pause saves memory and disk; paused sandboxes are kept indefinitely | single node only ("E2B Embed") | E2B Cloud only; not in the open code | nftables plus SNI/Host domain lists | Apache-2.0 | 1.7k | 2026.30, 2026-09-10 |
| [CubeSandbox](https://github.com/TencentCloud/CubeSandbox) (Tencent) | KVM microVMs (rust-vmm) | E2B-compatible API; SSH not documented | CoW snapshots, pause and resume | bare metal, single node or cluster | yes | eBPF plus L7 rules | Apache-2.0 in LICENSE | 12.9k | v0.7.3, 2026-10-12 |
| [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) (from Alibaba) | Docker, Kata, or Firecracker | SDKs, CLI, MCP | Firecracker pause | Docker or a Kubernetes operator | yes, vault plus mitmproxy | FQDN lists via DNS and nftables | Apache-2.0 | 15.8k | 1.1.1, 2026-10-09 |
| [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) | containers, Kubernetes, or a microVM driver | CLI, gRPC, SSH | not documented | local or Kubernetes gateway | yes, to approved endpoints ([architecture](https://docs.nvidia.com/openshell/about/architecture.md)) | policy proxy | Apache-2.0 | 16.0k | v0.1.3, 2026-10-09 |
| [Ubicloud](https://github.com/ubicloud/ubicloud) | Cloud Hypervisor, one network namespace per customer | VMs with SSH, API | SPDK block storage, not replicated | on Hetzner, Leaseweb, AWS bare metal | no | nftables firewalls | AGPL-3.0 | 12.3k | no releases, pushed 2026-10-12 |
| [Coder](https://github.com/coder/coder) | whatever the Terraform template creates | SSH, API | template-defined | binary plus Postgres | AI Gateway, Premium only; GitHub tokens enter the workspace ([external auth](https://coder.com/docs/admin/external-auth)) | Agent Firewall, Premium only ([docs](https://coder.com/docs/ai-coder/agent-boundaries)) | AGPL-3.0 plus source-available enterprise | 17.0k | v2.36.7, 2026-10-05 |
| [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (SIG Apps) | RuntimeClass (gVisor or Kata) | SDKs, router | PVC; suspend deletes the pod | any Kubernetes | not documented | NetworkPolicy (L3/L4) | Apache-2.0 | 4.2k | v1.0.6, 2026-10-08 |
| [microsandbox](https://github.com/superradcompany/microsandbox) | libkrun | SDKs, CLI; no server | snapshots, forks | library | placeholders swapped by a host proxy | host allowlist | Apache-2.0 | 8.7k | v0.7.8, 2026-10-09 |
| [Gondolin](https://github.com/earendil-works/gondolin) (Earendil) | QEMU, krun experimental | TypeScript SDK, SSH into the guest | qcow2 disk checkpoints | library | placeholders; host injects for allowed hosts ([docs](https://earendil-works.github.io/gondolin/)) | JS allowlist | Apache-2.0 | 2.3k | v0.13.0, 2026-10-04 |
| [BoxLite](https://github.com/boxlite-ai/boxlite) | libkrun | library or `boxlite serve` REST | qcow2 CoW disk | library or server | placeholders | `allow_net` | Apache-2.0 | 2.5k | v0.10.6 |
| [Arrakis](https://github.com/abshkbh/arrakis) | Cloud Hypervisor | REST, SSH | snapshot with processes | single host | no | no | AGPL-3.0 | 0.9k | 2025-06-02, dormant |
| [Daytona](https://github.com/daytonaio/daytona) | privileged Docker containers ([runner](https://github.com/daytonaio/daytona/blob/v0.190.0/apps/runner/pkg/docker/container_configs.go)) | API, SSH gateway | snapshots, volumes | Compose, "not safe to use in production" | not documented | CIDR list | AGPL-3.0 at v0.190.0 | 71.6k | archived 2026-06 |

What changed in 2026 and matters here:

- E2B retired its Nomad-based multi-node deployment on 2026-09-10 "ahead of a new deploy path"
  ([commit](https://github.com/e2b-dev/runtime/commit/8a1c4888)); what remains is single-node "E2B
  Embed", which needs `/dev/kvm`, hugepages, and Ubuntu 24.04
  ([Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md)). Secret injection is
  documented for E2B Cloud ([docs](https://docs.e2b.dev/secrets/inject.md)); the architecture doc
  names an `orchestrator-ee` that resolves secrets at egress, and the open `main.go` wires only the
  plain TCP firewall ([architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md),
  [main.go](https://github.com/e2b-dev/runtime/blob/main/packages/orchestrator/main.go)). Reading the
  code, the injecting proxy is not open source.
- Daytona moved development private in June 2026
  ([announcement](https://daytona.io/dotfiles/updates/daytona-is-going-closed-source)).
- CubeSandbox (created 2026-04) and OpenShell (created 2026-02) are under a year old.
- Coder's Community edition has no AI Gateway or Agent Firewall and caps Tasks at 1,000 agent
  workspace builds ([Tasks](https://coder.com/docs/@v2.36.3/ai-coder/tasks)).
- Ubicloud is the only open project found that runs Cloud Hypervisor VMs on rented EU bare metal
  (Hetzner) with SSH access and nftables firewalls. Its control plane is Ruby and Postgres, it boots
  cloud images, not OCI images, and it has no credential proxy
  ([README](https://github.com/ubicloud/ubicloud)).

Hosted or closed products, for reference only: Docker Sandboxes (licence not stated) keeps a Claude subscription session token on
the host, "never stored inside the sandbox" ([Docker](https://docs.docker.com/ai/sandboxes/get-started/)),
with a host proxy that injects credentials
([isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)); Fly Sprites, Modal, Vercel
Sandbox, Cloudflare Sandbox, Northflank, Freestyle, Morph, Runloop, and Blaxel are hosted only.

### Proxies that inject credentials

| Project | Approach | What it injects | Allowlist | Licence | Stars | Latest release |
| --- | --- | --- | --- | --- | --- | --- |
| [superfly/tokenizer](https://github.com/superfly/tokenizer) | client speaks plain HTTP to it over a VPN, it upgrades to HTTPS; no CA | secrets sealed to the proxy's key, sent in a `Proxy-Tokenizer` header; bearer, HMAC, SigV4, OAuth2, and a GitHub App processor that returns a sealed one-hour installation token | per secret `allowed_hosts` | Apache-2.0 | 500 | tags only, pushed 2026-09-15 |
| [iron-proxy](https://github.com/paradigmxyz/iron-proxy) | TLS interception with your CA; DNS, CONNECT, or nftables/TPROXY routing | swaps a proxy token for the real secret | default deny by domain and CIDR | Apache-2.0 | 714 | v0.53.0, 2026-10-06 |
| [Envoy `credential_injector`](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter) | reverse proxy | static basic or bearer, or OAuth2 client credentials; status alpha ([metadata](https://github.com/envoyproxy/envoy/blob/main/source/extensions/extensions_metadata.yaml)) | routes | Apache-2.0 | 29.1k | v1.39.3 |
| [Caddy `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) | reverse proxy | static `header_up` | matchers | Apache-2.0 | 77.8k | v2.11.7 |
| [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | HTTP and SOCKS5 proxy, optional TLS termination | masked credentials, only with TLS termination | domain lists | Apache-2.0 | 5.5k | v0.0.79 |
| [Smokescreen](https://github.com/stripe/smokescreen) | CONNECT proxy | none | per-role host ACL, SSRF checks | MIT | 1.4k | v0.1.0 |
| [Squid](https://wiki.squid-cache.org/Features/SslPeekAndSplice) | peek and splice by SNI, or bump with a CA | `request_header_add` | ACLs | GPL-2.0 | 3.1k | 7.7 |
| [LiteLLM](https://github.com/BerriAI/litellm) | LLM base URL, Anthropic passthrough | provider API keys | gateway keys | MIT except `enterprise/` | 61.1k | v1.105.0 |
| [agentgateway](https://github.com/agentgateway/agentgateway) (Linux Foundation) | base URL | `backendAuth` token exchange | policies | Apache-2.0 | 5.3k | v1.6.0 |
| [coder/httpjail](https://github.com/coder/httpjail) | transparent interception | none | JS or shell rules | CC0-1.0 | 1.0k | v0.6.2 |

Anthropic's own [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway) ships in
the `claude` binary and keeps the upstream credential (Bedrock, Vertex, Foundry, or an API key)
server-side, but it has no subscription upstream and "There is no service-token flow for unattended
pipelines", so it does not fit unattended Workers.

## 3. The pieces of our own

Each piece below lists the options with evidence, then the choice that fits usine. usine needs less
than exe.dev sells: the orchestrator is the only SSH client, Workers serve no public HTTPS, and
anything durable is pushed to GitHub before a worktree is removed (salvage, ADR 0006).

### 3.1 Isolation

| Option | What it gives | Cost of running it | Fit |
| --- | --- | --- | --- |
| A KVM VM rented from an EU cloud, one per Worker | the provider's hypervisor isolates customers; SSH; persistent disk | none beyond the VM; but Hetzner Cloud has no nested virtualization ("No, this is not possible on cloud server", [FAQ](https://docs.hetzner.com/cloud/servers/faq/)), so no microVMs inside it | good for a first stage; slow to create, no clones |
| Cloud Hypervisor on rented bare metal | what exe.dev runs; snapshots with CoW restore, live migration, virtio-fs, hotplug | we operate hosts, kernels, and VMM upgrades every six weeks | best match for a later stage |
| Firecracker on bare metal | smallest VMM, fastest documented boot | no virtio-fs; memory is not returned to the host (Hocus); snapshot caveats above | good for short-lived per-Attempt VMs, weaker for persistent Workers |
| Incus VMs (QEMU) | mature API, projects per tenant, ZFS clones, clustering | heavier VMM; no OCI-as-VM | a reasonable middle path if we want a product rather than code |
| gVisor or Kata containers | container workflow | gVisor's file I/O and syscall gaps hurt builds; Kata runs pods or containers and documents no workspace checkpoint | not a fit for a full dev machine |

### 3.2 Image baking and harness logins

- **For a rented VM**: a cloud-init user-data file that installs git, Node, `gh`, `claude`, and `codex`
  on Debian, run at first boot ([cloud-init](https://cloudinit.readthedocs.io/en/latest/)). exe.dev's
  `exeuntu` Dockerfile is a working reference for which services to disable in a VM image
  ([Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile)); its licence is not an
  OSI licence (GitHub reports "Other"), so read it, do not copy it.
- **For our own VMM**: build an OCI image with a Dockerfile, export its filesystem, and write it into
  an ext4 file with `mkfs.ext4 -d <dir>`, which populates the filesystem from a directory
  ([mke2fs](https://man7.org/linux/man-pages/man8/mke2fs.8.html)). Firecracker documents the same
  approach with a mounted image ([rootfs guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md)).
  The kernel is ours to build, with the root filesystem driver built in. Per-VM disks are
  copy-on-write clones of that base (LVM thin snapshots, ZFS clones, or qcow2 backing files).
- **Harness logins** stay the operator's task (ADR 0006). Claude Code accepts a one-year subscription
  token from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`, or a `/login` stored in
  `~/.claude/.credentials.json` on Linux
  ([authentication](https://code.claude.com/docs/en/authentication)). Codex accepts
  `codex login --device-auth`, or a copied `~/.codex/auth.json`, which it refreshes during use
  ([Codex auth](https://learn.chatgpt.com/docs/auth)). Both put a subscription credential on the VM;
  section 3.4 covers the alternative.

### 3.3 Network reach

usine's `RemoteShell` child host already takes arbitrary SSH client arguments and a destination
(`packages/agents/src/child-host/child-host.ts`), so every option below plugs in without a code
change to the child host.

| Option | Notes | Source |
| --- | --- | --- |
| SSH to a public IP, firewall open to the orchestrator only | simplest; Hetzner Cloud firewalls filter inbound and outbound | [Hetzner Cloud](https://www.hetzner.com/cloud/) |
| `ProxyJump` through one bastion into a private network | VMs need no public address; the bastion is the gateway host of stage 2 | [ssh_config](https://man.openbsd.org/ssh_config) |
| sshpiper | SSH reverse proxy that routes by username to many upstreams; needs its own upstream key | [tg123/sshpiper](https://github.com/tg123/sshpiper) (MIT, 1.3k stars, v1.6.1) |
| Tailscale | coordination server in Frankfurt, but "EU data residency guarantee: No, not today" | [EU data sovereignty](https://tailscale.com/resources/eu-data-sovereignty) |
| Headscale | self-hosted coordination server, one tailnet only, supports Tailscale SSH | [headscale](https://github.com/juanfont/headscale) (BSD-3-Clause, 44.6k stars, v0.29.4), [features](https://headscale.net/stable/about/features/) |
| NetBird | WireGuard mesh with a self-hosting guide; management, signal, and relay are AGPL-3.0 | [netbird](https://github.com/netbirdio/netbird) (29.9k stars, v0.80.0) |
| tsnet in the orchestrator | Go only; no Node.js binding exists, `libtailscale` has no releases | [tsnet](https://tailscale.com/kb/1244/tsnet), [libtailscale](https://github.com/tailscale/libtailscale) |

One orchestrator talking to a handful of hosts does not need a mesh. A private network with one
bastion, or WireGuard between the orchestrator and each host, covers it.

### 3.4 Credential proxies

The design that needs no CA in the VM is the one exe.dev uses: the VM calls a private hostname over
plain HTTP or HTTPS, and a reverse proxy outside the VM adds the credential and forwards to the real
API. Anthropic's deployment guide recommends the same pattern ("run a proxy outside the agent's
security boundary that injects credentials") and notes that `ANTHROPIC_BASE_URL` gives the proxy
plaintext requests while `HTTPS_PROXY` gives it only an opaque tunnel unless it intercepts TLS
([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)).

What the proxy has to do for usine:

- **GitHub.** The orchestrator already mints a one-hour installation token scoped to the Attempt's
  repository with `POST /app/installations/{id}/access_tokens` and its `repositories` parameter
  ([REST docs](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app));
  git authenticates with it as user `x-access-token`
  ([installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
  The executor would attach that token to the proxy for the VM and the repository, as it attaches an
  exe.dev integration today, and detach it at cleanup. The VM clones
  `http://git.<gateway>/OWNER/REPO.git`; the proxy checks that the calling VM has a grant for that
  repository and adds `Authorization`. `gh` needs the REST API on the same host, as exe.dev does with
  `GH_HOST=github.int.exe.xyz` ([GitHub integration](https://exe.dev/docs/integrations-github)).
- **Claude Code.** `ANTHROPIC_BASE_URL` points it at the proxy; `ANTHROPIC_AUTH_TOKEN` is sent as
  `Authorization: Bearer` ([authentication](https://code.claude.com/docs/en/authentication)). With an
  API key, the key is in the proxy only. With a subscription, Anthropic documents only the case
  where the login stays on the machine and the gateway forwards it, including the OAuth capability in
  `anthropic-beta` ([LLM gateways](https://code.claude.com/docs/en/llm-gateway)). Swapping a
  placeholder for a subscription token at the proxy is not documented by Anthropic; Docker
  Sandboxes states that it keeps the session token on the host
  ([Docker](https://docs.docker.com/ai/sandboxes/get-started/)) but does not say how. This needs a
  test and a reading of the subscription terms before usine relies on it.
- **Codex.** A custom `model_provider` with `base_url` points it at the proxy
  ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). For a ChatGPT
  plan, OpenAI documents a gateway that forwards `/responses` and `/models` to
  `https://chatgpt.com/backend-api/codex` with the client's ChatGPT token
  ([gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway)).
  Codex's own client sends `Authorization: Bearer` and `ChatGPT-Account-ID`
  ([source](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/bearer_auth_provider.rs)),
  and exe.dev runs exactly the variant where the ChatGPT account is connected to the proxy and the VM
  has no OpenAI credential ([LLM integration](https://exe.dev/docs/integrations-llm)). So the ChatGPT case has a
  working precedent; the Claude subscription case does not.
- **Identity of the caller.** exe.dev does not document how its edge identifies the calling VM. On
  our own host the TAP device or private address identifies it, provided nftables drops packets whose
  source address is not the one assigned to that interface. On a rented VM, a per-VM bearer token
  sent by git (`http.extraHeader`) and by the harnesses is the fallback; it is a credential on the VM,
  but one that works only from inside the private network and grants only what the proxy allows.

Candidates for the proxy itself: a small service of our own (git smart HTTP and REST passthrough,
streaming LLM passthrough, and an attach/detach API for the executor) is the closest fit, because the
injection rule (which VM, which repository, until when) is usine's. superfly/tokenizer already has a
GitHub App processor, but it expects the client to send a sealed secret in a `Proxy-Tokenizer` header
over plain HTTP, which git and the harnesses do not do without wrappers. Envoy's injector is alpha and
static per route. iron-proxy and sandbox-runtime need a CA in the VM. LiteLLM covers API keys only.
Anthropic warns that a gateway must keep up with what Claude Code sends
([LLM gateways](https://code.claude.com/docs/en/llm-gateway)); a passthrough that forwards headers
and streams verbatim keeps that maintenance small.

### 3.5 Egress policy

Firecracker "does not perform any network traffic filtering" and documents per-TAP nftables rules
instead, including dropping the metadata address
([production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)).
The layout that follows from it: the VM's only route is the gateway; DNS resolves through the
gateway; the GitHub and LLM hostnames go to the injecting proxy; everything else (npm, PyPI, crates,
release downloads) goes through an allowlisting forward proxy such as Squid peek-and-splice or
Smokescreen. An SNI allowlist without TLS interception can be evaded by domain fronting
([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)); that residual risk
is acceptable for package registries when no secret is reachable from the VM.

### 3.6 Lifecycle

| Operation | Rented VM | Own Cloud Hypervisor host |
| --- | --- | --- |
| Create | provider API, cloud-init, minutes | CoW clone of a base volume plus direct kernel boot; exe.dev reports about 2 s |
| Clone a warm Worker | provider snapshot, then create (minutes) | LVM/ZFS clone of the disk, or Cloud Hypervisor `copyonwrite` restore of a memory snapshot |
| Park | Hetzner bills a server "regardless of whether it is turned on or not" until it is deleted ([billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)); park by snapshot and delete | stop the VMM; only disk space is used on a host already paid for |
| Destroy | provider API | remove the TAP, nftables rules, and volume |

exe.dev's own parking is memory ballooning and tiered swap with "a bit more RAM than is advertised"
([Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw)).
That density matters to a hosting business with many idle VMs; usine's Workers are busy or deleted.

### 3.7 Multi-tenancy

- One VM per customer Worker at minimum. Today several Attempts on one exe.dev VM share the machine,
  and the VM has edge grants for every repository it is running at once
  ([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)); per-customer Workers keep that
  sharing inside one customer.
- On shared hosts, Linux core scheduling keeps two tenants off sibling hyper-threads, which is what
  exe.dev does per team ([post](https://blog.exe.dev/crossing-the-hyper-thread-boundary),
  [kernel docs](https://docs.kernel.org/admin-guide/hw-vuln/core-scheduling.html)). exe.dev's
  argument for single-tenant hosts (a hypervisor escape or cache side channel has no other customer to
  reach) applies equally to usine ([single tenant](https://exe.dev/docs/enterprise-single-tenant)).
- The proxy keys every grant by VM, so a customer's VM can never be granted another customer's
  repository.

### 3.8 EU hosting

| Provider | Product | KVM for our own VMM | Example | EUR/month excl. VAT | Locations | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Hetzner | Cloud CX43 | no nested virtualization | 8 shared vCPU, 16 GB, 160 GB NVMe | 15.99 | Falkenstein, Nuremberg, Helsinki | [prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [plans](https://www.hetzner.com/cloud/cost-optimized/) |
| Hetzner | Cloud CCX33 | no | 8 dedicated vCPU | 138.49 | same | [prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) |
| Hetzner | AX42-1 dedicated | yes | Ryzen 7 PRO 8700GE, 64 GB, 2×512 GB NVMe | 97.30, setup 49 | same | [AX42](https://www.hetzner.com/dedicated-rootserver/ax42/) |
| Hetzner | AX102-1 dedicated | yes | Ryzen 9 7950X3D, 128 GB, 2×1.92 TB NVMe | 257.30, setup 129 | same | [AX102](https://www.hetzner.com/dedicated-rootserver/ax102/) |
| Scaleway | Elastic Metal EM-A610R-NVMe | yes | Ryzen PRO 3600, 32 GB, 2×1 TB NVMe | 39.99 | Paris, Amsterdam, Warsaw | [Elastic Metal](https://www.scaleway.com/en/pricing/elastic-metal/) |
| OVHcloud | Rise / Advance | yes | varies | from 56.99 / from 114.99 | France and others | [Rise](https://eco.ovhcloud.com/en-ie/rise/), [Advance](https://www.ovhcloud.com/en-ie/bare-metal/advance/) |

Hetzner prices rose on 15 June 2026 (CX43 from 11.99, CCX33 from 62.49); the plan page showed the
cost-optimized plans as unavailable when checked, so stock varies. Netcup disables the AMD SVM flag
([FAQ](https://www.netcup.com/en/helpcenter/documentation/server/faq)), and Infomaniak rules out
nested virtualization on its VPS
([FAQ](https://www.infomaniak.com/en/support/faq/2811/use-nested-virtualization-cloud-vps-lite-vps)).
Hetzner, Scaleway, and OVHcloud publish data processing agreements
([Hetzner](https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner),
[Scaleway](https://www.scaleway.com/en/docs/account/how-to/download-scaleway-contracts/),
[OVHcloud](https://contract.eu.ovhapis.com/1.0/pdf/OVH_Data_Protection_Agreement-ie.pdf)). Ubicloud
already automates Cloud Hypervisor hosts on Hetzner bare metal through the Robot API, which is
evidence the combination works ([README](https://github.com/ubicloud/ubicloud)).

### 3.9 Effort and running cost

These are estimates by the author of this note, not sourced figures, except where a link says
otherwise. Engineering time assumes one engineer who knows the usine executor.

| Piece | Build | Running cost | Ongoing operation |
| --- | --- | --- | --- |
| `ssh` Worker kind over a rented VM | 3 to 5 days, reusing the exe.dev executor's SSH paths and the local executor's token handling | 16 to 140 EUR per Worker per month | 1 to 2 h per month per Worker: OS and harness updates, re-login |
| Gateway host with the injecting proxy and egress allowlist | 2 to 3 weeks including tests and a dogfood run | one small VM, 5 to 16 EUR per month | 2 to 4 h per month: allowlist changes, keeping pace with harness API changes |
| Own Cloud Hypervisor host with image pipeline, CoW volumes, and a host agent | 6 to 10 weeks to a first version; Hocus spent two months choosing a VMM ([Hocus](https://hocus.dev/blog/qemu-vs-firecracker/)) | AX102 at 257.30 EUR per host, two for failover | 1 to 3 days per month: VMM releases every six weeks, kernels, disks, capacity |

For sizing, actuated's guide fits 10 jobs of 4 vCPU and 12 GB on a 32-thread, 128 GB host
([actuated](https://docs.actuated.com/provision-server)), which matches an AX102.

## 4. Recommendation

No open project gives usine an EU-hostable, SSH-reachable, persistent Worker with a GitHub and LLM
credential proxy in one piece. E2B's open runtime is single-node and leaves out its injecting proxy,
Daytona closed its source, Coder keeps agent network controls in Premium, and the projects that do
inject credentials (CubeSandbox, OpenSandbox, OpenShell, Gondolin, microsandbox) are under a year old
or are libraries. The pieces exist separately and are small enough to assemble. The executor seam
needs no change for any stage: credentials are machine-attached capabilities and making a Worker
ready is adapter-specific ([ADR 0006](../adr/0006-executor-contract-run-host-attempt-channel.md)).

### Stage 1: an `ssh` Worker on a rented EU VM

A third Worker kind for any Linux machine reachable over SSH. One VM per customer at Hetzner
(Falkenstein, Nuremberg, or Helsinki), built from a cloud-init file kept in the repository, with
inbound SSH open to the orchestrator only. Children run exactly as on exe.dev today: one SSH command
each, with the pid file beside the worktree. GitHub access uses the one-hour single-repository token
the orchestrator already mints, written for the Attempt as the local Worker does and wiped at cleanup.
Harness logins are on the VM, as on exe.dev today.

Gives up, compared with exe.dev: a GitHub token is on the VM for up to an hour, which is the blast
radius ADR 0011 already accepts for the local Worker; there is no egress control beyond IP firewall
rules; a Worker takes minutes to create and cannot be cloned. Gains: customer code is on EU
infrastructure under the provider's DPA with no US control plane, and pushes are attributed to the
factory's own App instead of `exe-dev-github-integration[bot]`
([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)).

### Stage 2: a gateway host with the credential proxy and egress allowlist

Worker VMs lose their public address and are reachable only through one gateway VM on a private
network. The gateway is the SSH bastion (`ProxyJump`), the DNS resolver, the injecting proxy for GitHub and the LLM
providers, and the allowlisting forward proxy for package registries, with nftables denying anything
else. The executor's credential step changes from writing a token to attaching it to the gateway for
that VM and repository, and detaching it at cleanup, which is the shape of exe.dev's
`integrations attach --for`. API keys and the ChatGPT plan move into the proxy, following exe.dev's
documented ChatGPT variant. The Claude subscription login stays on the VM until a test shows that a
placeholder swap at the proxy works and the subscription terms allow it.

Gives up: Workers are still persistent rented VMs, slow to create. The providers do not document
whether their private networks stop one VM from using another's source address, so each VM also
sends a per-VM gateway token; that token is useless outside the private network and grants only what
the executor attached.

### Stage 3: our own Cloud Hypervisor hosts

Only if Attempts need their own VM, or Worker count makes rented VMs expensive. Two Hetzner AX102
hosts (or a Scaleway Elastic Metal machine for a pilot) running Cloud Hypervisor, an image pipeline
from Dockerfile to ext4, copy-on-write volumes, one TAP and nftables chain per VM, the stage 2
gateway on each host, and a small host agent that creates, clones, stops, and destroys VMs for the
executor. With clones in seconds, the executor can give each Attempt its own VM cloned from a warm
Worker, so Attempts on one Worker are separated by a hypervisor instead of a directory. Ubicloud is
the alternative to writing the host side ourselves: it already runs Cloud Hypervisor on Hetzner, at
the cost of an AGPL Ruby control plane, cloud images instead of OCI, and no credential proxy.

Gives up: we operate hardware. Disk durability depends on mirrored NVMe and on pushes to GitHub, not on
a streamed replica, and a host is drained ([ADR 0023](../adr/0023-graceful-attempt-drain.md)), not
live-migrated.

### What exe.dev does that is hard to reproduce, and whether usine needs it

| exe.dev capability | Hard because | Matters for usine |
| --- | --- | --- |
| Anycast edge, global load balancer, SSH routed by key and shared IP | bespoke networking at dozens of sites | no: the orchestrator is the only SSH client |
| HTTPS proxy with login per VM | edge, certificates, auth | not now; previews may want it later |
| Disk streamed to another host, live migration, memory ballooning and tiered swap | storage and VMM engineering at scale | little: work is pushed to GitHub, the cached clone is a cache, hosts can be drained |
| VM creation and `cp` clones in about 2 s | OCI-to-block pipeline and CoW storage | only for per-Attempt VMs (stage 3) |
| 100+ integrations, an OIDC issuer, ChatGPT subscription brokering | a product team's backlog | only GitHub and the two harnesses matter; brokering a Claude subscription is the one part with no documented precedent |

## Verdict

usine can drop exe.dev for an EU Worker it controls without building exe.dev. Stage 1 is a few days
of work on top of the existing remote child host and gives EU hosting with the local Worker's
credential posture: a one-hour, single-repository GitHub token on the machine.
Stage 2, a gateway with a credential-injecting reverse proxy and an egress allowlist, takes a few
weeks and removes the GitHub token, API keys, and the ChatGPT login from the machine, matching exe.dev's integrations for
everything usine uses except the Claude subscription, which needs a test. Stage 3, our own Cloud
Hypervisor hosts, is the expensive part of exe.dev's shape and is worth building only when
per-Attempt VMs or Worker density justify operating hardware.
