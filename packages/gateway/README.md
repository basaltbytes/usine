# @usine/gateway

`@usine/gateway` is the service on the gateway host in front of usine's Worker VMs ([ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md), [#223](https://github.com/basaltbytes/usine/issues/223)). Worker VMs have no public address and no GitHub token or API key. They reach GitHub through the gateway, which adds the credential, and an LLM provider either the same way, when the gateway holds that provider's API key, or with the harness's own login on the Worker through the gateway's forward proxy. The forward proxy permits only the hosts on its allowlist: package registries and the hosts of the harness logins.

The gateway serves three things:

- **A reverse proxy** for Worker VMs on the private network. `git.<domain>` serves git smart HTTP at `/OWNER/REPO.git` and the GitHub REST and GraphQL API under `/api/` the way GitHub Enterprise Server does, so `gh` works with `GH_HOST=git.<domain>`. It adds the installation token the executor attached for that Worker and repository. `llm.<domain>` serves the Anthropic API under `/anthropic` and an OpenAI-compatible API under `/openai`, with the gateway's API key. Every other host is refused; the forward proxy serves the allowlisted ones.
- **A forward proxy** for `HTTPS_PROXY` and `HTTP_PROXY`: `CONNECT` on port 443 for HTTPS and absolute-form requests for plain HTTP mirrors, to the hosts on the allowlist only. A tunnel opens only when the client's TLS ClientHello names the CONNECT host itself; a ClientHello that names another host, names none, or uses encrypted ClientHello, and bytes that are not TLS, end the tunnel (`server-name-mismatch`, `server-name-missing`, `not-tls`). It resolves each name itself and refuses a name that resolves to a private, loopback, or link-local address. Before a plain HTTP request leaves for another host, it removes the `X-Usine-Gateway-Token` header and any `Authorization` or `x-api-key` value that is a caller token, and leaves a Worker's other credentials alone.
- **An admin API** for the executor: attach a credential for a Worker and a repository, renew it, detach it, list attachments. It requires the gateway's admin token as a bearer token. Attachments are kept in memory; the executor attaches again when it renews or restarts. A [reload](#reload) keeps them.

Every refused request is logged at warning level as `Gateway refused a request` with the reason, the host, the client address, and the Worker when the caller token names one. Forwarded requests are logged at info level with the Worker, repository, method, path, and status. No token, key, or request body is logged.

## Install

`@usine/gateway` is on npm from 0.1.0. On the gateway host, this installs it with its `usine-gateway` command in `node_modules/.bin`:

```sh
npm install --omit=dev @usine/gateway
```

To run a build that is not released, pack it in a usine checkout with the `@usine/core` it depends on, whose published version can lag behind the checkout, and install both tarballs with one `npm install`:

```sh
pnpm build
pnpm --filter @usine/core --filter @usine/gateway pack --pack-destination .
npm install --omit=dev ./usine-core-<version>.tgz ./usine-gateway-<version>.tgz
```

At Hetzner Cloud, `gateway.sh install` runs either one on the gateway VM and restarts the service; see [`infra/hetzner/gateway/README.md`](../../infra/hetzner/gateway/README.md).

## Entry points

| Import | Contents |
| --- | --- |
| `@usine/gateway` | The platform-free core: `GatewaySettings`, `SettingsInForce` (the allowlist and LLM providers a reload replaces), `Attachments`, `CallerTokens`, `GatewayProxy` (the reverse proxy as an `HttpServerRequest` handler), `adminRoutes` (the admin API for an `HttpRouter`), `gatewayServices`, the egress allowlist parser, and the domain records. It needs an `HttpClient` that leaves `content-encoding` alone. |
| `@usine/gateway/admin` | `GatewayAdminApi`, the admin API contract, for `HttpApiClient.make` in the executor, with the records a client sends and reads: `AttachRequest`, `InstallationCredential`, `Attached`, `AttachmentId`, `CallerToken`, `Detached`, and `AttachmentList`, and `GATEWAY_TOKEN_HEADER`. |
| `@usine/gateway/node` | `gatewayLayer` (the three servers on Node, with undici upstream), `gatewayFromEnvironment`, `settingsFromEnvironment`, `GatewayAddresses`, and `GatewayReload`. |
| `usine-gateway` | The command the gateway VM runs; it reads the settings below, reloads on SIGHUP, and logs one JSON object per line. |

`GatewayDomain` is re-exported from `@usine/core/worker`. Gateway environment settings and Worker configuration use the same lowercase DNS domain schema.

