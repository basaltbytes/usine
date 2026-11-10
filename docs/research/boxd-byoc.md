# boxd in the operator's own cloud account

Research for [issue #1105](https://github.com/basaltbytes/usine/issues/1105): what the boxd driver
needs to provision EU workers on a boxd deployment that runs in the operator's own cloud account,
instead of boxd's hosted service. Snapshot date: 2026-11-10. Claims cite boxd's documentation, the
self-host installer repository at commit `744ee0a`, the `@boxd-sh/sdk` 0.3.0 package from npm, boxd's
published terms, and the usine source. Facts that no public source states are marked "not
documented" and listed under [Questions for boxd](#questions-for-boxd).

The repository doesn't install `@boxd-sh/sdk`. usine has a projection of its 0.3.0 proto in
`packages/executor/src/ssh/provisioner/boxd/proto/api.proto`; SDK behavior below comes from the
`dist/` files of the npm tarball ([sdk]).

## Deployment shapes

boxd publishes three ways to run its machines:

- **Hosted.** Two regions, Frankfurt (`fra`) and New York (`nyc`), with one account plane
  ([regions]).
- **Self-hosted.** The `boxd-install` installer builds a cluster in an AWS account, a Google Cloud
  project, or on prepared Ubuntu 24.04 hosts with KVM. It's free up to 16 worker vCPUs, and a
  licence key lifts the limit ([self-host README], [self-hosting]).
- **A deployment in the operator's own cloud account, operated by boxd.** boxd operates the cluster
  inside the customer's cloud account, and "The machines and the data stay in your account"
  ([self-hosting]). The pricing page lists it under the Scale plan ([pricing]). No public page
  describes its endpoints, accounts, or terms.

A self-hosted cluster runs "the same release as boxd cloud", from a bundle that boxd signs
([self-hosting], [self-host README]). On AWS, workers need C7i, M7i, R7i, C8i, M8i, or R8i instances
with nested virtualization, or any `.metal` type; the install guide uses `eu-central-1` as its AWS
example ([self-host README], [install]).

## 1. API endpoints

**Hosted.** Account, org, API key, env var, and billing calls go to `boxd.sh:9443`, which is also
Frankfurt. Calls on machines, snapshots, and disks go to the endpoint of the machine's region.
`ListRegions` on `boxd.sh:9443` lists each region with `id`, `name`, `zone`, `api_endpoint`,
`console_endpoint`, `home`, and the org's `org_state` ([grpc-api], [regions]). The proto documents
`ListRegionsResponse.this_region` as "The region this endpoint serves; "" when boxd runs in one
place" ([proto]).

**Self-hosted.** One installer cluster runs "in one zone of one region" of the cloud
([self-host README]). The proxy node serves the API on TCP 9443, HTTPS on 443, and per-machine SSH
on 10000 to 30000; `app.<zone>` serves the console ([install], lines 596-606;
[self-host README]). The SDK's `deriveExchangeUrl` comment states the rule: "A deployed cluster's
API lives at `<zone>:9443` and its console at `https://app.<zone>`" (`dist/utils.js`, [sdk]). The
SDK selects a cluster with `baseURL` (`BOXD_BASE_URL`), for example
`new Boxd({ baseURL: "https://boxd.example.com:9443" })` ([typescript-sdk]). The self-host
documentation has no boxd regions. What `ListRegions` returns on such a cluster is not documented.

**Operated by boxd in the operator's account.** Not documented. Two shapes fit the public material:

- a separate cluster with its own zone, console, accounts, and API keys, as a self-hosted cluster
  has; or
- an extra region that `ListRegions` on `boxd.sh:9443` lists, with accounts and keys shared with the
  hosted service, as `nyc` is.

The usine guide states that "a boxd deployment in your own cloud account has its own id"
(`apps/docs/src/content/docs/guides/add-a-boxd-worker.md`), which assumes the second shape.

**usine today.** `grpc-client.ts` fixes the account endpoint at `https://boxd.sh:9443` (`BOXD_API`).
`settings.providerEndpoints.boxd` replaces it, but only tests set it, and it also skips the region
lookup (`packages/executor/src/ssh/model.ts`, `drivers.ts`). Three checks fail on a cluster that
runs in one place:

- `regional` fails with `BoxdUnknownRegion` when `ListRegions` lists no region with the configured
  id.
- `regional` fails when the matching region has an empty `api_endpoint`. The SDK accepts an empty
  endpoint for the region that equals `this_region` (`dist/_regions.js`, [sdk]).
- `verify` in `boxd.ts` compares `this_region` with `provisioner.region` and fails on `""`.

The SDK handles one-place clusters: with no region set, every call goes to the base URL, and a
named region missing from `ListRegions` fails with "this boxd runs in one region"
(`dist/_regions.js`, [sdk]).

The driver needs a per-Worker account endpoint ([draft 1](#draft-1)) and a one-place mode
([draft 2](#draft-2)). Region discovery from #1090 covers the second shape above unchanged.

## 2. Authentication

**Hosted.** An API key is exchanged for a one-hour JWT at `https://app.boxd.sh/api/v1/auth/token`,
rate-limited per source IP, and the JWT is a bearer token on every gRPC call. The same token works
in every region ([grpc-api]).

**Exchange URL on other clusters.** The SDK never takes an exchange URL: it derives
`<console>/api/v1/auth/token` from `baseURL`. The console is `https://app.<host>`, with the port and
path dropped; a `localhost`, IP literal, or `app.` host is used as given (`deriveExchangeUrl` and
`consoleBaseUrl` in `dist/utils.js`, [sdk]). A self-hosted cluster serves its sign-in callbacks
under `https://app.<zone>/api/v1/auth/` ([reference], "Single sign-on"), which is consistent with
that rule. The exchange path on a self-hosted cluster is not documented by the installer.

**API key as bearer.** SDK 0.3.0 sends the API key itself as the bearer when the endpoint uses TLS or
a loopback address. It switches to the exchange when a server answers "invalid token" or "accepted
over TLS only", which is what releases from before raw keys answer (`refusesRawKey` in
`dist/auth.js`, `rawKeyAllowed` in `dist/utils.js`, [sdk]). The gRPC reference documents only the
exchange ([grpc-api]).

**Accounts on a self-hosted cluster.** People sign in with Google, GitHub, or OIDC on `app.<zone>`,
and the first person to sign in owns the cluster's org ([self-host README]). API keys exist there:
suspending a user refuses their "CLI logins, SSH keys, API keys and console sessions"
([operations], line 163). The cluster has its own accounts and orgs, so an API key from the hosted
service has no account there, and the operator creates the Worker's key on the cluster.

**TLS.** A cluster with private ingress on AWS requires a certificate from the operator's own CA
([install], "Private ingress on AWS"). Node.js then needs that CA, for example through
`NODE_EXTRA_CA_CERTS`, for both the gRPC transport and the token exchange.

**usine today.** `grpc-client.ts` posts to the fixed `https://app.boxd.sh/api/v1/auth/token`, and
the preflight messages in `boxd.ts` mention `app.boxd.sh` and `boxd.sh:9443`. Deriving the exchange
URL from the configured endpoint, with the SDK's rule, is part of [draft 1](#draft-1).

## 3. SSH proxy and exec agent

**Hosted.** Every machine SSH connection ends at the proxy, which presents one host key:
`ListVmsResponse.ssh_host_key` is "the OpenSSH public-key line of the proxy's SSH host key" and "All
VM SSH connections terminate at the proxy and present this key" ([proto]). Each machine has its own
port in 10000 to 30000 on the shared proxy IP, and each region has its own address, port, and host
key ([commands], "Editor and SSH integration").

**Self-hosted.** The shape is the same:

- `[proxy]` in `cluster.toml` sets `ssh_port = 2222` and
  `host_key = "/etc/boxd/tls/proxy_host_ed25519"` ([aws example], lines 216-221).
- The installer copies that one key file to every proxy node
  (`ansible/roles/boxd-proxy/tasks/main.yml`, lines 75-78, [self-host repo]).
- An iptables rule redirects ports 10000 to 30000 to the proxy's SSH port
  (`ansible/roles/boxd-proxy/templates/boxd-ssh-redirect.sh.j2`, [self-host repo]).
- Only boxd can connect to the in-machine agent port, 57073 ([aws example], line 202).

Because the release is the same, sshd configuration inside the machine has no effect and `SendEnv`
is ignored there too, as #1101 found on the hosted service; #1107's stdin transport covers both. The
self-host documentation doesn't state this; it follows from the shared release.

**Address.** The driver connects to `boxd@<GetVm.public_ip>` on `GetVm.ssh_port`. With private
ingress, proxy nodes have no public IP and "the cluster advertises their private IPs wherever it
would advertise the Elastic IPs: the DNS records, and the proxy IP the CLI and console show"
([install], "Private ingress on AWS"). The usine host then needs a route into the VPC and a place in
`ingress_cidrs`, which limits the proxy ports. Whether `GetVm.public_ip` returns the private proxy IP
is not documented.

No driver change is needed: `sshHostKey` reads `ssh_host_key` from the client of the configured
region and pins it per Worker.

## 4. Snapshots and the attempt image

**Hosted.** A snapshot is saved in its machine's region, and machines created from it start there
([regions]). `verify` checks the snapshot's region and captured size against the provisioner.

**Snapshot builder region.** `infra/boxd/build-snapshot.sh` has no region option, so
`boxd machine new` uses the CLI's order: `--region`, `BOXD_REGION`, `boxd config set region`, the
org's default region, then the closest region ([regions]). The script then connects to
`$machine.boxd`. That alias exists only for Frankfurt machines; a machine in another region is
`<machine>.<region>.boxd` ([commands], "Editor and SSH integration"). A build that the CLI places in
`nyc` waits for an alias that doesn't resolve ([draft 4](#draft-4)).

**CLI on a self-hosted cluster.** `https://app.<zone>/downloads/install.sh` serves a CLI already set
to the cluster. It installs `boxd` into `~/.local/bin` and replaces "any `boxd` CLI already there for
another boxd service" ([reference], "The CLI your users install"). The hosted CLI has a hidden
`--api-url` flag (`BOXD_API_URL`, default `https://boxd.sh`) ([commands], "Global flags"); whether
it works against a self-hosted cluster is not documented. The SSH alias that the cluster's CLI writes
is not documented either.

**Machine sizes.** A self-hosted cluster offers 1 vCPU with 4 GiB, 2 with 8, and 4 with 16 by
default. The operator can replace the list, for example with 1 vCPU and 32 GiB, and the API rejects
other sizes ([reference], "Machine sizes"). usine's `BoxdSize` accepts only `1x4`, `2x8`, `4x16`,
and `8x32` (`packages/core/src/worker.ts`), and `verify` expects 4 GiB per vCPU. The builder passes
only `--vcpu`, and the CLI documents `--vcpu` for the four hosted sizes alone ([commands])
([draft 3](#draft-3)).

**Snapshot storage on a self-hosted cluster.** A snapshot's disk and memory images are on the
workers' data disks, often on several workers ([operations], "Snapshot archive"). Snapshots move
only between hosts with the same CPU model, so all workers of a cluster use one instance family
([install], line 357). An operator can archive a snapshot into a bucket; creating a machine from it
is then refused until it's unarchived ([operations], "Snapshot archive"). How `GetSnapshot.status`
reports an archived snapshot is not documented; `verify` accepts only `ready`.

**Attempt image.** The builder pulls the attempt image from `ghcr.io` and downloads the Tailscale
installer from `tailscale.com` inside the temporary machine. Machines need outbound access to both.
With private ingress, outbound traffic still leaves through the NAT gateway ([install], "Private
ingress on AWS"). `ATTEMPT_IMAGE` replaces the image; the Tailscale installer URL is fixed.

## 5. Data processing terms

**Hosted service.**

- The customer selects the cluster, "currently the European Union and the United States". Where
  boxd processes personal data as a processor, "the parties will enter into a Data Processing
  Agreement before such processing takes place". Sub-processors are in the privacy policy or the
  DPA. Dutch law governs the agreement ([terms], articles 2.5, 4.2, 8.2, 8.3, 18.1).
- boxd "does not have, and does not exercise, access to the content, configuration or activity
  within a Customer's Virtual Machine", and monitors network and infrastructure patterns for abuse
  ([terms], articles 4.3 and 4.4).
- In the EU cluster, the machine infrastructure stays in the EU/EEA, while some account and billing
  data is processed outside it, for example by Stripe in the United States. Bare-metal servers for
  both clusters come from Latitude.sh LLC, a United States company, under Standard Contractual
  Clauses ([privacy], sections 6 and 7).
- A machine's disk, memory, snapshots, checkpoints, and backups are stored in its region. Account
  and org data, "such as members, API keys, secrets and integrations", is kept in every region the
  org uses ([regions], "Where your data lives").
- The FAQ places machines on bare-metal servers in Germany, keeps backups in EU object storage, and
  offers a DPA on request ([faq]). The pricing page lists the DPA as available, and SOC 2 Type II
  and ISO 27001 as in progress ([pricing]).

**Self-hosted cluster.**

- The installer state, with TLS keys and provider secrets, is encrypted in a bucket the operator
  owns, under a key that only the operator has ([self-host README]).
- Each cluster sends boxd one report an hour with counts and no personal data. Free-tier clusters
  can't turn it off; a licence key with telemetry opt-out can. A key with usage billing adds a report
  every 5 minutes with each host's instance type, region, and uptime ([reference], "Telemetry").
- The binaries are under the PolyForm Internal Use License 1.0.0 with boxd's additional terms, which
  permit "the internal business operations of you and your company" ([binary license]). An EU
  customer that runs a cluster for its own usine instance fits that text.

**Operated by boxd in the operator's account.** The self-hosting page states that machines and data
stay in the operator's account ([self-hosting]). The DPA scope, boxd's access to the account, the
sub-processors, and telemetry for this shape are not published.

**Conflicts between boxd pages.**

- The FAQ answers "Is there a US region?" with "It's coming" ([faq]); the regions guide documents
  `nyc` ([regions]).
- The FAQ places machines "On bare-metal servers in Germany" ([faq]); the privacy notice names a
  United States infrastructure provider for the EU cluster without a country ([privacy]).
- A blog post describes self-hosted boxd as a platform that "does not call out to a vendor control
  plane" ([blog]); the installer sends telemetry reports and downloads signed releases from boxd,
  and a cluster that can't reach boxd keeps working ([reference], "Telemetry").

## Questions for boxd

1. Is a deployment in the operator's own cloud account a separate cluster with its own zone,
   console, accounts, and API keys, or a region that `ListRegions` on `boxd.sh:9443` lists, with
   accounts and keys shared with the hosted service?
2. On a cluster that runs in one place, what do `ListRegions.regions`, `this_region`, and
   `SnapshotInfo.region` contain?
3. Is the API key as a bearer token, as SDK 0.3.0 sends it, a supported way to call the gRPC API?
   From which release do self-hosted clusters accept it?
4. Is the token exchange of every self-hosted cluster and every deployment in an operator's account
   at `https://app.<zone>/api/v1/auth/token`?
5. With private ingress, does `GetVm.public_ip` return the proxy's private IP?
6. Does the SSH proxy of a self-hosted cluster accept a key from the machine's
   `~/.ssh/authorized_keys` without `LinkSshKey`, as the hosted proxy does for usine's snapshots?
7. What does `GetSnapshot.status` return for a snapshot that is archiving, archived, or
   unarchiving?
8. Can the hosted CLI target a self-hosted cluster with `BOXD_API_URL`, and which SSH alias does the
   cluster's own CLI write for a machine?
9. Which CLI flag creates a machine of a size outside the four hosted sizes, such as 1 vCPU with
   32 GiB?
10. For a deployment in the operator's own account: what does the DPA cover, when can boxd staff
    access the account or its machines, which sub-processors apply, and which telemetry does it
    send?
11. Does the Internal Use licence cover a cluster that a service provider installs and runs in its
    customer's account, for that customer's own use?
12. Which country hosts the EU cluster's servers today, given the FAQ and the privacy notice?

## Issue drafts

### Draft 1

**Title:** boxd driver: connect to a boxd deployment in the operator's own cloud account

**Body:**

The boxd driver calls `https://boxd.sh:9443` for account calls and `ListRegions`, and exchanges its
API key at `https://app.boxd.sh/api/v1/auth/token`. A self-hosted cluster serves its API at
`<zone>:9443` and its console at `https://app.<zone>`, and a deployment in the operator's own cloud
account can have the same shape ([research](https://github.com/basaltbytes/usine/blob/main/docs/research/boxd-byoc.md#1-api-endpoints)).

Add an optional `endpoint` to the boxd provisioner, the account endpoint of the deployment. It
defaults to `https://boxd.sh:9443`.

- Send account calls and `ListRegions` to `endpoint`. Keep regional discovery from #1090.
- Derive the token exchange URL from `endpoint` with the SDK's rule: `https://app.<host>` plus
  `/api/v1/auth/token`, dropping the port and path; use a `localhost`, IP literal, or `app.` host as
  given.
- Use the configured hosts in the preflight and transient error messages in `boxd.ts`, instead of
  `app.boxd.sh` and `boxd.sh:9443`.
- Keep `providerEndpoints.boxd` as a test seam, or replace it with the new field.
- Add the field to the Worker form, and document it and `NODE_EXTRA_CA_CERTS` for a cluster with its
  own CA in the boxd worker guide. Correct the guide's statement that a deployment in the operator's
  own account always has its own region id.

Acceptance: a Worker with `endpoint: https://boxd.example.com:9443` exchanges its key at
`https://app.boxd.example.com/api/v1/auth/token` and sends every account call to the endpoint. Unit
tests cover the derivation cases and the default.

**Files:**

- `packages/config/src/factory.ts`
- `packages/core/src/worker.ts`
- `packages/executor/src/ssh/provisioner/boxd/grpc-client.ts`
- `packages/executor/src/ssh/provisioner/boxd.ts`
- `packages/executor/src/ssh/provisioner/drivers.ts`
- `packages/executor/src/ssh/model.ts`
- `packages/executor/test/ssh/provisioner/boxd-grpc.test.ts`
- `packages/config/test/config.test.ts`
- `apps/web/src/features/configuration/components/forms/provisioner.tsx`
- `apps/web/src/features/configuration/strings.ts`
- `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`

### Draft 2

**Title:** boxd driver: support a boxd deployment that runs in one place

**Body:**

`ListRegionsResponse.this_region` is `""` "when boxd runs in one place", and a self-hosted cluster
has no boxd regions ([research](https://github.com/basaltbytes/usine/blob/main/docs/research/boxd-byoc.md#1-api-endpoints)). The driver fails on such
a cluster: the region lookup raises `BoxdUnknownRegion` or rejects an empty `api_endpoint`, and
`verify` rejects `this_region` when it differs from `provisioner.region`.

- When `ListRegions` lists no regions and `this_region` is empty, send machine calls to the account
  endpoint and log that the deployment runs in one place.
- Accept an empty `api_endpoint` for the region equal to `this_region`, as the SDK does.
- Skip the `this_region` and snapshot region comparisons in that mode, or compare against the value
  boxd confirms (question 2 in the research note).
- Decide whether `provisioner.region` becomes optional, and document the result in the boxd worker
  guide.

Acceptance: preflight passes against a fake `ListRegions` answer with no regions and an empty
`this_region`, and still fails with the listed ids when a multi-region deployment lacks the
configured region.

**Files:**

- `packages/executor/src/ssh/provisioner/boxd/grpc-client.ts`
- `packages/executor/src/ssh/provisioner/boxd/client.ts`
- `packages/executor/src/ssh/provisioner/boxd.ts`
- `packages/config/src/factory.ts`
- `packages/core/src/worker.ts`
- `packages/executor/test/ssh/provisioner/boxd-grpc.test.ts`
- `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`

### Draft 3

**Title:** boxd driver: accept the machine sizes a boxd deployment offers

**Body:**

A self-hosted boxd cluster offers the sizes its operator lists, such as 1 vCPU with 32 GiB, and its
default list has no `8x32` ([research](https://github.com/basaltbytes/usine/blob/main/docs/research/boxd-byoc.md#4-snapshots-and-the-attempt-image)).
`BoxdSize` accepts only `1x4`, `2x8`, `4x16`, and `8x32`, `verify` expects 4 GiB per vCPU, and the
snapshot builder passes only `--vcpu`.

- Accept any `<vcpu>x<GiB>` size in `BoxdSize`, with positive integers.
- In `verify`, compare the snapshot's memory with the GiB in the size.
- In `infra/boxd/build-snapshot.sh`, accept the same pattern and pass the memory to the CLI with the
  flag boxd confirms (question 9 in the research note).
- Document the size format in the boxd worker guide.

Acceptance: a `1x32` provisioner passes preflight against a snapshot of 1 vCPU and 32 GiB, and fails
with the captured size against a `1x4` snapshot.

**Files:**

- `packages/core/src/worker.ts`
- `packages/config/src/factory.ts`
- `packages/executor/src/ssh/provisioner/boxd.ts`
- `infra/boxd/build-snapshot.sh`
- `infra/boxd/test/build-snapshot.test.mjs`
- `apps/web/src/features/configuration/components/forms/provisioner.tsx`
- `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`

### Draft 4

**Title:** boxd snapshot builder: build in a named region

**Body:**

`infra/boxd/build-snapshot.sh` creates its temporary machine in the region the CLI picks, which can
be the closest region, and then connects to `$machine.boxd`. That alias exists only for Frankfurt
machines; a machine in another region is `<machine>.<region>.boxd`
([research](https://github.com/basaltbytes/usine/blob/main/docs/research/boxd-byoc.md#4-snapshots-and-the-attempt-image)).

- Add `--region <id>` and pass it to `boxd machine new` and `boxd snapshots save`.
- Connect to `<machine>.<region>.boxd` for a region other than `fra`, and to `<machine>.boxd` for
  `fra` or when no region is given.
- In the boxd worker guide, show `--region`, and state that a self-hosted cluster needs the CLI from
  `https://app.<zone>/downloads/install.sh`.

Acceptance: the script tests cover the CLI arguments and the SSH alias with and without `--region`.

**Files:**

- `infra/boxd/build-snapshot.sh`
- `infra/boxd/test/build-snapshot.test.mjs`
- `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`

## Sources

Read on 2026-11-10. The self-host repository is pinned at commit `744ee0a`.

- boxd docs: [Regions][regions], [gRPC API][grpc-api], [Proto][proto],
  [TypeScript SDK][typescript-sdk], [CLI commands][commands].
- `@boxd-sh/sdk` 0.3.0 on npm: [package][sdk], files `dist/client.js`, `dist/utils.js`,
  `dist/auth.js`, and `dist/_regions.js`.
- boxd website: [Self-hosting][self-hosting], [Pricing][pricing], [FAQ][faq], [Terms][terms],
  [Privacy notice][privacy], [blog post on self-hosted agent execution][blog].
- Self-host installer: [repository][self-host repo], [README][self-host README],
  [INSTALL.md][install], [REFERENCE.md][reference], [OPERATIONS.md][operations],
  [AWS example `cluster.toml`][aws example], [Boxd Binary License][binary license].
- usine: `packages/executor/src/ssh/provisioner/boxd/`, `packages/executor/src/ssh/provisioner/`
  (`boxd.ts`, `drivers.ts`), `packages/executor/src/ssh/model.ts`, `packages/core/src/worker.ts`,
  `infra/boxd/build-snapshot.sh`, and `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`.

[regions]: https://docs.boxd.sh/guides/regions.md
[grpc-api]: https://docs.boxd.sh/reference/grpc-api.md
[proto]: https://docs.boxd.sh/reference/grpc-proto.md
[typescript-sdk]: https://docs.boxd.sh/reference/typescript-sdk.md
[commands]: https://docs.boxd.sh/cli/commands.md
[sdk]: https://www.npmjs.com/package/@boxd-sh/sdk/v/0.3.0
[self-hosting]: https://boxd.sh/self-hosting/
[pricing]: https://boxd.sh/pricing/
[faq]: https://boxd.sh/faq/
[terms]: https://boxd.sh/terms/
[privacy]: https://boxd.sh/privacy/
[blog]: https://boxd.sh/blog/self-hosted-agent-execution-for-engineering-teams/
[self-host repo]: https://github.com/boxd-sh/self-host/tree/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3
[self-host README]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/README.md
[install]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/docs/INSTALL.md
[reference]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/docs/REFERENCE.md
[operations]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/OPERATIONS.md
[aws example]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/examples/aws/cluster.toml
[binary license]:
  https://github.com/boxd-sh/self-host/blob/744ee0aad69a39ef4f78fc68c8cce8ae563bfdc3/LICENSE-BINARIES.md
