# Worker kinds: the customer's own server, or one machine per attempt in the customer's cloud

usine runs a customer's attempts in one of two ways, decided on 2026-10-25 ([#552](https://github.com/basaltbytes/usine/issues/552)):

- **Bring your own server**: the `ssh` worker kind on a long-lived machine that the customer provides, with each attempt in its own container from a baked image ([#548](https://github.com/basaltbytes/usine/issues/548)).
- **Bring your own cloud**: one machine per attempt in the customer's cloud account, created for the attempt and deleted after it. The `ssh` kind gets a provisioner with a Hetzner Cloud driver and a Boat driver ([#550](https://github.com/basaltbytes/usine/issues/550)), and a Cloudflare Sandboxes worker kind runs each attempt in a sandbox of its own ([#551](https://github.com/basaltbytes/usine/issues/551)).

The `exe.dev` kind stays: it's built, and it shares its checkout, child, salvage, and reattach code with the `ssh` kind ([ADR 0026](./0026-eu-ssh-worker.md)). usine adds no other adapter until a customer asks for one. AWS has a single role, the host of a self-hosted Firecracker stack, and usine doesn't build that stack. Owned or rented bare metal is out. EU residency is a property of each adapter, so the customer chooses it by choosing the adapter.

Two research notes compare the options: [`agent-sandboxes.md`](../research/agent-sandboxes.md) for the self-hosted stages (section 4), and [`hosted-sandboxes.md`](../research/hosted-sandboxes.md) for the hosted providers and the primitives under them (sections 1, 2, and 6). The `ssh` worker as built runs every attempt on its machine as one Unix user, so concurrent attempts can read each other's GitHub token ([#231](https://github.com/basaltbytes/usine/issues/231)) or caller token ([#243](https://github.com/basaltbytes/usine/issues/243)), and a worker's capacity is one machine's. The operator ranks providers Hetzner, then Cloudflare, then AWS, and refuses bare metal, owned or rented.

A customer's own server needs no provider API, and it's the path usine runs today. A container per attempt removes the shared-user exposure: it mounts only that attempt's checkout and credential directory, plus the repository cache read-only and the harness logins read-write (amendment of 2026-10-25), and the executor still reaches the machine over SSH.

One machine per attempt puts a hypervisor between attempts and removes the one-machine ceiling. Hetzner Cloud servers have no nested virtualization, so on the operator's first provider that boundary is one Cloud server per attempt (`hosted-sandboxes.md`, section 5). Such a server is still a machine reached over SSH, so the adapter is a provisioner on the `ssh` kind, not a new kind, and the child host and the gateway stay as they are. Boat sells EU-only VMs with plain OpenSSH and both harnesses preinstalled, at the lowest price of the hosted providers, so the same provisioner takes it as a second driver (section 6, path (a)). Cloudflare, the operator's second provider, has the best credential model of the hosted set: outbound handlers that run outside each sandbox's microVM add the credentials to its requests, which is ADR 0027's attach and detach as a platform feature (section 2, "Fit for usine"). The adapter reaches each sandbox through the Sandbox SDK's exec API, not over SSH: Cloudflare's SSH path is `wrangler containers ssh`, an OpenSSH `ProxyCommand` that uses the account's credentials (section 2, "Orchestrator access"). So Cloudflare Sandboxes are a worker kind of their own.

AWS offers `/dev/kvm` without bare metal, through nested virtualization on its virtual instances, which makes it the host for a self-hosted Firecracker stack such as E2B Embed (section 5, "AWS", and section 6, path (b)). Without bare metal, Hetzner has no microVM path, and the Cloud Hypervisor hosts of `agent-sandboxes.md`'s third stage aren't built.

Every adapter is code that usine tests and keeps in step with a vendor's API, limits, and prices, and the vendors' own pages often disagree on those (`hosted-sandboxes.md`, "Conflicts between vendor pages"). So the set has only the adapters for the operator's providers, plus Boat, and a new adapter waits for a customer who needs it.

Harnesses on a machine created for one attempt authenticate in one of two modes ([#549](https://github.com/basaltbytes/usine/issues/549)). The subscription mode is the default: the gateway stores the Claude or ChatGPT session and sends it upstream in place of each machine's caller token ([#234](https://github.com/basaltbytes/usine/issues/234), [#235](https://github.com/basaltbytes/usine/issues/235)). API keys are the alternative, in the same provider entries on the gateway, as a gateway's Anthropic provider already takes either an API key or a subscription token. Subscriptions are the default because usine's own instance runs on the operator's Claude and ChatGPT plans ([ADR 0027](./0027-gateway-credential-proxy.md), amendment of 2026-10-15), and the operator won't move to per-token billing while a subscription is available. The gateway stores the session because a machine created for one attempt can't keep one of its own: an image or snapshot contains one refresh token, and the first machine that refreshes it invalidates it for the others.

_Note, 2026-10-25 ([#550](https://github.com/basaltbytes/usine/issues/550)):_ the `ssh` provisioner and its Hetzner Cloud and Boat drivers are in `packages/executor/src/ssh/provisioner/`, and [Add a provisioned worker](https://docs.usine.dev/guides/add-a-provisioned-worker/) describes their setup. [ADR 0027](./0027-gateway-credential-proxy.md), amendment of 2026-10-25 (#550), records how their machines authenticate the harnesses and why the executor knows each machine's host key before it connects.

## Considered options

- **Hosted sandboxes in place of the `ssh` worker**: the question `hosted-sandboxes.md` started with, which the research turned into finishing the self-hosted worker with the vendors' primitives. A customer's own server needs no vendor, and the hosted providers that fit are adapters of the second path.
- **Cloud Hypervisor hosts that usine operates** (`agent-sandboxes.md`, stage 3): needs bare metal, and usine would operate hardware, 1 to 3 days per month by the note's estimate (section 3.9).
- **A self-hosted Firecracker stack on AWS** (E2B Embed, `hosted-sandboxes.md`, section 6, path (b)): no bare metal, but it's one node by design, Firecracker is untested under nested virtualization, children need a new child host over `envd`, and it costs more per attempt-hour than Boat or Northflank.
- **Kata Containers with Cloud Hypervisor on Kubernetes** (same section): usine would operate Kubernetes, children would run through the Kubernetes API, and egress rules are L3 and L4 only.
- **Northflank**, second in the hosted shortlist (section 6, path (a)): a UK company whose terms process data in the UK, with egress policies documented only for its bring-your-own-cloud clusters and no documented reattach.
- **An adapter for each provider in the comparison** (Fly, E2B, Daytona, Modal, Vercel, Blaxel): each needs a driver or a child host of its own, and their terms, limits, and prices differ (section 1).

## Consequences

- **Isolation by path.** On the customer's own server, attempts share the host's kernel, so the boundary between them is a container, not a hypervisor. A kernel escape reaches the other attempts on that machine, which ADR 0026's one worker per customer limits to one customer. A machine per attempt puts a hypervisor between attempts: Hetzner's hypervisor, Boat's VM, or the Firecracker microVM of each Cloudflare Sandbox.
- **No egress control on Boat.** Boat has no network rules, so no gateway can be its machines' only way out. The installation token is on the machine, as in ADR 0026's first stage, and egress control is an in-VM firewall that root can undo, applied again after every resume (`hosted-sandboxes.md`, section 6, path (a)).
- **No EU placement on Cloudflare today.** The EU jurisdiction works only under the `default` scheduling policy, which the Sandbox SDK 1.0 doesn't use, and Cloudflare has announced no timeline for placement under the `durable_object` policy. The Durable Object ID is logged outside the jurisdiction in either case (section 2, "EU placement guarantees").
- **EU residency per adapter.** Hetzner servers are in Falkenstein, Nuremberg, or Helsinki under Hetzner's data processing agreement (ADR 0026). Boat's machines are in Germany, Finland, and France, but its snapshot copies can leave the EU and no agreement was found (`hosted-sandboxes.md`, section 1). exe.dev's control plane is in the United States (ADR 0026), and a customer's own server is wherever the customer puts it. This replaces ADR 0026's rule that customer attempts run on EU machines that usine controls.
- **Machine lifecycle per attempt.** An attempt waits for its machine to be created and reachable over SSH, and Hetzner documents no creation time (section 5). The cached clone lasts one attempt, and Hetzner bills every started hour that a server exists. The provisioner deletes the machine when the attempt's checkout is released, keeps it while a parent task's stop is unconfirmed, and deletes orphans that it finds by label at reconcile (#550).
- **The executor contract stays fixed.** [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md) applies to every kind: preflight with typed capability errors, scoped preparation that returns a `PreparedAttempt`, two-stage cancellation, credentials that never enter a RunSpec or the attempt channel, the Pi parent as a durable task in the orchestrator, and reattach. A kind changes only how it finds or creates a machine, how children reach it, and where credentials attach.
- **Cost of each adapter.** A driver for the `ssh` provisioner needs a provider API client, an image, labels for orphan cleanup, and a preflight of the provider credential and quota; the child host, checkout, salvage, and gateway code don't change. A kind that isn't reached over SSH needs a child host over the vendor's exec API that streams stdin and lets a restarted orchestrator reattach (`hosted-sandboxes.md`, "Requirements"), and its own credential attachment. For Cloudflare, that also means a Cloudflare Worker that usine publishes and the customer deploys, with a keepalive alarm, since code inside an instance doesn't count as activity (section 2, "Lifetime").
- **Harness authentication.** The gateway stores the session for every per-attempt machine behind it, which needs the check of the Claude subscription token against Anthropic (#234) and a ChatGPT login with token refresh (#235). On Cloudflare, the outbound handlers in usine's Cloudflare Worker attach the credentials instead of a gateway (#551). A gateway that has a provider's credential doesn't list that provider's hosts in its forward proxy (ADR 0027, amendment of 2026-10-15), so a long-lived worker behind it uses that credential too. A long-lived worker without a gateway, or behind one without that provider's credential, keeps its logins on the machine.

## Amendment (2026-10-25, #548): the harness logins are mounted read-write

A container mounts the SSH user's Claude Code and Codex login files read-write, not read-only. The harnesses rewrite those files when they refresh an OAuth token, and with the operator's subscriptions a refresh that can't be saved may leave every later attempt with a revoked login. Read-write mounts of the same files keep the sharing that attempts had as one user, and the Claude login lock still serializes Claude starts on the worker ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md), amended 2026-10-25).

## Amendment (2026-10-28, #647): Boat gateway credentials

Boat workers can use the gateway over a Tailscale tailnet as described in ADR 0027's amendment for #647. Their GitHub and harness credentials stay on the gateway. The consequence above about a token on each Boat machine applies only to workers without a gateway; Boat's direct internet access remains unchanged.

## Amendment (2026-11-01, #802): bounded machine reuse

A provisioned SSH worker can enable `provisioner.reuse: { attempts: 5, max_age: 2h }`.
Both limits are required. The attempt limit includes the first attempt. The age limit starts
at machine creation; an active attempt can finish after that limit. Without this setting,
the provisioner deletes the machine after each attempt.

Reuse requires Docker. Each attempt gets its own container and checkout. Before making a
machine idle, the executor checks cleanup results, sweeps leftover containers, and removes
attempt checkouts, credential directories, Codex homes, and gateway configuration files.
Container removal includes anonymous volumes. The attempt image, shared pnpm and Turbo
volumes, and host caches remain. A failed cleanup or gateway detach retires the machine.
Checkouts retained for salvage or reattachment remain on their original machine and prevent reuse.

A new attempt atomically claims an idle machine of the same worker, updates its provider
identity and attempt count, and runs preflight. Assignment or preflight failure retires the
machine. Machines retire at either limit, when their worker connection is removed, or when
the orchestrator stops while they are idle. An age timer never interrupts an active attempt.
Connection revisions apply live as described in ADR 0031. An active attempt keeps its original
connection; idle machines with the previous connection retire.

Provider labels (Hetzner) or the sandbox name (Boat) identify the current attempt and its
machine's attempt count, so restart recovery uses the correct machine. Startup reconciliation
deletes idle machines left by a crashed process. Machines created by releases without an
attempt count are recovered but not reused.

The executor records acknowledged machine creations by worker, provider, and UTC day in
`machine-starts.json` under the persistent SSH host-key directory. Counts include machines
whose readiness or preflight later fails, and survive machine deletion and orchestrator
restarts. A provider creation whose response is lost cannot be counted from that response.
The overview and worker page show assigned attempts and machine age; statistics show daily
starts. These records contain no credentials.

## Amendment (2026-11-01, #808): mutable Boat SSH endpoints

An unanswered SSH liveness probe on a Boat machine triggers `GET /sandboxes/<id>`.
The executor tries the reported endpoint and retains the previous working endpoint,
because either address can be temporarily unreachable. A successful connection updates
a per-machine OpenSSH config file through an atomic rename. Attempt shells retain the
config path, so later child, harvest, and cleanup commands use the selected endpoint.
The existing machine alias in `known_hosts` pins the same host key across address changes;
reconnection does not trust a new key from the SSH server.
Liveness watches use the machine ID, so sandboxes with the same SSH host and different
forwarded ports have independent probes and failure handling.

A 404 or terminal sandbox state drains the durable session as a retryable infrastructure
failure. The engine can start a new attempt on a fresh machine from the latest pushed
salvage. A running sandbox with no reachable endpoint continues to produce the existing
unresponsive-worker notices. An unavailable provider API is logged and does not prove
machine loss.

The [Boat create API](https://docs.boat.dev/api/reference/sandboxes/create-sandbox), checked
on 2026-11-01, defines `ttlSeconds: null` as disabling auto-stop. The driver already sends
that explicit setting. Omitting the field applies the one-hour default; trial accounts
require an auto-stop of at most two hours and cannot use this worker lifetime.

## 2026-11-09: boxd provisioner

boxd is a third driver of the SSH provisioner because its Linux VMs fit the existing machine lifecycle interface; they were reached through SSH until #1124. Its memory-and-disk snapshots preserve the pulled attempt image, avoiding a download on each restore. The snapshot also fixes the machine size, so the configured size is a preflight assertion instead of a restore override; resizing would discard the captured memory state.

boxd uses gRPC. A client port isolates its transport and decoded responses from the driver. The generated client retains the proxy host key and serving-region metadata that the SDK's public methods discard. Regional endpoints and the region setting keep machines and snapshots in the operator's selected location, including Frankfurt for EU placement. Tailnet joins use the same gateway bootstrap as Boat machines because boxd's own Tailscale integration enrolls its proxies instead of the machines.

boxd regions are discovered, not enumerated: the region setting is a region id that `ListRegions` resolves to its API endpoint. A fixed list of hosted regions would prevent a usine worker from running on a boxd deployment in the operator's own cloud account and region.

## 2026-11-10: boxd account-linked SSH keys (#1121)

The boxd SSH proxy terminates SSH and authenticates keys linked to the account, so it does not read the machine's `authorized_keys`. Baking a worker public key into a snapshot cannot authorize the worker. boxd fences API keys from account changes, including `LinkSshKey`, so linking requires an operator's signed-in session. The operator script uses device id `usine:<worker name>` to replace the previous key after rotation. Preflight reads the public key next to `identity_file` and checks its SHA-256 fingerprint against `Whoami`'s linked fingerprints using the worker's API key. Snapshot preparation uses the boxd CLI's linked device key and saves only the runtime, attempt image, and Tailscale setup.

## 2026-11-10: boxd's exec stream instead of SSH (#1106)

For boxd machines, boxd's gRPC `Exec` stream fits better than SSH through boxd's proxy ([`boxd-exec-transport.md`](../research/boxd-exec-transport.md)). The proxy accepts only SSH keys linked to the boxd account, and boxd refuses to link a key for an API key, so SSH needs a step from a signed-in session for every account (#1121), which a customer's own boxd account would repeat. `Exec` authenticates with the API key that the driver already holds. It reaches the same in-machine agent that the proxy uses, so a dropped stream ends a command the way a dropped SSH session does, and the child host's process owner, which runs in its own session, survives either. `Exec` reports a failed call or a deleted machine as a gRPC status instead of exit code 255, and it addresses a machine by id, so the proxy's host key, its changing ports, and `SendEnv` no longer concern boxd workers. The Cloudflare worker kind already runs its commands through a program that stands in for `ssh` over a vendor's exec stream, so the child host stays as it is.

## 2026-11-10: boxd workers run commands over `Exec` (#1124)

boxd workers use the `Exec` stream recommended above, with no SSH fallback, and the account-linked key step of #1121 no longer applies to them. A second transport for one provider would keep the operator step and double the boxd test matrix for a path that no measurement needed.

The child host gains a third host, `ExecShell`, which runs each command line through a transport in the orchestrator process instead of through a local program. The entry above kept the child host as it was because the Cloudflare kind already reaches a vendor's exec stream through a program that stands in for `ssh`. For boxd, that seam costs a process and a TLS connection for every command (261 ms against 72 ms on a warm connection, where one connection carried 200 concurrent streams), puts the API key in the environment of every child process, and needs an OpenSSH argument parser and exit code 255 to encode a gRPC status that callers then decode again. Callers already work with a process handle, so the exec shell gives them one, served by one HTTP/2 connection per worker, and reports a lost command as a typed `HostUnreachable` instead of an exit code. `RemoteShell` stays for SSH. The executor's `RemoteCommands` maps an SSH client's exit code 255 to the same `HostUnreachable` in one place, so its callers handle one failure convention for both hosts instead of comparing exit codes with 255. The Cloudflare sandbox shell keeps its program here; its exec WebSocket, with its reattachment to a running command, fits the same transport port and would drop its argument parsing and exit code mapping.

The adapter keeps connect-node, already the boxd transport, and raises the HTTP/2 connection window on each session itself, because connect-node never does and grpc-js would be a second gRPC stack for one call. A boxd worker ignores `identity_file`, which earlier releases required, instead of refusing it, so a stored worker still loads after an upgrade.

## 2026-11-10: boxd egress allowlist

A boxd machine restored from a snapshot starts with unrestricted egress. `provisioner.egress` gives each machine an allowlist that boxd enforces itself, admitting HTTP and HTTPS by host name and other traffic by address. The driver applies it with `SetVmEgressAllow` after the restore instead of through the machine spec that `CreateVmFromSnapshot` accepts. A spec can't be combined with the request's `labels` and `isolated` fields, so it would change the create request that the 2026-11-09 spike verified. The driver then waits one second, the time boxd states the list takes to come into force, before it connects to the machine. Only the snapshot's own resumed processes run without the list, and no attempt process starts before the list applies. If boxd refuses the list or reports it empty, the driver deletes the machine instead of running an attempt with unrestricted egress.

_Note, 2026-11-11 ([#1103](https://github.com/basaltbytes/usine/issues/1103)):_ an evaluation measured the spec path that the reason above set aside ([`boxd-attempt-machine-sources.md`](../research/boxd-attempt-machine-sources.md)). `CreateVmFromSnapshot` accepts a spec that carries `isolated`, the labels, and the allowlist from a member API key, and its response already reports the allowlist in effect. The machine answered its first `exec` after a median of 692 ms, against 575 ms without a spec. With the list applied after the restore, a resumed process reached an address outside the list about a second after creation in three of three restores; with the list in the spec, in one of four, for about 0.15 s. The owner decides whether the driver moves to the spec.

_Note, 2026-11-11 ([#1119](https://github.com/basaltbytes/usine/issues/1119)):_ the driver now sends the allowlist, the labels, and `isolated` in the spec of `CreateVmFromSnapshot` and no longer calls `SetVmEgressAllow` on a new machine. The reason above for keeping the spiked request no longer holds: the evaluation ran the spec request with the same member API key and found the labels and isolation applied as with the request fields. The spec closes two gaps of the call after the restore: the second in which the machine ran without its list, and an interruption between the restore and the cleanup region, which left an unrestricted, labelled machine until the restart sweep. The one-second wait stays, counted from the create response, because the spec didn't close the window in every restore; it goes when boxd answers question 23 of the evaluation. The driver still checks that the allowlist in the create response isn't empty and deletes the machine otherwise. A reused machine gets its list again with `SetVmEgressAllow`.

The gateway's `egress-allowlist` and `provisioner.egress` are one list with two enforcement points: the gateway's forward proxy for Hetzner workers and boxd for its machines. `infra/boxd/egress.mjs` renders the gateway file as `provisioner.egress`, so the hosts are maintained in one place. The lists differ only where the paths differ. boxd machines reach the gateway over Tailscale, so the boxd list adds `*.tailscale.com` for the coordination and DERP relay servers. Like the gateway's list, it must not admit GitHub or the API and login hosts of a provider whose credential the gateway holds, and configuration validation enforces that rule. The gateway itself remains the only path for git and model traffic.

## 2026-11-11: boxd machines are single-use, with SSH off and an optional size (#1114)

A restore keeps its snapshot's size, and boxd refuses a size on a restore, so `provisioner.size` only repeats what the snapshot fixes. It is optional and takes any `<vcpu>x<GiB>` size, since a self-hosted cluster offers the sizes its operator lists, such as `1x32`. When set, it stays the preflight assertion of the 2026-11-09 entry, now on memory as well as vCPUs; preflight logs the snapshot's size either way.

Machine reuse, from the 2026-11-01 amendment, exists for providers whose creates take minutes. A boxd restore takes under a second, so a boxd worker ignores `provisioner.reuse`, and every attempt gets a new machine. Reuse would keep the reset and the reassignment for a cost that boxd doesn't have. The boxd driver therefore has no `assign`, which `MachineDriver` makes optional, and the boxd client drops the label update that only reassignment used. Earlier releases accepted `reuse` on a boxd worker, and every write reads the stored configuration first, so refusing the setting at load would stop an upgraded instance from starting and leave no way to remove the setting in the product. The configuration therefore still loads it, as it loads `identity_file`, and preflight warns that it has no effect and names the worker.

Machines are created with SSH off. Commands run over `Exec` since #1124, and boxd's sandboxes guide recommends SSH off for untrusted code.