## Attachments and caller tokens

At the start of an Attempt the executor attaches the Attempt's installation token for the Worker and the repository, with the token's expiry:

```http
POST /v1/attachments
Authorization: Bearer <admin token>

{"worker": "worker-one", "repository": "acme/demo",
 "credential": {"_tag": "InstallationCredential", "token": "ghs_..."},
 "expiresAt": "2026-10-13T18:00:00Z"}
```

The answer contains the attachment without the token, including the attachment `id` the gateway assigned, and a caller token, which the executor passes to the Attempt's children in place of every credential. The caller token names the attachment id, the Worker, and the repository, and is signed with the gateway's caller key. Each Attempt gets its own attachment, so two Attempts on one Worker for one repository do not share one.

Before the installation token expires, the executor renews with `PUT /v1/attachments/<id>` and the same body with the new token. The answer carries the same caller token, so the children keep working; after a gateway restart the renewal stores the attachment again under its id. `DELETE /v1/attachments/<id>` detaches; `GET /v1/attachments` lists attachments in force.

The gateway honors a caller token only while its own attachment is in force. After a detach, or when the installation token expires, every request with it is refused, LLM requests included, and a fresh attach for the same Worker and repository gets a new id, so the earlier token stays refused (`stale-caller-token`). A request whose path names another repository than the token is refused. An `AnonymousCredential` attachment adds no credential, which is enough to read a public repository.

A Worker child presents its caller token wherever its tool sends a credential: the `X-Usine-Gateway-Token` header, `Authorization` as `Bearer`, `token`, or `Basic` (password), or `x-api-key`. The gateway removes all of them before it forwards a request.

## A Worker's environment

