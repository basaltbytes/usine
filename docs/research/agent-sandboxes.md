# Self-hosted agent sandboxes like exe.dev

Research for [issue #223](https://github.com/basaltbytes/usine/issues/223): an EU-hosted worker that
usine controls, to replace exe.dev. Snapshot date: 2026-10-12. Claims cite primary sources (vendor
docs, source repositories, release pages, the builders' posts and interviews); undocumented facts
are marked. This extends the August study of exe.dev's product surface,
[`docs/research/exe-dev.md`](https://github.com/basaltbytes/usine/blob/research/exe-dev/docs/research/exe-dev.md).

An exe.dev worker is one persistent VM (`ssh <vm>.exe.xyz`) that runs each Claude Code or Codex child
as one SSH command with a pid file beside the worktree
(`packages/agents/src/child-host/child-host.ts`). Harness logins are on the VM
([ADR 0006](../adr/0006-executor-contract-run-host-attempt-channel.md)), and exe.dev's GitHub
integration attaches a per-repository grant for the attempt window
([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)). A replacement needs an SSH
destination, a checkout on a persistent disk, and machine-attached credentials the agent can't read.

## 1. exe.dev architecture

Bold Software, Inc. runs exe.dev. David Crawshaw (Tailscale co-founder) and Josh Bleecher Snyder
founded it after building the Sketch coding agent, which ran each agent in a local Docker container
([meet exe.dev](https://blog.exe.dev/meet-exe.dev),
[building a cloud](https://crawshaw.io/blog/building-a-cloud),
[Sketch README](https://github.com/boldsoftware/sketch)). Blog bylines include engineers Ian Lance
Taylor, Maisem Ali, and Philip Zeyliger ([blog](https://blog.exe.dev/)). It raised a $35m Series A in
April 2026 ([announcement](https://blog.exe.dev/series-a)). Most of the stack is closed. Public
sources are the docs, the blog, two recorded interviews with Crawshaw, and a few repositories:

| Layer | What is public | Source |
| --- | --- | --- |
| Hardware | "Most of our machines we buy are physical bare metal devices." Mostly at Latitude.sh; AWS bare metal on request; "We don't use Hetzner". A narrow range of AMD EPYC CPUs, for live migration. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| Sub-processors | AWS, Google Cloud, Latitude.sh, NetActuate for compute; ClickHouse for logs. | [sub-processors](https://exe.dev/docs/sub-processors) |
| VMM | Cloud Hypervisor on KVM, "an implementation detail (and may change!)". One VMM process per VM; an account's VMs share one cgroup per pool. | [how it works](https://exe.dev/docs/faq/how-exedev-works), [architecture](https://exe.dev/docs/architecture) |
| Kernel and init | Stock kernel with module support off, not customer-selectable. An injected init (`exetini`, `exe-init` in the image comments; not public) "gets out of the way and lets systemd take over". | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Boot | "We turn an OCI image into a virtual block device and then start it as a machine." About two seconds per VM. The default image mounts `/dev/vda` as ext4 and grows it on first boot. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [how it works](https://exe.dev/docs/faq/how-exedev-works), [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Memory | Ballooning and tiered swap; "there's a bit more RAM than is advertised"; "the vast majority of the VMs we run are idle". | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| CPU isolation | Linux core scheduling cookies per team: VMs of different teams never share a physical core. | [hyper-thread post](https://blog.exe.dev/crossing-the-hyper-thread-boundary) |
| Disk | Local NVMe, streamed to another server in the region: "a few seconds behind" (docs), "at most one-minute-old" (interview). `cp` makes a copy-on-write VM clone in a couple of seconds. Historical disk snapshots announced, not launched. Storage software undocumented. | [architecture](https://exe.dev/docs/architecture), [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [January update](https://blog.exe.dev/jan26-update), [High Leverage ep. 11](https://www.heavybit.com/library/podcasts/high-leverage/ep-11-why-agents-need-computers-with-david-crawshaw) |
| Live migration | Block diff and RAM move to another host; SSH connections drop, HTTP requests pause. | [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw) |
| HTTPS edge | A provider's anycast network plus exe.dev's own global load balancer, at "dozens of sites". A TLS proxy routes on SNI and Host; private by default behind exe.dev login. | [architecture](https://exe.dev/docs/architecture), [Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw), [proxy](https://exe.dev/docs/proxy) |
| SSH front door | `vm.exe.xyz` is a CNAME to a pooled shared IPv4 address used by at most one VM per owner, so the SSH proxy routes on (client public key's user, destination IP). That needs the local destination IP, which "is easy on bare metal". | [SSH has no Host header](https://blog.exe.dev/ssh-host-header) |
| Connection handling | A separate `exepipe` process keeps the sockets: the proxy authenticates and passes both file descriptors over a Unix socket, `exepipe` copies with `splice`, and on upgrade passes its listeners to a new `exepipe`, so connections survive deploys. | [exepipe post](https://blog.exe.dev/adding-features-without-interrupting-network-connections) |
| Control plane | Go and `sqlc`; one central database behind a single writer process; proxies worldwide cache rows and receive invalidations. The lobby (`ssh exe.dev`) is in the US for every account. | [sqlc post](https://blog.exe.dev/we-taught-sqlc-to-invalidate-our-caches), [regions](https://exe.dev/docs/regions) |
| Credential proxies | The VM calls `<name>.int.exe.xyz`; exe.dev checks that the integration is attached to that VM, adds a header, basic auth, a bearer token, an AWS SigV4 signature, or a minted OAuth token, and forwards. GitHub goes through exe.dev's GitHub App at `github.int.exe.xyz/OWNER/REPO`, optionally read-only. How the edge identifies the VM is undocumented. | [integrations](https://exe.dev/docs/integrations), [HTTP proxy](https://exe.dev/docs/integrations-http-proxy), [token mint](https://exe.dev/docs/integrations-token-mint), [GitHub](https://exe.dev/docs/integrations-github), [GitHub URLs](https://blog.exe.dev/github-integration-improvements), [secrets post](https://blog.exe.dev/http-proxy-secrets) |
| LLM gateway | `llm.int.exe.xyz` serves Anthropic, OpenAI, and Fireworks with exe.dev's keys, the customer's API key, a ChatGPT subscription connected by device code, or workload identity federation with Anthropic or OpenAI. Claude Code uses it as `ANTHROPIC_BASE_URL` with a placeholder key; Codex as a custom `model_provider`. | [LLM integration](https://exe.dev/docs/integrations-llm), [Anthropic WIF](https://exe.dev/docs/integrations-anthropic-wif) |
| Workload identity | exe.dev runs an OIDC issuer; a VM gets a short-lived token proving its identity and exchanges it with AWS, GCP, Anthropic, OpenAI, or Tailscale. | [OAuth for agents](https://blog.exe.dev/oauth-for-agents), [integrations](https://exe.dev/docs/integrations) |
| HTTPS API | `POST /exec` runs a lobby command, including `ssh <vm> <cmd>`; tokens are SSH signatures (`sshminisig` is in the public repo). | [run on VM](https://exe.dev/docs/https-api-run-on-vm), [sshminisig](https://github.com/boldsoftware/exe.dev/tree/main/sshminisig) |
| Default image | `exeuntu`: Ubuntu 24.04 with systemd, Docker, headless Chromium, and `claude`, `codex`, `pi`, and `opencode` from its own updater; Tailscale installed, disabled. | [exeuntu Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile) |
| Enterprise | Single-tenant hosts, or BYOC hosts in the customer's account that "need hardware virtualization and local NVMe drives", operated by exe.dev; 99.9% monthly uptime SLA. | [single tenant](https://exe.dev/docs/enterprise-single-tenant), [BYOC](https://exe.dev/docs/enterprise-byoc), [SLA](https://exe.dev/docs/enterprise-sla) |

Since the August note, exe.dev added pools (a reserved vCPU/memory allotment, $0.105 per 2 vCPU /
4 GiB unit-hour on Work) and standalone VMs billed hourly while running
([pools](https://exe.dev/docs/pools), [standalone VMs](https://exe.dev/docs/standalone-vms)).

Crawshaw on VMs instead of containers, from the Sketch work: "Even almost all of a Linux kernel,
which is gVisor, isn't enough" and "You need to give an agent just a computer"
([High Leverage ep. 11](https://www.heavybit.com/library/podcasts/high-leverage/ep-11-why-agents-need-computers-with-david-crawshaw)).
On speed: "it wasn't really Firecracker or the VMMs that made VMs fast"
([Kubelist ep. 54](https://www.heavybit.com/library/podcasts/the-kubelist-podcast/ep-54-the-age-of-personalized-software-with-david-crawshaw)).

### Tailscale open-source reuse

The public record shows little direct reuse:

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
SSH front door routes on key plus destination IP, unlike Tailscale SSH, an SSH server in each tailnet
node built on `tailscale/gliderssh` and `golang.org/x/crypto/ssh`
([tailssh.go](https://github.com/tailscale/tailscale/blob/main/ssh/tailssh/tailssh.go)). Bold Software
forked `tg123/sshpiper` (an SSH reverse proxy, MIT), with two unmerged branch commits by Josh
Bleecher Snyder (May 2025) and Crawshaw (October 2025, "add ssh cert signature advertising")
([boldsoftware/sshpiper](https://github.com/boldsoftware/sshpiper/branches)). Whether the
production SSH proxy uses it is undocumented.

### Data protection

The lobby is in the US ([regions](https://exe.dev/docs/regions)), California law governs the terms
([terms](https://exe.dev/docs/terms-of-service)), and sub-processors move data out of the EEA under
Standard Contractual Clauses ([sub-processors](https://exe.dev/docs/sub-processors)). The privacy
notice says exe.dev acts as a processor, but publishes no data processing agreement
([privacy notice](https://exe.dev/docs/privacy-notice)). exe.dev operates the hosts in the Frankfurt
region and in Enterprise BYOC. None of this meets "EU infrastructure that we control".

## 2. Comparable open-source projects

Stars, licences, and release dates: GitHub API, 2026-10-12, for each row's linked repository.

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

Details relevant to a coding-agent worker:

- Firecracker has no virtio-fs ([microvm.nix](https://github.com/microvm-nix/microvm.nix)) and
  networks only through TAP devices
  ([network setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md)).
  After a snapshot resume, network connectivity isn't guaranteed and vsock connections close, and
  resuming one snapshot more than once is insecure because randomness and tokens are replicated
  ([snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)).
  After a two-month evaluation, Hocus moved to QEMU: Firecracker never returned guest memory to the
  host (an idle VM kept 32 GB) and didn't reclaim disk
  ([Hocus](https://hocus.dev/blog/qemu-vs-firecracker/)).
- Cloud Hypervisor restores in `copy`, `ondemand` (userfaultfd lazy paging, merged 2026-03-13), or
  `copyonwrite` mode, where clones from one snapshot share page cache
  ([snapshot docs](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md),
  [PR #7800](https://github.com/cloud-hypervisor/cloud-hypervisor/pull/7800)). Snapshots and live
  migration don't work across major versions, released every six weeks
  ([releases](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/releases.md)). It has
  virtio-fs through an external `virtiofsd`
  ([fs docs](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/fs.md)).
- gVisor doesn't support io_uring by default, block-device filesystems such as ext4, KVM inside the
  sandbox, or full iptables ([compatibility](https://gvisor.dev/docs/user_guide/compatibility/)).
  Anthropic's deployment guide measures file I/O heavy work, such as a compiler or `pnpm install`, at
  "up to 10-200× slower"
  ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)).
- Sysbox shares the host kernel, and its README calls it weaker than VMs; Docker sponsors it but
  doesn't officially support it ([sysbox](https://github.com/nestybox/sysbox)).
- Incus has projects confined to a certificate, and a multi-user daemon that creates one project per
  user ([projects](https://linuxcontainers.org/incus/docs/main/explanation/projects/)); OCI images are
  documented for containers only ([instances](https://linuxcontainers.org/incus/docs/main/explanation/instances/)).

### Platforms that give an agent a machine

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

Changes in 2026 that matter here:

- E2B retired its Nomad-based multi-node deployment on 2026-09-10 "ahead of a new deploy path"
  ([commit](https://github.com/e2b-dev/runtime/commit/8a1c4888)), leaving single-node "E2B Embed",
  which needs `/dev/kvm`, hugepages, and Ubuntu 24.04
  ([Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md)). Secret injection is
  documented for E2B Cloud ([docs](https://docs.e2b.dev/secrets/inject.md)), through an
  `orchestrator-ee` that resolves secrets at egress; the open `main.go` wires only the plain TCP
  firewall, so the injecting proxy is not open source
  ([architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md),
  [main.go](https://github.com/e2b-dev/runtime/blob/main/packages/orchestrator/main.go)).
- Daytona moved development private in June 2026
  ([announcement](https://daytona.io/dotfiles/updates/daytona-is-going-closed-source)).
- CubeSandbox (created 2026-04) and OpenShell (created 2026-02) are under a year old.
- Coder's Community edition has no AI Gateway or Agent Firewall and caps Tasks at 1,000 agent
  workspace builds ([Tasks](https://coder.com/docs/@v2.36.3/ai-coder/tasks)).
- Ubicloud is the only open project found that runs Cloud Hypervisor VMs on rented EU bare metal
  (Hetzner) with SSH access and nftables firewalls. It has a Ruby and Postgres control plane, boots
  cloud images rather than OCI, and has no credential proxy
  ([README](https://github.com/ubicloud/ubicloud)).

Hosted or closed products, for reference: Docker Sandboxes (licence not stated) keeps a Claude
subscription session token on the host, "never stored inside the sandbox"
([Docker](https://docs.docker.com/ai/sandboxes/get-started/)), with a host proxy that injects
credentials ([isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)). Fly Sprites,
Modal, Vercel Sandbox, Cloudflare Sandbox, Northflank, Freestyle, Morph, Runloop, and Blaxel are hosted
only.

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

Anthropic's [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway), in the
`claude` binary, keeps the upstream credential (Bedrock, Vertex, Foundry, or an API key)
server-side. With no subscription upstream and "no service-token flow for unattended pipelines", it
doesn't fit unattended workers.

## 3. Components to build

usine needs less than exe.dev sells: the orchestrator is the only SSH client, workers serve no public
HTTPS, and durable work is pushed to GitHub before a worktree is removed (salvage, ADR 0006).

### 3.1 Isolation

| Option | What it gives | Cost of running it | Fit |
| --- | --- | --- | --- |
| A KVM VM rented from an EU cloud, one per Worker | the provider's hypervisor isolates customers; SSH; persistent disk | none beyond the VM; Hetzner Cloud has no nested virtualization ("No, this is not possible on cloud server", [FAQ](https://docs.hetzner.com/cloud/servers/faq/)), so no microVMs inside | good first stage; slow to create, no clones |
| Cloud Hypervisor on rented bare metal | what exe.dev runs; snapshots with CoW restore, live migration, virtio-fs, hotplug | we operate hosts, kernels, and VMM upgrades every six weeks | best match for a later stage |
| Firecracker on bare metal | smallest VMM, fastest documented boot | no virtio-fs; memory is not returned to the host (Hocus); snapshot caveats above | good for short-lived per-Attempt VMs, weaker for persistent Workers |
| Incus VMs (QEMU) | mature API, projects per tenant, ZFS clones, clustering | heavier VMM; no OCI-as-VM | a middle path if we want a product, not code |
| gVisor or Kata containers | container workflow | gVisor's file I/O and syscall gaps slow builds; Kata runs pods or containers, with no documented workspace checkpoint | no fit for a full dev machine |

### 3.2 Image baking and harness logins

- **Rented VM**: a cloud-init user-data file that installs git, Node, `gh`, `claude`, and `codex` on
  Debian at first boot ([cloud-init](https://cloudinit.readthedocs.io/en/latest/)). exe.dev's
  `exeuntu` Dockerfile shows which services to disable in a VM image
  ([Dockerfile](https://github.com/boldsoftware/exeuntu/blob/main/Dockerfile)); its licence is not
  OSI (GitHub reports "Other"), so read it, don't copy it.
- **Our own VMM**: build an OCI image from a Dockerfile, export its filesystem, and write it into an
  ext4 file with `mkfs.ext4 -d <dir>`
  ([mke2fs](https://man7.org/linux/man-pages/man8/mke2fs.8.html)); Firecracker documents the same
  approach with a mounted image ([rootfs guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md)).
  We build the kernel, with the root filesystem driver built in. Per-VM disks are copy-on-write
  clones of that base (LVM thin snapshots, ZFS clones, or qcow2 backing files).
- **Harness logins** stay the operator's task (ADR 0006). Claude Code accepts a one-year subscription
  token from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`, or a `/login` stored in
  `~/.claude/.credentials.json` on Linux
  ([authentication](https://code.claude.com/docs/en/authentication)). Codex accepts
  `codex login --device-auth`, or a copied `~/.codex/auth.json` that it refreshes during use
  ([Codex auth](https://learn.chatgpt.com/docs/auth)). Both put a subscription credential on the VM;
  section 3.4 covers the alternative.

### 3.3 Network reach

usine's `RemoteShell` child host already takes arbitrary SSH client arguments and a destination
(`packages/agents/src/child-host/child-host.ts`), so no option below needs a child host change.

| Option | Notes | Source |
| --- | --- | --- |
| SSH to a public IP, firewall open to the orchestrator only | simplest; Hetzner Cloud firewalls filter inbound and outbound | [Hetzner Cloud](https://www.hetzner.com/cloud/) |
| `ProxyJump` through one bastion into a private network | VMs need no public address; the bastion is the gateway host of stage 2 | [ssh_config](https://man.openbsd.org/ssh_config) |
| sshpiper | SSH reverse proxy that routes by username to many upstreams; needs its own upstream key | [tg123/sshpiper](https://github.com/tg123/sshpiper) (MIT, 1.3k stars, v1.6.1) |
| Tailscale | coordination server in Frankfurt, but "EU data residency guarantee: No, not today" | [EU data sovereignty](https://tailscale.com/resources/eu-data-sovereignty) |
| Headscale | self-hosted coordination server, one tailnet only, supports Tailscale SSH | [headscale](https://github.com/juanfont/headscale) (BSD-3-Clause, 44.6k stars, v0.29.4), [features](https://headscale.net/stable/about/features/) |
| NetBird | WireGuard mesh with a self-hosting guide; management, signal, and relay are AGPL-3.0 | [netbird](https://github.com/netbirdio/netbird) (29.9k stars, v0.80.0) |
| tsnet in the orchestrator | Go only; no Node.js binding exists, `libtailscale` has no releases | [tsnet](https://tailscale.com/kb/1244/tsnet), [libtailscale](https://github.com/tailscale/libtailscale) |

One orchestrator and a few hosts don't need a mesh: a private network with one bastion, or WireGuard
between the orchestrator and each host, is enough.

### 3.4 Credential proxies

exe.dev's design needs no CA in the VM: the VM calls a private hostname over plain HTTP or HTTPS,
and a reverse proxy outside the VM adds the credential and forwards to the real API. Anthropic's
deployment guide recommends this ("run a proxy outside the agent's security boundary that injects
credentials"): `ANTHROPIC_BASE_URL` gives the proxy plaintext requests, while `HTTPS_PROXY` gives it
an opaque tunnel unless it intercepts TLS
([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)). For usine, the
proxy must handle:

- **GitHub.** The orchestrator already mints a one-hour installation token scoped to the attempt's
  repository with `POST /app/installations/{id}/access_tokens` and its `repositories` parameter
  ([REST docs](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app));
  git authenticates with it as user `x-access-token`
  ([installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
  The executor would attach that token to the proxy for the VM and repository, as it attaches an
  exe.dev integration today (`integrations attach --for`), and detach it at cleanup. The VM clones
  `http://git.<gateway>/OWNER/REPO.git`, and the proxy adds `Authorization` if the calling VM has a
  grant for that repository. `gh` needs the REST API on the same host, like exe.dev's
  `GH_HOST=github.int.exe.xyz` ([GitHub integration](https://exe.dev/docs/integrations-github)).
- **Claude Code.** `ANTHROPIC_BASE_URL` points it at the proxy, and `ANTHROPIC_AUTH_TOKEN` is sent as
  `Authorization: Bearer` ([authentication](https://code.claude.com/docs/en/authentication)), so an
  API key stays in the proxy. For a subscription, Anthropic documents only a login that stays on the
  machine, which the gateway forwards with the OAuth capability in `anthropic-beta`
  ([LLM gateways](https://code.claude.com/docs/en/llm-gateway)), not a placeholder swapped for a
  subscription token at the proxy. Docker Sandboxes keeps the session token on the host
  ([Docker](https://docs.docker.com/ai/sandboxes/get-started/)) without saying how.
- **Codex.** A custom `model_provider` with `base_url` points it at the proxy
  ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). For a ChatGPT
  plan, OpenAI documents a gateway that forwards `/responses` and `/models` to
  `https://chatgpt.com/backend-api/codex` with the client's ChatGPT token
  ([gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway)).
  Codex sends `Authorization: Bearer` and `ChatGPT-Account-ID`
  ([source](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/bearer_auth_provider.rs)),
  and exe.dev runs the variant with the ChatGPT account connected to the proxy and no OpenAI
  credential on the VM ([LLM integration](https://exe.dev/docs/integrations-llm)): a working
  precedent the Claude subscription case lacks.
- **Caller identity.** On our own host, the TAP device or private address identifies the VM, if
  nftables drops packets whose source address isn't the one assigned to that interface. On a rented
  VM, the fallback is a per-VM bearer token sent by git (`http.extraHeader`) and the harnesses: a
  credential on the VM, but usable only inside the private network and only for what the proxy
  allows.

The best fit is a small service of our own (git smart HTTP and REST passthrough, streaming LLM
passthrough, and an attach/detach API for the executor), because usine sets the injection rule
(which VM, which repository, until when). superfly/tokenizer has a GitHub App processor but expects
a sealed secret in a `Proxy-Tokenizer` header over plain HTTP, which git and the harnesses don't
send without wrappers. Envoy's injector is alpha and static per route, iron-proxy and
sandbox-runtime need a CA in the VM, and LiteLLM covers API keys only. Anthropic warns that a
gateway must keep up with what Claude Code sends
([LLM gateways](https://code.claude.com/docs/en/llm-gateway)); forwarding headers and streams
verbatim keeps that work small.

### 3.5 Egress policy

Firecracker "does not perform any network traffic filtering" and documents per-TAP nftables rules
instead, including dropping the metadata address
([production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)).
So: the gateway is the VM's only route and DNS resolver, GitHub and LLM hostnames go to the
injecting proxy, and everything else (npm, PyPI, crates, release downloads) goes through an
allowlisting forward proxy such as Squid peek-and-splice or Smokescreen. Domain fronting can evade
an SNI allowlist without TLS interception
([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)), which is
acceptable for package registries when the VM can reach no secret.

### 3.6 Lifecycle

| Operation | Rented VM | Own Cloud Hypervisor host |
| --- | --- | --- |
| Create | provider API, cloud-init, minutes | CoW clone of a base volume plus direct kernel boot; exe.dev reports about 2 s |
| Clone a warm Worker | provider snapshot, then create (minutes) | LVM/ZFS clone of the disk, or Cloud Hypervisor `copyonwrite` restore of a memory snapshot |
| Park | Hetzner bills a server "regardless of whether it is turned on or not" until it is deleted ([billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)); park by snapshot and delete | stop the VMM; only disk space is used on a host already paid for |
| Destroy | provider API | remove the TAP, nftables rules, and volume |

exe.dev's memory ballooning and tiered swap (section 1) suit a hosting business with many idle VMs;
usine's workers are busy or deleted.

### 3.7 Multi-tenancy

- At minimum, one VM per customer worker. Attempts on one exe.dev VM share the machine and its edge
  grants for every repository it runs
  ([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)); per-customer workers limit
  that sharing to one customer.
- On shared hosts, Linux core scheduling keeps two tenants off sibling hyper-threads, as exe.dev does
  per team ([post](https://blog.exe.dev/crossing-the-hyper-thread-boundary),
  [kernel docs](https://docs.kernel.org/admin-guide/hw-vuln/core-scheduling.html)). exe.dev's
  argument for single-tenant hosts, that a hypervisor escape or cache side channel then has no other
  customer to reach, applies to usine too ([single tenant](https://exe.dev/docs/enterprise-single-tenant)).
- The proxy stores every grant per VM, so a customer's VM can't get a grant for another customer's
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
[OVHcloud](https://contract.eu.ovhapis.com/1.0/pdf/OVH_Data_Protection_Agreement-ie.pdf)). Ubicloud's
automation of Cloud Hypervisor hosts on Hetzner bare metal through the Robot API shows the
combination works ([README](https://github.com/ubicloud/ubicloud)).

### 3.9 Effort and running cost

The author's estimates, unsourced except where linked, for one engineer who knows the usine
executor.

| Piece | Build | Running cost | Ongoing operation |
| --- | --- | --- | --- |
| `ssh` Worker kind over a rented VM | 3 to 5 days, reusing the exe.dev executor's SSH paths and the local executor's token handling | 16 to 140 EUR per Worker per month | 1 to 2 h per month per Worker: OS and harness updates, re-login |
| Gateway host with the injecting proxy and egress allowlist | 2 to 3 weeks including tests and a dogfood run | one small VM, 5 to 16 EUR per month | 2 to 4 h per month: allowlist changes, keeping pace with harness API changes |
| Own Cloud Hypervisor host with image pipeline, CoW volumes, and a host agent | 6 to 10 weeks to a first version; Hocus spent two months choosing a VMM ([Hocus](https://hocus.dev/blog/qemu-vs-firecracker/)) | AX102 at 257.30 EUR per host, two for failover | 1 to 3 days per month: VMM releases every six weeks, kernels, disks, capacity |

For sizing, actuated's guide fits 10 jobs of 4 vCPU and 12 GB on a 32-thread, 128 GB host
([actuated](https://docs.actuated.com/provision-server)), which matches an AX102.

## 4. Recommendation

No open project provides an EU-hostable, SSH-reachable, persistent worker with a GitHub and LLM
credential proxy (see section 2): the projects that inject credentials (CubeSandbox, OpenSandbox,
OpenShell, Gondolin, microsandbox) are under a year old or are libraries. The pieces exist
separately and are small enough to assemble. No stage changes the executor seam: credentials are
machine-attached capabilities, and making a worker ready is adapter-specific
([ADR 0006](../adr/0006-executor-contract-run-host-attempt-channel.md)).

### Stage 1: an `ssh` Worker on a rented EU VM

A third worker kind, for any Linux machine reachable over SSH: one VM per customer at Hetzner
(Falkenstein, Nuremberg, or Helsinki), built from a cloud-init file in the repository, with inbound
SSH open only to the orchestrator. Children and harness logins work as on exe.dev. GitHub access uses
the orchestrator's one-hour single-repository token, written for the attempt as on the local worker
and wiped at cleanup.

Compared with exe.dev, a GitHub token is on the VM for up to an hour (the blast radius ADR 0011
accepts for the local worker), egress control is only IP firewall rules, and a worker takes minutes
to create and can't be cloned. In exchange, customer code is on EU infrastructure under the
provider's DPA with no US control plane, and pushes are attributed to the instance's own GitHub App
instead of `exe-dev-github-integration[bot]`
([ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md)).

### Stage 2: a gateway host with the credential proxy and egress allowlist

Worker VMs have no public address and are reachable only through one gateway VM on a private
network. The gateway is the `ProxyJump` bastion (section 3.3), the credential proxy (3.4), and the
egress layout (3.5), with nftables denying everything else. The executor attaches tokens to it
instead of writing them to the VM. API keys and the ChatGPT plan move into the proxy, as in exe.dev's
ChatGPT variant. The Claude subscription login stays on the VM until a test shows that a placeholder
swap at the proxy works and the subscription terms allow it.

Workers are still persistent rented VMs, slow to create. The providers don't document whether their
private networks stop one VM from using another's source address, so each VM also sends the per-VM
gateway token from section 3.4.

### Stage 3: our own Cloud Hypervisor hosts

Only if attempts need their own VM, or the worker count makes rented VMs expensive: two Hetzner AX102
hosts (or a Scaleway Elastic Metal machine for a pilot) running Cloud Hypervisor, an image pipeline
from Dockerfile to ext4, copy-on-write volumes, one TAP and nftables chain per VM, the stage 2 gateway
on each host, and a small host agent that creates, clones, stops, and destroys VMs for the executor.
With clones in seconds, each attempt can get its own VM cloned from a warm worker, separated from
other attempts by a hypervisor instead of a directory. Ubicloud could replace the host side, with
the limits listed in section 2 and an AGPL licence.

We would operate hardware. Disk durability depends on mirrored NVMe and pushes to GitHub, not a
streamed replica, and hosts are drained ([ADR 0023](../adr/0023-graceful-attempt-drain.md)), not
live-migrated.

### exe.dev capabilities that are hard to reproduce

| exe.dev capability | Hard because | Matters for usine |
| --- | --- | --- |
| Anycast edge, global load balancer, SSH routed by key and shared IP | bespoke networking at dozens of sites | no: the orchestrator is the only SSH client |
| HTTPS proxy with login per VM | edge, certificates, auth | not now; previews may want it later |
| Disk streamed to another host, live migration, memory ballooning and tiered swap | storage and VMM engineering at scale | little: work is pushed to GitHub, the cached clone is a cache, hosts can be drained |
| VM creation and `cp` clones in about 2 s | OCI-to-block pipeline and CoW storage | only for per-Attempt VMs (stage 3) |
| 100+ integrations, an OIDC issuer, ChatGPT subscription brokering | a product team's backlog | only GitHub and the two harnesses matter; brokering a Claude subscription is the one part with no documented precedent |

## Verdict

usine can replace exe.dev with an EU worker it controls without building exe.dev. Stage 1 takes a few
days and stage 2 a few weeks; together they match exe.dev's integrations for everything usine uses
except the Claude subscription, which needs a test. Stage 3 is worth building only when per-attempt
VMs or worker density justify operating hardware.
