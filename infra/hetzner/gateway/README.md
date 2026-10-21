# The usine gateway at Hetzner Cloud

These files create the gateway host of [#223](https://github.com/basaltbytes/usine/issues/223), stage 2, at Hetzner Cloud: a private network, one gateway VM with a public address, and a firewall. Worker VMs on the private network have no public address. [ADR 0027](../../../docs/adr/0027-gateway-credential-proxy.md) records why.

| File | Contents |
| --- | --- |
| `gateway.sh` | Creates and deletes the network, the gateway VM, and its firewall with `hcloud`; installs `@usine/gateway` from npm or from packed tarballs; renders a Worker's cloud-init. |
| `gateway-cloud-init.yaml` | The gateway VM: nftables, dnsmasq, chrony, sshd settings for a bastion, Node.js, and the `usine-gateway` service. |
| `gateway-nftables.conf` | The gateway's firewall rules. |
| `egress-allowlist` | The hosts Workers may reach through the forward proxy: package hosts and the harness logins' hosts. |
| `worker-cloud-init.yaml` | What a Worker VM needs to work behind the gateway; `gateway.sh worker-user-data` sends it after the Worker file of `../cloud-init.yaml`. |
| `worker-nftables.conf` | A Worker's firewall rules: the gateway only. |

## Traffic paths

The orchestrator reaches a Worker with SSH through the gateway: `ssh -J root@<gateway> <user>@10.42.0.x`. The Hetzner firewall lets only the orchestrator's address reach the gateway's port 22. The gateway's sshd allows local forwarding only, and its nftables rules refuse outbound SSH to anything outside the private network, so the bastion leads to Workers and nowhere else.

The executor reaches the admin API on the gateway's loopback port 7070 through an SSH forward to the gateway that it opens itself, `ssh -N -L 127.0.0.1:<port>:127.0.0.1:7070 <gateway>`, on a local port the kernel picks. It opens the forward when `usine up` starts and opens it again whenever it closes. It attaches the Attempt's installation token for the Worker and repository there, and passes the caller token it gets back to the Attempt's children through the SSH connection to the Worker.

A Worker resolves names with the gateway's dnsmasq, which answers `git.<domain>` and `llm.<domain>` with the gateway's private address and refuses every other name. It answers an AAAA query for the gateway's own names with no address rather than a refusal: musl's resolver, which the Codex binary uses, asks for A and AAAA together and fails the whole lookup when either is refused, so Codex could not resolve the forward proxy at `<domain>:3128` ([#260](https://github.com/basaltbytes/usine/issues/260)). The Worker has no default route and no public address, so it cannot open a connection to the internet even with an address in hand; its nftables rules also allow connections to the gateway only.

A Worker sets its clock from the gateway. The gateway runs chrony, which syncs from Hetzner's time servers (`ntp1.hetzner.de`, `ntp2.hetzner.com`, `ntp3.hetzner.net`) and the Debian pool, and answers NTP queries from the private network only. systemd-timesyncd on the Worker asks the gateway's private address, so it looks up no name, and the Worker's nftables rules allow UDP port 123 to the gateway. chrony answers each query itself and forwards nothing, so NTP is no way out of the private network.

git and gh on a Worker talk to `git.<domain>` over plain HTTP on the private network. The gateway checks the caller token, replaces it with the attached installation token, and sends the request to github.com, api.github.com, or uploads.github.com over HTTPS. gh reaches the gateway through `/run/usine-gateway/http.sock`, which systemd forwards to the gateway's port 80, because gh speaks only HTTPS to a custom `GH_HOST` and over a Unix socket it speaks plain HTTP. No certificate is needed on either side.

Claude Code and Codex use the operator's logins on the Worker, a Claude subscription and a ChatGPT plan, as on a Worker without a gateway, and reach their providers through the forward proxy below. When the gateway holds a provider's credential instead (`llm_providers` in `usine.yaml`), Claude Code talks to `llm.<domain>` over plain HTTP: the gateway checks the caller token, replaces it with its own API key, and sends the request to the provider over HTTPS. Responses stream back unchanged.

Package managers and the harness logins use the forward proxy at `<gateway>:3128` through `HTTPS_PROXY` and `HTTP_PROXY`, and apt through its own proxy setting. The proxy opens a tunnel only to a host on `egress-allowlist`, only on port 443, only when the client's TLS ClientHello names that same host, and only when the name resolves to a public address. Every other request is refused and logged. Checking the ClientHello keeps one allowed name on a shared CDN address from carrying a connection to another tenant of that address. Before listing a host on a CDN, look at the names its certificate covers and how its CDN routes requests: an HTTP/2 client may reuse an allowed connection for another name on the same certificate ([#240](https://github.com/basaltbytes/usine/issues/240)). A plain HTTP request loses its caller token before it leaves; a `CONNECT` tunnel is opaque, so the proxy cannot remove anything from what goes through it.

Never allowlist github.com, and never a provider whose credential the gateway holds. A Worker reaches them through `git.<domain>` and `llm.<domain>`, where the gateway decides what it may reach and replaces the caller token; a tunnel to github.com would let a Worker push with any credential it was handed, and Claude Code opens connections to api.anthropic.com outside `ANTHROPIC_BASE_URL`, which would carry the caller token. So when the gateway holds the Anthropic credential, remove the Claude Code hosts from `egress-allowlist`.

The gateway itself reaches the internet directly over its public interface. It forwards no packets for Workers.

### Which path each client takes

Seen in the gateway's journal and dnsmasq's query log on 2026-10-15, with the environment the executor gives an Attempt's children (`HTTPS_PROXY=http://<domain>:3128`):

| Client | Path | Names it resolves on the Worker |
| --- | --- | --- |
| git | `git.<domain>` over plain HTTP; `NO_PROXY` lists the domain | `git.<domain>` |
| gh | `/run/usine-gateway/http.sock`, which systemd forwards to the gateway's port 80 | none |
| curl, npm, pnpm | the forward proxy, through `HTTPS_PROXY` and `HTTP_PROXY` | `<domain>` |
| apt | the forward proxy, through its own proxy setting with the gateway's address | none |
| Claude Code 2.1.296 | the forward proxy, for the model API and the login | `<domain>` |
| Codex 0.153.4 | the forward proxy, for the Responses API WebSocket, its HTTPS fallback, the plugin-sync MCP client at `chatgpt.com/backend-api/ps/mcp`, and the login | `<domain>`, A and AAAA |

No client resolved a provider's or a registry's name itself.

### The harness logins' hosts

`egress-allowlist` lists these hosts in its harness logins section. They were found on a Debian 13 Worker behind the gateway with Claude Code 2.1.296 and Codex 0.153.4, in the gateway's journal, while each login command ran up to its code and while each harness sent a prompt with a made-up login; no other host was asked for. No login was completed, so the calls that follow a successful login are known from the URLs in Claude Code's binary: they go to `api.anthropic.com`.

| Harness and login | Host | What calls it |
| --- | --- | --- |
| Claude Code, `claude auth login` | `api.anthropic.com` | Model requests, and the account's profile and roles after the login. |
| | `platform.claude.com` | The OAuth token exchange when the login's code is pasted, and every token refresh. |
| Codex, `codex login --device-auth` | `chatgpt.com` | Model requests: the Responses API over a WebSocket at `wss://chatgpt.com/backend-api/codex/responses`, which the proxy tunnels like any HTTPS connection. |
| | `auth.openai.com` | The device code, the token exchange once the code is entered, and every token refresh. |

The URL each login prints opens in the operator's browser, not on the Worker: `claude.com/cai/oauth/authorize` and `auth.openai.com/codex/device`. Preflight checks that the Worker reaches each host through the forward proxy (see below).

With both logins completed, a one-prompt turn of each harness also asks for hosts the allowlist does not list, and completes without them: Claude Code for `mcp-proxy.anthropic.com`, the claude.ai connectors, and Codex for `ab.chatgpt.com` and `sdmntpr<region>.oaiusercontent.com` ([#261](https://github.com/basaltbytes/usine/issues/261)).

About [#240](https://github.com/basaltbytes/usine/issues/240): all four hosts are behind Cloudflare. The certificate of `api.anthropic.com` and of `platform.claude.com` covers that name only; `chatgpt.com` also covers `amb-staging.chatgpt.com` and its subdomains, and `auth.openai.com` covers `*.auth.openai.com`, so a client that reuses an HTTP/2 connection for another name on the certificate reaches only the same provider. Through a tunnel to each host, a request with the `Host` header of another site (`claude.ai`, `claude.com`, `www.cloudflare.com`, `api.openai.com`) got `403 Forbidden` from Cloudflare (checked on 2026-10-15). Claude Code opens one tunnel to `api.anthropic.com` per prompt and closes it before its ClientHello; the gateway logs that tunnel at info level as abandoned, not as a refusal.

## Create a gateway

You need `hcloud` with an active context, an SSH key in the project, and the address the orchestrator connects from. `SSH_KEY` takes several key names or ids separated by commas.

```sh
ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
ssh root@<gateway> cloud-init status --wait
```

`create` installs no gateway service. Once cloud-init is done, `install` installs `@usine/gateway` into `/opt/usine-gateway` and restarts the service. `-i` names the private key for its `ssh` and `scp`, such as the dedicated key of [`../README.md`](../README.md); without it they use your SSH agent and configuration. `@usine/gateway` is on npm from 0.1.0; `install` installs the latest release, or the version you name, such as `@usine/gateway@0.1.0`:

```sh
./gateway.sh install -i ~/.ssh/usine_worker @usine/gateway
```

To run a build that is not released, build it in a usine checkout and pack it with the `@usine/core` it depends on, whose published version can lag behind the checkout:

```sh
pnpm build
pnpm --filter @usine/core --filter @usine/gateway pack
```

`pnpm pack` writes one tarball per package in its folder, named after the package version, such as `packages/core/usine-core-0.3.0.tgz` and `packages/gateway/usine-gateway-0.0.0.tgz`; `--pack-destination <dir>` puts both in one folder. Given tarballs, `install` copies them to the gateway before it installs them:

```sh
./gateway.sh install -i ~/.ssh/usine_worker ./usine-core-0.3.0.tgz ./usine-gateway-0.0.0.tgz
```

Run `install` again with another version or new tarballs to upgrade the gateway.

The VM generates its admin token and caller key at first boot in `/etc/usine-gateway/secrets.env`, readable by root and the `usine-gateway` group. The service reads `settings.env` and `secrets.env` itself, at startup and on every reload, from the paths its unit sets in `USINE_GATEWAY_ENVIRONMENT_FILES`. Add API keys to the same file and reload the service:

```sh
ssh root@<gateway> 'echo ANTHROPIC_API_KEY=sk-ant-... >> /etc/usine-gateway/secrets.env && systemctl reload usine-gateway'
```

`NAME`, `LOCATION`, `SERVER_TYPE`, `IMAGE`, `NETWORK_CIDR`, `SUBNET_CIDR`, `GATEWAY_IP`, `DOMAIN`, and `LABEL` override the defaults at the top of `gateway.sh`. Logs are in the journal, one JSON object per line: `journalctl -u usine-gateway -o cat`.

An existing gateway whose `/etc/dnsmasq.d/usine-gateway.conf` has no `local=/<domain>/` line needs it, then `systemctl restart dnsmasq`; without it Codex on a Worker cannot resolve the forward proxy ([#260](https://github.com/basaltbytes/usine/issues/260)).

## Change the allowlist or an API key

The gateway reads its allowlist from `/etc/usine-gateway/egress-allowlist` on the VM; `create` copies `egress-allowlist` there once. Edit that file, or `secrets.env`, then reload the service and read the result in the journal:

```sh
ssh root@<gateway> 'systemctl reload usine-gateway && sleep 1 && journalctl -u usine-gateway -o cat -n 5'
```

A reload keeps the attachments, so the GitHub and LLM requests of running Attempts go on without a refusal. A restart forgets them, and the gateway refuses those requests until the executor stores the attachments again, within two minutes. `systemctl reload` returns once it has sent the signal: the `Reloaded the gateway settings` line in the journal gives the allowlist's rule count and the names of the API keys that changed, never their values. An allowlist that does not parse keeps the previous one, and the journal says which line is wrong. Tunnels already open stay open; new connections are judged by the new allowlist. The domain, the listeners, the admin token, and the caller key change only with `systemctl restart usine-gateway`, and a reload that finds one of them changed logs it as needing a restart. See [Reload](../../../packages/gateway/README.md#reload) in the package README.

A gateway created before reload existed has `EnvironmentFile=` lines in its unit and a `secrets.env` only root can read. Install a gateway build that reloads first: an earlier `usine-gateway` ignores `USINE_GATEWAY_ENVIRONMENT_FILES` and exits on SIGHUP. Then, as root on the gateway, let the service read `secrets.env`:

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

## Create a Worker behind it

`worker-user-data` takes a file of public keys, one per line, to authorize for the `usine` user:

```sh
./gateway.sh worker-user-data ~/.ssh/usine_worker.pub > worker.mime
hcloud server create --name worker-one --type cx33 --image debian-13 --location fsn1 \
  --ssh-key my-key --network usine-gateway --without-ipv4 --without-ipv6 \
  --label usine=worker --user-data-from-file worker.mime
```

The output is a MIME multipart cloud-init of two files. The first is the Worker file of `../cloud-init.yaml`, the same one a Worker without a gateway gets: the `usine` user, Git, gh, Node.js 24, pnpm, Claude Code, Codex, and Chromium. The second is `worker-cloud-init.yaml`. cloud-init merges them, appending the second file's lists (packages, files, commands) to the first's, as its `Merge-Type` header says. The second file points the resolver, apt, and `/etc/environment` at the gateway, and the first file's setup script reads `/etc/environment`, so the toolchain installs through the forward proxy: Debian packages from `deb.debian.org` and `mirror.hetzner.com`, gh from `cli.github.com`, Node.js from `deb.nodesource.com`, and pnpm and the harnesses from `registry.npmjs.org`.

Chromium is Debian's package, which a project's Playwright tests use through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (see [`../README.md`](../README.md)). `egress-allowlist` does not list Playwright's own browser download: on x64 Linux, Playwright 1.61 fetches Chromium from `cdn.playwright.dev`, which redirects to `storage.googleapis.com`, the endpoint of every Google Cloud Storage bucket, so listing it would let a Worker upload a checkout to any bucket it has a signed URL for.

A Worker needs 8 GB of memory: the repository's lint and knip gates reserve a 6 GiB virtual buffer, which the kernel refuses on a 4 GB machine, and two Attempts' installs and checks at once thrash it ([#270](https://github.com/basaltbytes/usine/issues/270)). cloud-init sets `vm.overcommit_memory=1` and a 2 GB swap file, and installs bubblewrap for Codex's sandbox ([#269](https://github.com/basaltbytes/usine/issues/269)). The gateway must be ready first. The Worker takes about four minutes on a `cx33`; follow it with `ssh -J root@<gateway> usine@<worker> cloud-init status --wait`. Its address on the private network is in `hcloud server describe worker-one`.

The Worker's sshd accepts `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN` from the orchestrator (`AcceptEnv`): the executor sends each Attempt's caller token in them through the SSH connection, so it is in no command line. A Worker whose sshd drops them fails preflight with a message that names them. Existing Workers must add `GH_TOKEN` to `/etc/ssh/sshd_config.d/40-usine-gateway.conf` and reload sshd. Both gh token variables are required: gh uses `GH_TOKEN` for absolute GitHub pagination links and explicit github.com URLs.

## Log in to the harnesses on the Worker

The logins are the operator's and stay on the Worker. Connect through the gateway as the `usine` user and log in to each harness the roster uses:

```sh
ssh -t -J root@<gateway> usine@<worker>
claude auth login          # Claude subscription: open the URL it prints, then paste the code back
codex login --device-auth  # ChatGPT plan: open the URL it prints and enter the code it prints
```

Both commands reach their providers through the forward proxy, since `/etc/environment` on the Worker sets `HTTPS_PROXY`. `claude auth status` and `codex login status` show the result.

## Add the Worker to `usine.yaml`

The orchestrator reaches the Worker through the gateway as its SSH bastion, and the gateway's admin API through a forward that the executor opens to the gateway. Both hosts go in the orchestrator user's SSH configuration:

```
Host usine-gateway
  HostName 203.0.113.7
  User root
  IdentityFile ~/.ssh/usine_worker

Host worker-one
  HostName 10.42.0.3
  User usine
  ProxyJump usine-gateway
  IdentityFile ~/.ssh/usine_worker
```

The gateway's entry has no `LocalForward`: it would also apply to the executor's forward, which then exits whenever that port is taken. To reach the admin API by hand, open a forward on the command line, for example `ssh -N -L 7070:127.0.0.1:7070 usine-gateway`; it does not interfere with the executor's. Then give the Worker a `gateway`:

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
- `destination` is what the orchestrator's `ssh` connects to for the gateway, here its `Host` alias. The executor opens its forward to the admin API through it when `usine up` starts and opens it again whenever it closes, after a pause of one second that doubles up to one minute, or at once when an admin request needs it. An admin request that finds the forward closed, or gets no answer through it, is sent once more through a new forward.
- `admin_port` is the admin API's port on the gateway, `USINE_GATEWAY_ADMIN_PORT` in `/etc/usine-gateway/settings.env`. It defaults to 7070, the gateway's own default.
- `admin_token_env` names the orchestrator's environment variable that contains the admin token from `/etc/usine-gateway/secrets.env`; the token itself never goes in the file. `usine up` stops with the variable's name when it is not set. One way to keep it is a file only the orchestrator user can read:

  ```sh
  (umask 077; ssh root@<gateway> "sed -n 's/^USINE_GATEWAY_ADMIN_TOKEN=//p' /etc/usine-gateway/secrets.env" > .usine/gateway-admin-token)
  USINE_GATEWAY_ADMIN_TOKEN=$(cat .usine/gateway-admin-token) usine up
  ```

- `llm_providers` lists the providers whose credential the gateway holds, and is empty when left out. Without a provider, its harness uses the login on the Worker. With `anthropic`, Claude Code children call `llm.<domain>/anthropic` with the caller token instead, preflight checks only the `claude` binary on the Worker, and the Claude Code hosts must come off `egress-allowlist`. Codex always uses its login on the Worker.

Preflight checks that the executor's forward to the admin API opens, and gives the `ssh` command to run to see why when it does not, then that the admin API answers with the token, that the Worker's sshd accepts the caller token's variables, and that the Worker reaches `git.<domain>`, without attaching anything. For each rostered harness that uses its login on the Worker, it checks the login as on a Worker without a gateway, then that the Worker gets an answer from each of the login's hosts through the forward proxy. A host the proxy refuses fails preflight with the host to add to `egress-allowlist`. While an Attempt runs, the executor stores its attachment again every two minutes, so a restarted gateway, which keeps attachments in memory, has them back within two minutes.

## Add the time server to an existing gateway and Worker

A gateway and Workers created before chrony was in these files need the steps below to give the Workers a time source ([#254](https://github.com/basaltbytes/usine/issues/254)). Nothing applies infra changes to a running machine yet ([#264](https://github.com/basaltbytes/usine/issues/264)), so they are by hand. They use the default `NETWORK_CIDR` and `GATEWAY_IP`, `10.42.0.0/16` and `10.42.0.2`; use yours if you changed them. Do the gateway first, since the Worker's timesyncd needs the gateway's chrony to answer.

On the gateway, as root (`ssh root@<gateway>`):

1. Write chrony's settings for the gateway: Hetzner's time servers, and the private network as clients.

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

4. Check. Within a minute `chronyc sources` marks one source with `^*`, and `timedatectl` shows:

   ```
   System clock synchronized: yes
   NTP service: active
   ```

A Worker rebuilt from `worker-user-data` gets the time server without these steps, but loses the harness logins. On a running Worker the `usine` user has no sudo and root cannot log in over SSH, so the steps run as root through `su` in an SSH session as `usine`:

1. Give root a password with `hcloud server reset-password <worker>`, which prints it. Connect to the Worker through the gateway and switch to root with that password:

   ```sh
   ssh -t <worker> 'su -'
   ```

   Here `<worker>` is the Worker's `Host` entry in the orchestrator user's SSH configuration, which jumps through the gateway (see [Add the Worker to `usine.yaml`](#add-the-worker-to-usineyaml)). When SSH to the Worker does not work, open the server's console in the Hetzner Cloud Console and log in there as root with the same password.

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

## Delete

Delete the Workers on the network first, then:

```sh
./gateway.sh delete
```
