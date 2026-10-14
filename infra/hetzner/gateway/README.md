# The usine gateway at Hetzner Cloud

These files create the gateway host of [#223](https://github.com/basaltbytes/usine/issues/223), stage 2, at Hetzner Cloud: a private network, one gateway VM with a public address, and a firewall. Worker VMs on the private network have no public address. [ADR 0027](../../../docs/adr/0027-gateway-credential-proxy.md) records why.

| File | Contents |
| --- | --- |
| `gateway.sh` | Creates and deletes the network, the gateway VM, and its firewall with `hcloud`; installs a packed build; renders a Worker's cloud-init. |
| `gateway-cloud-init.yaml` | The gateway VM: nftables, dnsmasq, sshd settings for a bastion, Node.js, and the `usine-gateway` service. |
| `gateway-nftables.conf` | The gateway's firewall rules. |
| `egress-allowlist` | The hosts Workers may reach through the forward proxy. |
| `worker-cloud-init.yaml` | What a Worker VM needs to work behind the gateway; merge it into the Worker's own cloud-init. |
| `worker-nftables.conf` | A Worker's firewall rules: the gateway only. |

## Traffic paths

The orchestrator reaches a Worker with SSH through the gateway: `ssh -J root@<gateway> <user>@10.42.0.x`. The Hetzner firewall lets only the orchestrator's address reach the gateway's port 22. The gateway's sshd allows local forwarding only, and its nftables rules refuse outbound SSH to anything outside the private network, so the bastion leads to Workers and nowhere else.

The executor reaches the admin API on the gateway's loopback port 7070 through the same SSH connection, for example with `ssh -L 7070:127.0.0.1:7070 root@<gateway>`. It attaches the Attempt's installation token for the Worker and repository there, and passes the caller token it gets back to the Attempt's children through the SSH connection to the Worker.

A Worker resolves names with the gateway's dnsmasq, which answers `git.<domain>` and `llm.<domain>` with the gateway's private address and refuses every other name. The Worker has no default route and no public address, so it cannot open a connection to the internet even with an address in hand; its nftables rules also allow connections to the gateway only.

git and gh on a Worker talk to `git.<domain>` over plain HTTP on the private network. The gateway checks the caller token, replaces it with the attached installation token, and sends the request to github.com, api.github.com, or uploads.github.com over HTTPS. gh reaches the gateway through `/run/usine-gateway/http.sock`, which systemd forwards to the gateway's port 80, because gh speaks only HTTPS to a custom `GH_HOST` and over a Unix socket it speaks plain HTTP. No certificate is needed on either side.

Claude Code and Codex talk to `llm.<domain>` over plain HTTP. The gateway checks the caller token, replaces it with its own API key, and sends the request to the provider over HTTPS. Responses stream back unchanged.

Package managers use the forward proxy at `<gateway>:3128` through `HTTPS_PROXY` and `HTTP_PROXY`, and apt through its own proxy setting. The proxy opens a tunnel only to a host on `egress-allowlist`, only on port 443, only when the client's TLS ClientHello names that same host, and only when the name resolves to a public address. Every other request is refused and logged. Checking the ClientHello keeps one allowed name on a shared CDN address from carrying a connection to another tenant of that address. Before listing a host on a CDN, look at the names its certificate covers and how its CDN routes requests: an HTTP/2 client may reuse an allowed connection for another name on the same certificate ([#240](https://github.com/basaltbytes/usine/issues/240)). A plain HTTP request loses its caller token before it leaves; a `CONNECT` tunnel is opaque, so the proxy cannot remove anything from what goes through it.

Never allowlist github.com or an LLM provider's host such as api.anthropic.com or api.openai.com. A Worker reaches them through `git.<domain>` and `llm.<domain>`, where the gateway decides what it may reach and replaces the caller token; a tunnel to github.com would let a Worker push with any credential it was handed, and Claude Code opens connections to api.anthropic.com outside `ANTHROPIC_BASE_URL`, which would carry whatever credential it has.

The gateway itself reaches the internet directly over its public interface. It forwards no packets for Workers.

## Create a gateway

You need `hcloud` with an active context, an SSH key in the project, and the address the orchestrator connects from.

```sh
ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
ssh root@<gateway> cloud-init status --wait
```

`create` installs `@usine/gateway` from npm. For a build that is not published, set `GATEWAY_PACKAGE=none` and install a tarball made with `pnpm --filter @usine/gateway pack`:

```sh
./gateway.sh install ./usine-gateway-0.1.0.tgz
```

The VM generates its admin token and caller key at first boot in `/etc/usine-gateway/secrets.env`, readable by root only. Add API keys to the same file and restart the service:

```sh
ssh root@<gateway> 'echo ANTHROPIC_API_KEY=sk-ant-... >> /etc/usine-gateway/secrets.env && systemctl restart usine-gateway'
```

`NAME`, `LOCATION`, `SERVER_TYPE`, `IMAGE`, `NETWORK_CIDR`, `SUBNET_CIDR`, `GATEWAY_IP`, `DOMAIN`, and `LABEL` override the defaults at the top of `gateway.sh`. Logs are in the journal, one JSON object per line: `journalctl -u usine-gateway -o cat`.

## Create a Worker behind it

```sh
./gateway.sh worker-user-data > worker.yaml
hcloud server create --name worker-one --type cx23 --image debian-13 --location fsn1 \
  --ssh-key my-key --network usine-gateway --without-ipv4 --without-ipv6 \
  --user-data-from-file worker.yaml
```

The Worker installs its packages through the gateway's proxy, so the gateway must be ready first. Its address on the private network is in `hcloud server describe worker-one`. The file does not create the SSH user or install Node.js and the harnesses; the Worker file of `../cloud-init.yaml` does, but cannot run behind the gateway as it is ([#250](https://github.com/basaltbytes/usine/issues/250)).

The Worker's sshd accepts `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN` from the orchestrator (`AcceptEnv`): the executor sends each Attempt's caller token in them through the SSH connection, so it is in no command line. A Worker whose sshd drops them fails preflight with a message that names them. Existing Workers must add `GH_TOKEN` to `/etc/ssh/sshd_config.d/40-usine-gateway.conf` and reload sshd. Both gh token variables are required: gh uses `GH_TOKEN` for absolute GitHub pagination links and explicit github.com URLs.

## Add the Worker to `usine.yaml`

The orchestrator reaches the Worker through the gateway as its SSH bastion, and the gateway's admin API through a local forward on the same connection. Both go in the orchestrator user's SSH configuration:

```
Host usine-gateway
  HostName 203.0.113.7
  User root
  IdentityFile ~/.ssh/usine_worker
  LocalForward 7070 127.0.0.1:7070

Host worker-one
  HostName 10.42.0.3
  User usine
  ProxyJump usine-gateway
  IdentityFile ~/.ssh/usine_worker
```

Keep the forward open while `usine up` runs, for example with `ssh -N usine-gateway` under a service manager. Then give the Worker a `gateway`:

```yaml
workers:
  - name: worker-one
    kind: ssh
    destination: worker-one
    root: /home/usine/.usine
    gateway:
      domain: gw.internal
      admin_url: http://127.0.0.1:7070
      admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
      llm_providers: [anthropic]
```

- `domain` is the gateway's `DOMAIN`.
- `admin_url` is the admin API as the orchestrator reaches it, here the local forward.
- `admin_token_env` names the orchestrator's environment variable that contains the admin token from `/etc/usine-gateway/secrets.env`; the token itself never goes in the file. `usine up` stops with the variable's name when it is not set.
- `llm_providers` lists the providers whose credential the gateway holds. With `anthropic`, Claude Code children call `llm.<domain>/anthropic` with the caller token, and preflight checks only the `claude` binary on the Worker. Without it, Claude Code would have no route to Anthropic from behind the gateway, so preflight refuses a Claude brain on the Worker. Preflight refuses a Codex brain on any Worker behind a gateway for the same reason ([#244](https://github.com/basaltbytes/usine/issues/244)).

Preflight checks that the admin API answers with the token, that the Worker's sshd accepts the caller token's variables, and that the Worker reaches `git.<domain>`, without attaching anything. While an Attempt runs, the executor stores its attachment again every two minutes, so a restarted gateway, which keeps attachments in memory, has them back within two minutes.

## Delete

Delete the Workers on the network first, then:

```sh
./gateway.sh delete
```
