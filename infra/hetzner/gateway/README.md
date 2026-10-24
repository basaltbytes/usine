# usine gateway on Hetzner Cloud

These files create the gateway host of [#223](https://github.com/basaltbytes/usine/issues/223) (stage 2) on Hetzner Cloud: a private network, a gateway VM with a public address, and a firewall. Worker VMs on the network have no public address. [ADR 0027](../../../docs/adr/0027-gateway-credential-proxy.md) records why. [Add a worker](https://docs.usine.dev/guides/add-a-worker/) walks through the whole setup, and [Workers and the gateway](https://docs.usine.dev/architecture/workers-and-gateway/) describes each part.

| File | Contents |
| --- | --- |
| `gateway.sh` | Creates and deletes the network, gateway VM, and firewall with `hcloud`; logs the gateway in to a tailnet; installs `@usine/gateway` from npm or packed tarballs; renders a worker's cloud-init. |
| `gateway-cloud-init.yaml` | The gateway VM: nftables, dnsmasq, chrony, bastion sshd settings, Tailscale, Node.js, and the `usine-gateway` service. |
| `gateway-nftables.conf` | The gateway's firewall rules. |
| `egress-allowlist` | The hosts that workers can reach through the forward proxy: package hosts and the harness login hosts. |
| `worker-cloud-init.yaml` | What a worker VM needs behind the gateway; `gateway.sh worker-user-data` sends it after the worker file of `../cloud-init.yaml`. |
| `worker-nftables.conf` | A worker's firewall rules: the gateway only. |

## Traffic paths

The orchestrator reaches a worker over SSH through the gateway: `ssh -J root@<gateway> <user>@10.42.0.x`. It reaches the gateway over a tailnet, or over the public address while the Hetzner firewall admits the orchestrator's address to port 22 (see [Join the gateway to a tailnet](#join-the-gateway-to-a-tailnet)). The gateway's sshd allows only local forwarding, and nftables refuses outbound SSH outside the private network, so the bastion leads only to workers.

The executor reaches the admin API on loopback port 7070 through its own forward, `ssh -N -L 127.0.0.1:<port>:127.0.0.1:7070 <gateway>` on a kernel-picked port, opened at `usine up` and reopened whenever it closes. It attaches each attempt's installation token there, and gives the returned caller token to the children over the worker's SSH connection.

Workers resolve names with the gateway's dnsmasq, which answers `git.<domain>` and `llm.<domain>` with the gateway's private address and refuses other names. For the gateway's own names it answers AAAA with no address, not a refusal, because Codex's musl resolver fails a lookup if A or AAAA is refused, and then can't find the forward proxy at `<domain>:3128` ([#260](https://github.com/basaltbytes/usine/issues/260)). Workers have no default route or public address, so even with an address they can't reach the internet, and nftables allows only the gateway.

Workers set their clocks from the gateway's chrony, which syncs from Hetzner's time servers (`ntp1.hetzner.de`, `ntp2.hetzner.com`, `ntp3.hetzner.net`) and the Debian pool, and serves NTP only to the private network. A worker's systemd-timesyncd queries the gateway's address, needing no name, through UDP port 123. chrony answers itself and forwards nothing, so NTP is no way out.

git and gh use plain HTTP to `git.<domain>`. The gateway checks the caller token, replaces it with the installation token, and calls github.com, api.github.com, or uploads.github.com over HTTPS. gh goes through `/run/usine-gateway/http.sock`, which systemd forwards to port 80, because gh speaks only HTTPS to a custom `GH_HOST` but plain HTTP over a Unix socket. Neither side needs a certificate.

Release downloads use `git.<domain>` too, at `/OWNER/REPO/releases/download/TAG/FILE`. The gateway returns GitHub's redirect to the asset host unchanged, and the client fetches the asset through the forward proxy, so `egress-allowlist` keeps `objects.githubusercontent.com` and `release-assets.githubusercontent.com`. The gateway points GitHub redirects to github.com or api.github.com, such as a renamed repository's, at `git.<domain>`. See [GitHub paths](../../../packages/gateway/README.md#github-paths) in the package README.

Claude Code and Codex use the operator's logins on the worker (a Claude subscription, a ChatGPT plan) through the forward proxy. If the gateway has a provider's credential (`llm_providers` in `usine.yaml`), Claude Code uses plain HTTP to `llm.<domain>`; the gateway swaps the caller token for its API key, calls the provider over HTTPS, and streams the response back unchanged.

Package managers and harness logins use the forward proxy at `<gateway>:3128` through `HTTPS_PROXY` and `HTTP_PROXY`, and apt through its own proxy setting. A tunnel opens only to an `egress-allowlist` host on port 443 whose name matches the TLS ClientHello and resolves to a public address; anything else is refused and logged. The ClientHello check keeps an allowed name on a shared CDN address from reaching another tenant. Before you list a CDN host, check its certificate's names and how its CDN routes: an HTTP/2 client can reuse an allowed connection for another name on the certificate ([#240](https://github.com/basaltbytes/usine/issues/240)). Plain HTTP requests lose their caller token before leaving; `CONNECT` tunnels are opaque, so nothing can be removed from them.

Never allowlist github.com, or a provider whose credential the gateway has; workers reach those through `git.<domain>` and `llm.<domain>`, where the gateway controls access. A github.com tunnel would let a worker push with any credential it got, and Claude Code opens api.anthropic.com connections outside `ANTHROPIC_BASE_URL` that would carry the caller token, so if the gateway has the Anthropic credential, remove the Claude Code hosts from `egress-allowlist`.

The gateway uses its own public interface and forwards no worker packets.

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

At first boot, the VM writes its admin token and caller key to `/etc/usine-gateway/secrets.env`, readable by root and the `usine-gateway` group. The service reads `settings.env` and `secrets.env`, listed in its unit's `USINE_GATEWAY_ENVIRONMENT_FILES`, at startup and each reload. Add API keys there and reload:

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

   `tailnet-up` passes `--netfilter-mode=off`, because the `flush ruleset` in `gateway-nftables.conf` would delete Tailscale's rules at every nftables reload, and `--accept-dns=false`, so the gateway keeps Hetzner's resolvers. nftables accepts SSH on every interface, `tailscale0` included, and the gateway's other services only from the private network. It refuses connections from the gateway into the tailnet, and the tailnet's access rules decide which devices can reach the gateway on port 22.

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

## Create a worker behind the gateway

`worker-user-data` takes a file of public keys to authorize for `usine`, one per line:

```sh
./gateway.sh worker-user-data ~/.ssh/usine_worker.pub > worker.mime
hcloud server create --name worker-one --type cx33 --image debian-13 --location fsn1 \
  --ssh-key my-key --network usine-gateway --without-ipv4 --without-ipv6 \
  --label usine=worker --user-data-from-file worker.mime
```

The output is a MIME multipart cloud-init: `../cloud-init.yaml`'s worker file, then `worker-cloud-init.yaml`, whose lists (packages, files, commands) are appended per its `Merge-Type` header. The second file points the resolver, apt, and `/etc/environment` at the gateway, so the first file's setup installs the toolchain through the forward proxy: Debian packages from `deb.debian.org` and `mirror.hetzner.com`, gh from `cli.github.com`, Node.js from `deb.nodesource.com`, and pnpm and the harnesses from `registry.npmjs.org`.

Projects use Debian's Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (see [`../README.md`](../README.md)), and `egress-allowlist` omits Playwright's download: on x64 Linux, Playwright 1.61 fetches from `cdn.playwright.dev`, which redirects to `storage.googleapis.com`, every Google Cloud Storage bucket's endpoint, so allowing it would let a worker upload a checkout to any bucket it has a signed URL for.

A worker needs 8 GB: the lint and knip gates reserve a 6 GiB virtual buffer, which a 4 GB machine refuses, and two attempts at once thrash it ([#270](https://github.com/basaltbytes/usine/issues/270)). cloud-init sets `vm.overcommit_memory=1` and a 2 GB swap file, and installs bubblewrap for Codex's sandbox ([#269](https://github.com/basaltbytes/usine/issues/269)). Create the gateway first. A `cx33` worker takes about four minutes; follow with `ssh -J root@<gateway> usine@<worker> cloud-init status --wait`. `hcloud server describe worker-one` shows its private address.

The worker's sshd accepts `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN` (`AcceptEnv`), which carry the caller token over SSH, out of command lines; if sshd drops them, preflight fails and names them. On existing workers, add `GH_TOKEN` to `/etc/ssh/sshd_config.d/40-usine-gateway.conf` and reload sshd. gh needs both token variables: `GH_TOKEN` serves absolute GitHub pagination links and explicit github.com URLs.

## Log in to the harnesses on the worker

The operator's logins stay on the worker. Connect through the gateway as `usine` and log in to each harness the roster uses:

```sh
ssh -t -J root@<gateway> usine@<worker>
claude auth login          # Claude subscription: open the URL it prints, then paste the code back
codex login --device-auth  # ChatGPT plan: open the URL it prints and enter the code it prints
```

Both use the forward proxy (`HTTPS_PROXY` in `/etc/environment`). `claude auth status` and `codex login status` show the result.

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
- `admin_token_env` names the orchestrator's variable with the admin token from `/etc/usine-gateway/secrets.env`, never the token itself; `usine up` stops if it's unset. For example, keep it in a file only the orchestrator user can read:

  ```sh
  (umask 077; ssh root@<gateway> "sed -n 's/^USINE_GATEWAY_ADMIN_TOKEN=//p' /etc/usine-gateway/secrets.env" > .usine/gateway-admin-token)
  USINE_GATEWAY_ADMIN_TOKEN=$(cat .usine/gateway-admin-token) usine up
  ```

- `llm_providers` lists the providers whose credential the gateway has (empty by default); other harnesses use their login on the worker, as Codex always does. With `anthropic`, Claude Code children call `llm.<domain>/anthropic` with the caller token, preflight checks only the `claude` binary, and the Claude Code hosts must come off `egress-allowlist`.

Preflight attaches nothing. It checks that the admin forward opens (or gives the `ssh` command showing why), the admin API accepts the token, sshd accepts the caller token variables, and the worker reaches `git.<domain>`. For each harness using its worker login, it checks the login and that each login host answers through the forward proxy; a refused host fails with the host to add to `egress-allowlist`. During an attempt, the executor stores its attachment again every two minutes, so a restarted gateway, which keeps attachments in memory, recovers them within two minutes.

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

## Delete the gateway

Delete the workers on the network first, then:

```sh
./gateway.sh delete
```
