# usine gateway on Hetzner Cloud

These files create the gateway host of [#223](https://github.com/basaltbytes/usine/issues/223) (stage 2) on Hetzner Cloud: a private network, a gateway VM with a public address, and a firewall. Worker VMs on the network have no public address. [ADR 0027](../../../docs/adr/0027-gateway-credential-proxy.md) records why. [Add a worker](https://docs.usine.dev/guides/add-a-worker/) walks through the whole setup, and [Workers and the gateway](https://docs.usine.dev/architecture/workers-and-gateway/) describes each part.

| File | Contents |
| --- | --- |
| `gateway.sh` | Creates and deletes the network, gateway VM, and firewall with `hcloud`; logs the gateway in to a tailnet; installs `@usine/gateway` from npm or packed tarballs; renders a worker's cloud-init; creates the orchestrator's server in the network and logs it in to the tailnet. |
| `gateway-cloud-init.yaml` | The gateway VM: nftables, dnsmasq, chrony, bastion sshd settings, Tailscale, Node.js, and the `usine-gateway` service. |
| `gateway-nftables.conf` | The gateway's firewall rules. |
| `egress-allowlist` | The hosts that workers can reach through the forward proxy: package hosts and the harness login hosts. |
| `worker-cloud-init.yaml` | What a worker VM needs behind the gateway; `gateway.sh worker-user-data` sends it after the worker file of `../cloud-init.yaml`. |
| `worker-nftables.conf` | A worker's firewall rules: the gateway only, and the metadata service for root. |

## Traffic paths

The orchestrator reaches a worker over SSH through the gateway: `ssh -J root@<gateway> <user>@10.42.0.x`. It reaches the gateway over a tailnet, or over the public address while the Hetzner firewall admits the orchestrator's address to port 22 (see [Join the gateway to a tailnet](#join-the-gateway-to-a-tailnet)). The gateway's sshd allows only local forwarding, and nftables refuses outbound SSH outside the private network, so the bastion leads only to workers.

The executor reaches the admin API on loopback port 7070 through its own forward, `ssh -N -L 127.0.0.1:<port>:127.0.0.1:7070 <gateway>` on a kernel-picked port, opened at `usine up` and reopened whenever it closes. It attaches each attempt's installation token there, and gives the returned caller token to the children over the worker's SSH connection.

Workers resolve names with the gateway's dnsmasq, which answers `git.<domain>` and `llm.<domain>` with the gateway's private address and refuses other names. For the gateway's own names it answers AAAA with no address, not a refusal, because Codex's musl resolver fails a lookup if A or AAAA is refused, and then can't find the forward proxy at `<domain>:3128` ([#260](https://github.com/basaltbytes/usine/issues/260)). Workers have no default route or public address, so even with an address they can't reach the internet, and nftables allows only the gateway.

Workers set their clocks from the gateway's chrony, which syncs from Hetzner's time servers (`ntp1.hetzner.de`, `ntp2.hetzner.com`, `ntp3.hetzner.net`) and the Debian pool, and serves NTP only to the private network. A worker's systemd-timesyncd queries the gateway's address, needing no name, through UDP port 123. chrony answers itself and forwards nothing, so NTP is no way out.

git and gh use plain HTTP to `git.<domain>`. The gateway checks the caller token, replaces it with the installation token, and calls github.com, api.github.com, or uploads.github.com over HTTPS. gh goes through `/run/usine-gateway/http.sock`, which systemd forwards to port 80, because gh speaks only HTTPS to a custom `GH_HOST` but plain HTTP over a Unix socket. Neither side needs a certificate.

Release downloads use `git.<domain>` too, at `/OWNER/REPO/releases/download/TAG/FILE`. The gateway returns GitHub's redirect to the asset host unchanged, and the client fetches the asset through the forward proxy, so `egress-allowlist` keeps `objects.githubusercontent.com` and `release-assets.githubusercontent.com`. gh can't follow that redirect, because it sends every request to the gateway through its socket, and the reverse proxy refuses the asset host; workers download with curl. The gateway points GitHub redirects to github.com or api.github.com, such as a renamed repository's, at `git.<domain>`, and serves a renamed repository's new name to the attachment once GitHub's API confirms the rename. See [GitHub paths](../../../packages/gateway/README.md#github-paths) in the package README.

If the gateway has a provider's credential (`llm_providers` in `usine.yaml`), its harness uses plain HTTP to `llm.<domain>`: Claude Code at `/anthropic`, Codex at `/openai`. The gateway swaps the caller token for its credential, a subscription login or an API key, calls the provider over HTTPS, and streams the response back unchanged. See [Give the gateway the subscription logins](#give-the-gateway-the-subscription-logins). Otherwise Claude Code and Codex use the operator's logins on the worker (a Claude subscription, a ChatGPT plan) through the forward proxy.

Package managers and harness logins use the forward proxy at `<gateway>:3128` through `HTTPS_PROXY` and `HTTP_PROXY`, and apt through its own proxy setting. A tunnel opens only to an `egress-allowlist` host on port 443 whose name matches the TLS ClientHello and resolves to a public address; anything else is refused and logged. The ClientHello check keeps an allowed name on a shared CDN address from reaching another tenant. Before you list a CDN host, check its certificate's names and how its CDN routes: an HTTP/2 client can reuse an allowed connection for another name on the certificate ([#240](https://github.com/basaltbytes/usine/issues/240)). Plain HTTP requests lose their caller token before leaving; `CONNECT` tunnels are opaque, so nothing can be removed from them.

Never allowlist github.com, or a provider whose credential the gateway has; workers reach those through `git.<domain>` and `llm.<domain>`, where the gateway controls access. A github.com tunnel would let a worker push with any credential it got, and Claude Code opens api.anthropic.com connections outside `ANTHROPIC_BASE_URL` that would carry the caller token, so if the gateway has the Anthropic credential, remove the Claude Code hosts from `egress-allowlist`, and if it has the OpenAI credential, the Codex hosts.

The gateway uses its own public interface and forwards no worker packets.

Attempt containers on a worker use the worker's network (`docker run --network host`), so the paths above and the worker's nftables rules apply to them as to any process on the worker. A bridge network would send their traffic through Docker's own forwarding and NAT rules instead, around the output chain. The worker's `daemon.json` turns Docker's rules off, so the worker's ruleset is the only one. Each container gets the attempt's caller token on `docker run`'s standard input, as container variables, so no command line and no shell of `usine` carries it, except the fetch into the cached clone, which runs as `usine` with the token sent over SSH. Docker pulls the attempt image from `ghcr.io` through the forward proxy, with the proxy in its systemd drop-in.

### Paths by client

From the gateway's journal and dnsmasq's query log on 2026-10-15, with the children's environment from the executor (`HTTPS_PROXY=http://<domain>:3128`):

| Client | Path | Names it resolves on the worker |
| --- | --- | --- |
| git | `git.<domain>` over plain HTTP; `NO_PROXY` lists the domain | `git.<domain>` |
| gh | `/run/usine-gateway/http.sock`, which systemd forwards to the gateway's port 80 | none |
| curl, npm, pnpm | the forward proxy, through `HTTPS_PROXY` and `HTTP_PROXY` | `<domain>` |
| apt | the forward proxy, through its own proxy setting with the gateway's address | none |
| Claude Code 2.1.296 | the forward proxy, for the model API and the login | `<domain>` |
| Codex 0.153.4 | the forward proxy, for the Responses API WebSocket, its HTTPS fallback, the plugin-sync MCP client at `chatgpt.com/backend-api/ps/mcp`, and the login | `<domain>`, A and AAAA |

No client resolved a provider or registry name itself.

### Harness login hosts

`egress-allowlist` lists these hosts in its harness logins section. They come from the gateway's journal on a Debian 13 worker with Claude Code 2.1.296 and Codex 0.153.4, while each login command ran up to its code and each harness sent a prompt with a made-up login; nothing else was requested. No login was completed, so the post-login calls come from URLs in Claude Code's binary: they go to `api.anthropic.com`.

| Harness and login | Host | What calls it |
| --- | --- | --- |
| Claude Code, `claude auth login` | `api.anthropic.com` | Model requests, and the account's profile and roles after the login. |
| | `platform.claude.com` | The OAuth token exchange when the login's code is pasted, and every token refresh. |
| Codex, `codex login --device-auth` | `chatgpt.com` | Model requests: the Responses API over a WebSocket at `wss://chatgpt.com/backend-api/codex/responses`, which the proxy tunnels like any HTTPS connection. |
| | `auth.openai.com` | The device code, the token exchange after the code is entered, and every token refresh. |

Each login's URL opens in the operator's browser, not on the worker: `claude.com/cai/oauth/authorize` and `auth.openai.com/codex/device`. Preflight checks that the worker reaches each host through the forward proxy.

With both logins done, a one-prompt turn also requests unlisted hosts and completes without them: Claude Code `mcp-proxy.anthropic.com` and the claude.ai connectors, Codex `ab.chatgpt.com` and `sdmntpr<region>.oaiusercontent.com` ([#261](https://github.com/basaltbytes/usine/issues/261)).

On [#240](https://github.com/basaltbytes/usine/issues/240): all four hosts are behind Cloudflare. The `api.anthropic.com` and `platform.claude.com` certificates cover only their name, `chatgpt.com`'s adds `amb-staging.chatgpt.com` and its subdomains, and `auth.openai.com`'s covers `*.auth.openai.com`, so HTTP/2 reuse reaches only the same provider. Through a tunnel to each host, a request with another site's `Host` header (`claude.ai`, `claude.com`, `www.cloudflare.com`, `api.openai.com`) got `403 Forbidden` from Cloudflare (checked on 2026-10-15). Claude Code opens one tunnel to `api.anthropic.com` per prompt and closes it before its ClientHello; the gateway logs it at info level as abandoned, not refused.

## Create a gateway

You need `hcloud` with an active context, an SSH key in the project, and the orchestrator's public address, which the firewall admits to SSH until you [join the gateway to a tailnet](#join-the-gateway-to-a-tailnet). `SSH_KEY` takes comma-separated names or ids.

```sh
ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
ssh root@<gateway> cloud-init status --wait
```

`create` installs no service. After cloud-init, `install` puts `@usine/gateway` (the latest release, or one such as `@usine/gateway@0.1.0`) in `/opt/usine-gateway` and restarts the service. `-i` gives its `ssh` and `scp` a key, such as the one from [`../README.md`](../README.md), instead of your SSH agent and configuration:

```sh
./gateway.sh install -i ~/.ssh/usine_worker @usine/gateway
```

`install` and `tailnet-up` connect to root at the public address that `hcloud server ip` gives. `GATEWAY_SSH` sets another SSH destination, such as the gateway's `Host` alias once it uses the tailnet:

```sh
GATEWAY_SSH=usine-gateway ./gateway.sh install @usine/gateway
```

For an unreleased build, pack it in a usine checkout with the `@usine/core` it depends on, whose published version can lag:

```sh
pnpm build
pnpm --filter @usine/core --filter @usine/gateway pack
```

`pnpm pack` writes a versioned tarball in each package folder, such as `packages/core/usine-core-0.3.0.tgz` and `packages/gateway/usine-gateway-0.0.0.tgz` (`--pack-destination <dir>` collects them). `install` copies tarballs to the gateway first:

```sh
./gateway.sh install -i ~/.ssh/usine_worker ./usine-core-0.3.0.tgz ./usine-gateway-0.0.0.tgz
```

Run `install` again to upgrade.

At first boot, the VM writes its admin token and caller key to `/etc/usine-gateway/secrets.env`, readable by root and the `usine-gateway` group. The service reads `settings.env` and `secrets.env`, listed in its unit's `USINE_GATEWAY_ENVIRONMENT_FILES`, at startup and each reload. To give the gateway the operator's subscription logins, see [Give the gateway the subscription logins](#give-the-gateway-the-subscription-logins). To use API keys instead, add them to `secrets.env` and reload:

```sh
ssh root@<gateway> 'echo ANTHROPIC_API_KEY=sk-ant-... >> /etc/usine-gateway/secrets.env && systemctl reload usine-gateway'
```

`NAME`, `LOCATION`, `SERVER_TYPE`, `IMAGE`, `NETWORK_CIDR`, `SUBNET_CIDR`, `GATEWAY_IP`, `DOMAIN`, and `LABEL` override the defaults at the top of `gateway.sh`. Logs are one JSON object per line: `journalctl -u usine-gateway -o cat`.

On an existing gateway whose `/etc/dnsmasq.d/usine-gateway.conf` lacks a `local=/<domain>/` line, add it and run `systemctl restart dnsmasq`; without it, Codex on a worker can't resolve the forward proxy ([#260](https://github.com/basaltbytes/usine/issues/260)).

## Join the gateway to a tailnet

The Hetzner firewall admits SSH from `ORCHESTRATOR_CIDR` only, so the orchestrator can't reach the gateway after its own public address changes ([#492](https://github.com/basaltbytes/usine/issues/492)). On the orchestrator machine's [Tailscale](https://tailscale.com/) tailnet, it reaches the gateway from any network, and the public SSH rule can go. cloud-init installs Tailscale from its stable apt repository, with the repository's signing key in `gateway-cloud-init.yaml`, but doesn't log it in.

1. Log the gateway in. `tailnet-up` runs `tailscale up` over SSH, which prints a login URL to open in your browser, and then prints the gateway's tailnet address:

   ```sh
   ./gateway.sh tailnet-up -i ~/.ssh/usine_worker
   ```

   With an [auth key](https://tailscale.com/kb/1085/auth-keys) in `TAILSCALE_AUTH_KEY`, it logs in without the browser. The key goes to `tailscale up` on SSH's standard input, never on a command line:

   ```sh
   TAILSCALE_AUTH_KEY=tskey-auth-... ./gateway.sh tailnet-up -i ~/.ssh/usine_worker
   ```

   `tailnet-up` passes `--netfilter-mode=off`, because the `flush ruleset` in `gateway-nftables.conf` would delete Tailscale's rules at every nftables reload, and `--accept-dns=false`, so the gateway keeps Hetzner's resolvers. nftables accepts SSH on every interface, `tailscale0` included, and port 80 on `tailscale0`; DNS, NTP, and the forward proxy accept only the private network. It refuses connections from the gateway into the tailnet, and the tailnet's access rules decide which devices can reach the gateway on port 22.

2. Keep the gateway's node key from expiring, which by default happens after 180 days and takes the gateway off the tailnet. In the Tailscale admin console, disable key expiry for the gateway's machine, or log in with a tagged auth key: tagged devices have key expiry disabled by default.

3. Point the gateway's `Host` entry in the orchestrator user's SSH configuration at the tailnet address. `HostKeyAlias` makes `ssh` check the host key that `known_hosts` has for the public address:

   ```
   Host usine-gateway
     HostName 100.64.0.10
     HostKeyAlias 203.0.113.30
     User root
     IdentityFile ~/.ssh/usine_worker
   ```

   Workers keep `ProxyJump usine-gateway`, so they're reachable from any network too. Check the entry with `ssh usine-gateway true`.

4. Remove the public SSH rule, with the `ORCHESTRATOR_CIDR` that `create` used:

   ```sh
   hcloud firewall delete-rule usine-gateway --direction in --protocol tcp --port 22 --source-ips 203.0.113.7/32 --description "SSH from the orchestrator"
   ```

The gateway accepts no inbound UDP. Tailscale still connects directly from most networks, because the Hetzner firewall and nftables both admit replies to the gateway's own packets; from behind a hard NAT, it relays through a DERP server. `tailscale status` on the orchestrator machine shows which.

If the tailnet path stops working, for example after the node key expires, add the rule back with your current address and connect as `root@203.0.113.30`:

```sh
hcloud firewall add-rule usine-gateway --direction in --protocol tcp --port 22 --source-ips 198.51.100.4/32 --description "SSH from the orchestrator"
```

Without SSH, give root a password with `hcloud server reset-password usine-gateway`, which prints it, and log in as root on the server's Hetzner Cloud Console. Run `passwd -l root` when you're done.

On an existing gateway joined to a tailnet by hand, run `tailscale set --accept-dns=false` first. Then add `oifname "tailscale0" ct state new reject` to the output chain in `/etc/nftables.conf` and run `nft -f /etc/nftables.conf`. With the tailnet's DNS on, the gateway's resolver is 100.100.100.100 on `tailscale0`, and that rule would block it.

## Change the allowlist or an API key

The gateway reads its allowlist from `/etc/usine-gateway/egress-allowlist`, which `create` copies from `egress-allowlist` once. Edit it, or `secrets.env`, then reload and read the result in the journal:

```sh
ssh root@<gateway> 'systemctl reload usine-gateway && sleep 1 && journalctl -u usine-gateway -o cat -n 5'
```

A reload keeps attachments, so running attempts continue; a restart forgets them until the executor stores them again, within two minutes. See [Reload](../../../packages/gateway/README.md#reload) in the package README.

Gateways from before reload support have `EnvironmentFile=` lines in their unit and a root-only `secrets.env`. Install a build that reloads (older ones ignore `USINE_GATEWAY_ENVIRONMENT_FILES` and exit on SIGHUP), then, as root, let the service read `secrets.env`:

```sh
chgrp usine-gateway /etc/usine-gateway/secrets.env && chmod 0640 /etc/usine-gateway/secrets.env
```

In `/etc/systemd/system/usine-gateway.service`, replace the two `EnvironmentFile=` lines with these, and restart the service once:

```ini
Environment=USINE_GATEWAY_ENVIRONMENT_FILES=/etc/usine-gateway/settings.env:/etc/usine-gateway/secrets.env
ExecReload=kill -HUP $MAINPID
```

```sh
systemctl daemon-reload && systemctl restart usine-gateway
```

## Give the gateway the subscription logins

A worker that lives for one attempt can't keep a login, so the gateway holds the operator's Claude and ChatGPT subscriptions and adds them to the workers' requests in place of their caller tokens. Make each login on your own machine and copy it to the gateway. Then list the providers in the worker's `llm_providers` (see [Add the worker to `usine.yaml`](#add-the-worker-to-usineyaml)) and remove their hosts from `/etc/usine-gateway/egress-allowlist`.

For Claude, `claude setup-token` prints a token valid for one year, without saving it. Put it in `secrets.env`, which stays mode 0640 for root and the `usine-gateway` group, and reload:

```sh
claude setup-token
ssh root@<gateway> 'read -r token && echo "USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN=$token" >> /etc/usine-gateway/secrets.env && systemctl reload usine-gateway'
```

`ssh` reads the token from your terminal, so it isn't in a command line or your shell history. Paste it and press Enter. A year later, run `claude setup-token` again, replace the line, and reload. Remove `ANTHROPIC_API_KEY` first if `secrets.env` has it: a provider takes one credential.

For ChatGPT, log in to Codex with an empty `CODEX_HOME`, so the gateway gets a login of its own: a refresh token works once, so a copy of the `auth.json` you use yourself stops working at the first refresh on either side. Copy the file to the gateway's state directory, owned by `usine-gateway` with mode 0600, point `USINE_GATEWAY_CHATGPT_AUTH_FILE` at it, reload, and remove your copy:

```sh
export CODEX_HOME=$(mktemp -d)
codex login
scp "$CODEX_HOME/auth.json" root@<gateway>:/var/lib/usine-gateway/codex-auth.json
ssh root@<gateway> 'chown usine-gateway:usine-gateway /var/lib/usine-gateway/codex-auth.json && chmod 0600 /var/lib/usine-gateway/codex-auth.json && echo USINE_GATEWAY_CHATGPT_AUTH_FILE=/var/lib/usine-gateway/codex-auth.json >> /etc/usine-gateway/settings.env && systemctl reload usine-gateway'
rm -rf "$CODEX_HOME" && unset CODEX_HOME
```

The gateway refreshes the access token before it expires and writes the rotated tokens back to the file, so the service needs to write to `/var/lib/usine-gateway`. To replace the login, copy a new `auth.json` over the file and reload. Check the result in the journal:

```sh
ssh root@<gateway> 'journalctl -u usine-gateway -o cat -n 20 | grep -i chatgpt'
```

`Loaded the ChatGPT login` shows the file was read. `The token endpoint rejected the ChatGPT login's refresh token` means the login needs replacing; until then, Codex requests get 401 with `provider-login-unavailable`. [ChatGPT login](../../../packages/gateway/README.md#chatgpt-login) in the package README describes the refresh.

Gateways created before the state directory need it in their unit. As root, add these lines to the `[Service]` section of `/etc/systemd/system/usine-gateway.service`, then restart the service once; the executor stores running attempts' attachments again within two minutes:

```ini
StateDirectory=usine-gateway
StateDirectoryMode=0700
```

```sh
systemctl daemon-reload && systemctl restart usine-gateway
```

### Provider terms

Anthropic's [legal and compliance page for Claude Code](https://code.claude.com/docs/en/legal-and-compliance) (read 2026-10-26) allows a subscriber to sign in to the unmodified Claude Code binary with their own plan, including where a platform runs Claude Code in sandboxes, and allows customers to keep their own credentials in a secrets manager or machine image for their own authorized users. It forbids third-party developers from offering Claude.ai login in their own applications, from routing requests through Free, Pro or Max plan credentials on behalf of their users, and from collecting, storing or intermediating other people's Claude.ai credentials or session tokens. Plan limits assume ordinary individual usage. OpenAI documents Sign in with ChatGPT as the default login of the [Codex CLI](https://developers.openai.com/codex/auth); its terms of use were not read for this page.

The gateway stays inside those terms as long as four things remain true:

- The gateway stores the credentials of the operator who runs the instance and signs only that operator's agents' requests. usine is software you run yourself; an instance that stored or relayed other people's subscription logins would be the forbidden case.
- Every user of an instance authenticates with their own login or key. Nobody's attempts run on another person's plan.
- Claude Code and Codex run unmodified, with the sign-in methods they ship. The gateway replaces a bearer token in transit and changes nothing in the binaries.
- A subscription at the gateway is subject to the plan's usage limits, which assume one person's use. A factory that runs many attempts at once runs into those limits sooner than a person would; an operator who needs more buys a Team or Enterprise plan or uses an API key.

The ChatGPT login is the one place where usine itself, not a harness, talks to a provider's authentication endpoint: the gateway refreshes the token with the OAuth client the Codex CLI uses, and writes the rotated refresh token back to its file.

## Create a worker behind the gateway

`worker-user-data` takes a file of public keys to authorize for `usine`, one per line:

```sh
./gateway.sh worker-user-data ~/.ssh/usine_worker.pub > worker.mime
hcloud server create --name worker-one --type cx33 --image debian-13 --location fsn1 \
  --ssh-key my-key --network usine-gateway --without-ipv4 --without-ipv6 \
  --label usine=worker --user-data-from-file worker.mime
```

The output is a MIME multipart cloud-init: `../cloud-init.yaml`'s worker file, then `worker-cloud-init.yaml`, whose lists (packages, files, commands) are appended per its `Merge-Type` header. The second file points the resolver, apt, `/etc/environment`, and Docker at the gateway, so the first file's setup installs the toolchain through the forward proxy: Debian packages and Docker from `deb.debian.org` and `mirror.hetzner.com`, gh from `cli.github.com`, Node.js from `deb.nodesource.com`, and pnpm and the harnesses from `registry.npmjs.org`. Docker pulls the attempt image from `ghcr.io` and `pkg-containers.githubusercontent.com`, which `egress-allowlist` lists.

On a worker created before these files installed Docker, add as root `/etc/systemd/system/docker.service.d/http-proxy.conf` and `/etc/docker/daemon.json` with the contents of `worker-cloud-init.yaml`, then install Docker as [`../README.md`](../README.md#add-docker-to-an-existing-worker) describes. On the gateway, add the two `ghcr.io` hosts to `/etc/usine-gateway/egress-allowlist` and run `systemctl reload usine-gateway`.

Projects use Debian's Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (see [`../README.md`](../README.md)), and `egress-allowlist` omits Playwright's download: on x64 Linux, Playwright 1.61 fetches from `cdn.playwright.dev`, which redirects to `storage.googleapis.com`, every Google Cloud Storage bucket's endpoint, so allowing it would let a worker upload a checkout to any bucket it has a signed URL for.

A worker needs 8 GB: the lint and knip gates reserve a 6 GiB virtual buffer, which a 4 GB machine refuses, and two attempts at once thrash it ([#270](https://github.com/basaltbytes/usine/issues/270)). cloud-init sets `vm.overcommit_memory=1` and a 2 GB swap file, and installs bubblewrap for Codex's sandbox ([#269](https://github.com/basaltbytes/usine/issues/269)). Create the gateway first. A `cx33` worker takes about four minutes; follow with `ssh -J root@<gateway> usine@<worker> cloud-init status --wait`. `hcloud server describe worker-one` shows its private address.

The worker's sshd accepts `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, and `USINE_GATEWAY_TOKEN` (`AcceptEnv`), which carry the caller token over SSH, out of command lines; if sshd drops them, preflight fails and names them. On existing workers, add the missing names to the `AcceptEnv` line of `/etc/ssh/sshd_config.d/40-usine-gateway.conf` and reload sshd: `GH_TOKEN` for gh, which needs both token variables because `GH_TOKEN` serves absolute GitHub pagination links and explicit github.com URLs, and `USINE_GATEWAY_TOKEN` for Codex on the gateway's OpenAI credential.

## Log in to the harnesses on the worker

Skip this for a harness whose provider credential the gateway holds ([Give the gateway the subscription logins](#give-the-gateway-the-subscription-logins)). For the others, the operator's logins stay on the worker. Connect through the gateway as `usine` and log in to each harness the roster uses:

```sh
ssh -t -J root@<gateway> usine@<worker>
claude auth login          # Claude subscription: open the URL it prints, then paste the code back
codex login --device-auth  # ChatGPT plan: open the URL it prints and enter the code it prints
```

Both use the forward proxy (`HTTPS_PROXY` in `/etc/environment`). `claude auth status` and `codex login status` show the result. Attempt containers mount `~/.claude/.credentials.json` and `~/.codex/auth.json` read-write and copy `~/.claude.json` and `~/.codex/config.toml`, so log in on the worker, not in a container.

## Add the worker to `usine.yaml`

Add both hosts to the orchestrator user's SSH configuration; the gateway is the worker's bastion and the route to the admin API. The gateway's entry uses its tailnet address (see [Join the gateway to a tailnet](#join-the-gateway-to-a-tailnet)):

```
Host usine-gateway
  HostName 100.64.0.10
  HostKeyAlias 203.0.113.30
  User root
  IdentityFile ~/.ssh/usine_worker

Host worker-one
  HostName 10.42.0.3
  User usine
  ProxyJump usine-gateway
  IdentityFile ~/.ssh/usine_worker
```

Don't add a `LocalForward` to the gateway's entry: it also applies to the executor's forward, which then exits whenever that port is taken. To reach the admin API by hand, run `ssh -N -L 7070:127.0.0.1:7070 usine-gateway`, which doesn't affect the executor's. Then give the worker a `gateway`:

```yaml
workers:
  - name: worker-one
    kind: ssh
    destination: worker-one
    root: /home/usine/.usine
    gateway:
      domain: gw.internal
      destination: usine-gateway
      admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
```

- `domain` is the gateway's `DOMAIN`.
- `destination` is the gateway's SSH destination, here its `Host` alias. The executor's admin forward goes through it, reopened after one second, doubling up to one minute, or at once when an admin request needs it; a request that finds it closed or unanswered is retried once through a new forward.
- `admin_port` is the admin API's port on the gateway, `USINE_GATEWAY_ADMIN_PORT` in `/etc/usine-gateway/settings.env`, default 7070.
- `admin_token_env` names the orchestrator's variable with the admin token from `/etc/usine-gateway/secrets.env`, never the token itself; `usine up` stops if it's unset. For example, keep it in the instance folder's `.env`, which every `usine` command reads, readable only by the orchestrator user:

  ```sh
  (umask 077; ssh root@<gateway> "grep '^USINE_GATEWAY_ADMIN_TOKEN=' /etc/usine-gateway/secrets.env" >> .env)
  chmod 600 .env
  usine up
  ```

- `llm_providers` lists the providers whose credential the gateway has (empty by default), such as `[anthropic, openai]`; other harnesses use their login on the worker. With `anthropic`, Claude Code children call `llm.<domain>/anthropic` with the caller token, preflight checks only the `claude` binary, and the Claude Code hosts must come off `egress-allowlist`. With `openai`, the executor writes Codex's `model_provider` to each attempt's Codex home, `<root>/workers/<worker>/codex/<attempt>/config.toml`, and gives the attempt's Codex children that directory as `CODEX_HOME`, mounted read-write in its container, so they call `llm.<domain>/openai/v1` with the caller token; preflight checks only the `codex` binary and version, and the Codex hosts must come off `egress-allowlist`. Preflight logs each provider's mode in `SSH Worker Gateway verified`: `gateway-subscription`, `gateway-api-key`, or `worker-login`.

Preflight attaches nothing. It checks that the admin forward opens (or gives the `ssh` command showing why), the admin API accepts the token, sshd accepts the caller token variables, the worker reaches `git.<domain>`, and, with Docker on the worker, that Docker answers and pulls the attempt image. For each harness using its worker login, it checks the login and that each login host answers through the forward proxy, in a container from the attempt image if the worker has Docker; a refused host fails with the host to add to `egress-allowlist`. During an attempt, the executor stores its attachment again every two minutes, so a restarted gateway, which keeps attachments in memory, recovers them within two minutes.

## Provisioned workers behind the gateway

A provisioned worker ([`../README.md`](../README.md#provisioned-workers)) creates a server for each attempt from a snapshot that `../snapshot.sh` builds in this network. Each server joins the network when usine creates it (`provisioner.network`), with no public address, and the executor connects to its private address through the gateway with `ssh -J <gateway.destination>`, so the servers need no `Host` entry. The gateway needs no change for them: it decides by caller token, not by address, and each attempt's attachment has a caller token of its own.

A server created from a snapshot gets only the executor's user data, which sets its host key, so the resolver line of `worker-cloud-init.yaml`'s `bootcmd` doesn't run on it. The same file writes `/etc/cloud/cloud.cfg.d/90-usine-gateway-resolver.cfg`, whose `bootcmd` cloud-init runs at every boot, so the snapshot's servers resolve names with the gateway too.

The servers have no harness login. For each harness, give the gateway the provider's credential, a subscription login or an API key, list the provider in the worker's `llm_providers`, and remove the harness's hosts from `egress-allowlist`. Or set the provider's key in `provisioner.api_keys` and allow the provider's API host, `api.anthropic.com` or `api.openai.com`, which the harness then reaches through the forward proxy with the key. `api.openai.com` isn't in the default allowlist.

## Add the time server to an existing gateway and worker

Gateways and workers created before chrony was added need these steps for a worker time source ([#254](https://github.com/basaltbytes/usine/issues/254)). Infra changes don't reach running machines ([#264](https://github.com/basaltbytes/usine/issues/264)), so run them by hand. They use the default `NETWORK_CIDR` and `GATEWAY_IP`, `10.42.0.0/16` and `10.42.0.2`. Do the gateway first; the worker's timesyncd needs its chrony.

On the gateway, as root (`ssh root@<gateway>`):

1. Write chrony's settings: Hetzner's time servers, and the private network as clients.

   ```sh
   mkdir -p /etc/chrony/conf.d
   printf 'server ntp1.hetzner.de iburst\nserver ntp2.hetzner.com iburst\nserver ntp3.hetzner.net iburst\nallow 10.42.0.0/16\n' > /etc/chrony/conf.d/usine-gateway.conf
   ```

2. Install chrony. It removes systemd-timesyncd and starts with the file above.

   ```sh
   apt-get update && apt-get install -y chrony
   ```

3. Accept NTP from the private network, then load the rules.

   ```sh
   sed -i 's/udp dport 53 accept/udp dport { 53, 123 } accept/' /etc/nftables.conf
   nft -f /etc/nftables.conf
   ```

4. Check. Within a minute, `chronyc sources` marks one source with `^*`, and `timedatectl` shows:

   ```
   System clock synchronized: yes
   NTP service: active
   ```

Rebuilding a worker from `worker-user-data` also adds the time server, but loses its harness logins. On a running worker, `usine` has no sudo and root can't log in over SSH, so run the steps as root through `su` in an SSH session as `usine`:

1. Give root a password with `hcloud server reset-password <worker>`, which prints it, then connect through the gateway and switch to root:

   ```sh
   ssh -t <worker> 'su -'
   ```

   `<worker>` is the worker's `Host` entry in the orchestrator user's SSH configuration, which jumps through the gateway (see [Add the worker to `usine.yaml`](#add-the-worker-to-usineyaml)). If SSH fails, log in as root with that password on the server's Hetzner Cloud Console.

2. Point timesyncd at the gateway.

   ```sh
   mkdir -p /etc/systemd/timesyncd.conf.d
   printf '[Time]\nNTP=\nNTP=10.42.0.2\n' > /etc/systemd/timesyncd.conf.d/usine-gateway.conf
   ```

3. Allow NTP to the gateway, then load the rules.

   ```sh
   sed -i 's/udp dport 53 accept/udp dport { 53, 123 } accept/' /etc/nftables.conf
   nft -f /etc/nftables.conf
   ```

4. Restart timesyncd, and lock root's password again.

   ```sh
   systemctl restart systemd-timesyncd
   passwd -l root
   ```

5. Check from the orchestrator with `ssh -J root@<gateway> usine@<worker> timedatectl`, which shows `System clock synchronized: yes` and `NTP service: active`. `timedatectl timesync-status` shows `Server: 10.42.0.2 (10.42.0.2)`.

## Run the orchestrator in the gateway's network

`gateway.sh orchestrator` creates a server for `usine up` itself in the gateway's network, from [`../orchestrator-cloud-init.yaml`](../orchestrator-cloud-init.yaml): Node.js from NodeSource, `@usine/server` installed with npm in the `usine` user's home, Tailscale, chrony with the gateway as its time source, the nftables rules of [`../orchestrator-nftables.conf`](../orchestrator-nftables.conf), and a `usine.service` systemd unit for the instance folder `/home/usine/factory`. The server has public addresses for its own connections and a Hetzner firewall that admits only ICMP. `usine up` listens on `127.0.0.1` only, and `tailscale serve` publishes the web UI over HTTPS on the tailnet. Once enabled, nftables accepts new connections only to SSH from `tailscale0`, none from the private network. From the server, `destination: usine-gateway` and the workers' private addresses work as from a laptop on the tailnet.

```sh
SSH_KEY=my-key ./gateway.sh orchestrator ~/.ssh/id_ed25519.pub     # the key that the usine user authorizes
./gateway.sh orchestrator-tailnet-up -i ~/.ssh/usine_worker          # once, over SSH to root through the gateway
```

`SSH_KEY` names the project's keys for root, as for `create`. `ORCHESTRATOR_NAME` (default `usine-orchestrator`), `ORCHESTRATOR_TYPE` (default `cpx12`), `ORCHESTRATOR_LABEL`, `LOCATION`, and `IMAGE` set the server; `LOCATION` must be in the network's zone. `orchestrator-user-data` prints the rendered user data. `orchestrator-tailnet-up` runs `tailscale up` with the flags of `tailnet-up` and `--advertise-tags=$ORCHESTRATOR_TAG` (default `tag:usine-orchestrator`), then `tailscale serve --bg 7331`, then enables nftables, which from then on refuses SSH through the gateway. It prints the server's tailnet address and the UI's URL for `USINE_ORIGIN`. Before you run it, add the tag and its grant to the tailnet policy, and turn on HTTPS certificates for the tailnet. [Run the orchestrator on a server](https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/) covers the whole setup and the move of an instance from a laptop. Delete the orchestrator's server and its firewall before the gateway:

```sh
hcloud server delete usine-orchestrator
hcloud firewall delete usine-orchestrator
```

## Delete the gateway

Delete the workers and the orchestrator's server on the network first, then:

```sh
./gateway.sh delete
```

## Boat workers over Tailscale

The reverse proxy binds to `0.0.0.0`, with nftables accepting port 80 on the private network and `tailscale0`. Keep the public firewall closed to port 80, and restrict `tag:usine-attempt` to the gateway's TCP port 80 in the tailnet policy. The admin API stays on loopback; the forward proxy stays on the private address. Existing gateways must update `USINE_GATEWAY_PROXY_HOST` and the nftables rules before restarting the service. The [provisioned-worker guide](https://docs.usine.dev/guides/add-a-provisioned-worker/#gateway-subscriptions-over-tailscale) describes OAuth, snapshots, and policy grants.