`infra/hetzner/gateway/worker-cloud-init.yaml` sets up the machine. Per Attempt, the executor adds the caller token, sending each variable that contains it through the SSH connection rather than the command line (the Worker's sshd accepts them with `AcceptEnv`). The Claude Code row applies when the gateway holds the Anthropic credential; otherwise Claude Code, like Codex, uses its login on the Worker and `HTTPS_PROXY`. The Codex row is what a Codex child would need to use the gateway's OpenAI route; the executor does not set it ([#235](https://github.com/basaltbytes/usine/issues/235)).

| Tool | Setting |
| --- | --- |
| git | remote `http://git.<domain>/OWNER/REPO.git`; `GIT_CONFIG_KEY_0=http.http://git.<domain>/.extraHeader`, `GIT_CONFIG_VALUE_0="X-Usine-Gateway-Token: <caller token>"`, and `url.http://git.<domain>/.insteadOf` for `https://github.com/` and `https://git.<domain>/` |
| gh | `GH_HOST=git.<domain>`, `GH_ENTERPRISE_TOKEN=<caller token>`, `GH_TOKEN=<caller token>`; gh's config sets `http_unix_socket: /run/usine-gateway/http.sock`, forwarded to the gateway by `systemd-socket-proxyd`, because gh speaks only HTTPS to a custom host and over that socket it speaks plain HTTP instead |
| Claude Code | `ANTHROPIC_BASE_URL=http://llm.<domain>/anthropic`, `ANTHROPIC_AUTH_TOKEN=<caller token>` |
| Codex | a `model_provider` with `base_url = "http://llm.<domain>/openai/v1"`, `env_key` naming a variable that contains the caller token, `wire_api = "responses"` |
| package managers, harness logins | `HTTPS_PROXY` and `HTTP_PROXY` set to `http://<gateway>:3128`, `NO_PROXY=<domain>` |

A client that sends every request through `HTTPS_PROXY`, as Claude Code does, still reaches `git.<domain>` and `llm.<domain>`: the forward proxy sends port 80 requests for them to the reverse proxy.

## Configuration

`usine-gateway` reads these variables from the environment files that `USINE_GATEWAY_ENVIRONMENT_FILES` names, and from the process environment for any variable no file sets. Without `USINE_GATEWAY_ENVIRONMENT_FILES`, it reads the process environment alone.

| Variable | Meaning |
| --- | --- |
| `USINE_GATEWAY_ENVIRONMENT_FILES` | Environment files separated by `:`, such as `/etc/usine-gateway/settings.env:/etc/usine-gateway/secrets.env`, each with one `KEY=value` per line; quote a value that contains `#`. A variable in a later file overrides the same one in an earlier file and in the process environment. Read from the process environment only. |
| `USINE_GATEWAY_DOMAIN` | The private domain, such as `gw.internal`. Required. |
| `USINE_GATEWAY_ADMIN_TOKEN` | The admin API's bearer token, at least 32 characters. Required. |
| `USINE_GATEWAY_CALLER_KEY` | The HMAC key for caller tokens, at least 32 characters. Required. Changing it invalidates every caller token. |
| `USINE_GATEWAY_EGRESS_ALLOWLIST` | The allowlist file, default `/etc/usine-gateway/egress-allowlist`: one host, or `*.` and a domain, per line, optionally with `:port`; without a port a rule permits 443 and 80. |
| `USINE_GATEWAY_PROXY_HOST`, `_PORT` | The reverse proxy, default `127.0.0.1:80`. |
| `USINE_GATEWAY_EGRESS_HOST`, `_PORT` | The forward proxy, default `127.0.0.1:3128`. |
| `USINE_GATEWAY_ADMIN_HOST`, `_PORT` | The admin API, default `127.0.0.1:7070`. The executor reaches it through its SSH connection to the gateway. |
| `ANTHROPIC_API_KEY` | Sent as `x-api-key` on `/anthropic`. |
| `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | A Claude subscription token from `claude setup-token`, sent as a bearer token with the OAuth beta flag. Not both this and `ANTHROPIC_API_KEY`. See the placeholder swap check below before relying on it. |
| `OPENAI_API_KEY` | Sent as a bearer token on `/openai`. |
| `USINE_GATEWAY_ANTHROPIC_UPSTREAM`, `USINE_GATEWAY_OPENAI_UPSTREAM` | Upstream base URLs, default `https://api.anthropic.com` and `https://api.openai.com`; the OpenAI one can name any OpenAI-compatible provider. |

A provider without a credential is refused with `provider-not-configured`.

## Reload

On SIGHUP, `usine-gateway` reads its environment files and its allowlist file again, and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, the two upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST`. Under systemd, `ExecReload=kill -HUP $MAINPID` in the unit makes `systemctl reload usine-gateway` send it.

A reload leaves the attachments, the admin API, the listening sockets, and open tunnels as they are, so running Attempts keep their GitHub and LLM requests. A tunnel the previous allowlist opened stays open until a side closes it; each new `CONNECT` and plain HTTP request is judged by the new allowlist, and each LLM request after the reload is sent with the new key.

The domain, the listeners, the admin token, and the caller key change only with a restart. The servers stay bound to the addresses they started with, the executor holds the admin token the gateway started with, and a new caller key would refuse every caller token in use, which interrupts running Attempts as a restart does. A reload that finds one of them changed logs `Settings changed that take effect only after a restart` at warning level with the variables' names, and goes on with the rest.

Each reload ends with `Reloaded the gateway settings`, which gives the environment files, the allowlist path and its rule count, whether the allowlist and the providers were reloaded or kept, and the names of the provider settings that changed (`changed`), never their values. A reload keeps what is in force when what it reads cannot be used:

| What is wrong | What the reload keeps | Log line, at error level |
| --- | --- | --- |
| The allowlist cannot be read or does not parse | The previous allowlist | `Kept the previous egress allowlist`, with the path, the line, and what is wrong with it |
| A provider setting is invalid, or both Anthropic credentials are set | The previous providers | `Kept the previous LLM providers` |
| An environment file cannot be read | Everything | `Kept the gateway settings: an environment file could not be read`, with the path |

`systemctl reload` returns once it has sent the signal, before the reload ends; the journal has the result. Variables the process environment set at startup do not change, so a gateway started without environment files reloads its allowlist only.

## Tests

`pnpm --filter @usine/gateway test` runs the unit tests and an end-to-end test that starts the gateway on loopback ports, clones `octocat/Hello-World` through it with git, calls `gh api` through a Unix socket the way a Worker does, and opens a tunnel to `registry.npmjs.org`. It needs network access but no secret.

`pnpm --filter @usine/gateway test:placeholder-swap` checks whether Claude Code works when the Worker has only a caller token as `CLAUDE_CODE_OAUTH_TOKEN` and the gateway sends a subscription token instead. It needs `claude` on `PATH`. Its first case runs Claude Code against a local stand-in for the Anthropic API and asserts what reached it; its second case runs against `api.anthropic.com` with the real token in `CLAUDE_CODE_OAUTH_TOKEN` and is skipped without it.
