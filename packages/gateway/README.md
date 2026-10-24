# @usine/gateway

The service on the gateway host in front of usine's worker VMs ([ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md), [#223](https://github.com/basaltbytes/usine/issues/223)). Worker VMs have no public address, GitHub token, or API key. They reach GitHub through the gateway, which adds the credential. They reach an LLM provider the same way if the gateway has that provider's API key, and otherwise with the harness's own login through the gateway's forward proxy, which allows only allowlisted hosts: package registries and the harness login hosts. [Workers and the gateway](https://docs.usine.dev/architecture/workers-and-gateway/) describes the deployment.

The gateway serves:

- **A reverse proxy** for workers on the private network. `git.<domain>` serves git smart HTTP at `/OWNER/REPO.git`, release downloads, and the GitHub REST and GraphQL API under `/api/`, as GitHub Enterprise Server does, so `gh` works with `GH_HOST=git.<domain>`. It adds the installation token that the executor attached for that worker and repo; see [GitHub paths](#github-paths). `llm.<domain>` serves the Anthropic API under `/anthropic` and an OpenAI-compatible API under `/openai` with the gateway's API key. Other hosts are refused; the forward proxy serves the allowlisted ones.
- **A forward proxy** for `HTTPS_PROXY` and `HTTP_PROXY`: `CONNECT` on port 443 for HTTPS and absolute-form requests for plain HTTP mirrors, to allowlisted hosts only. A tunnel opens only if the client's TLS ClientHello names the CONNECT host. A ClientHello naming another host or none, an encrypted ClientHello, or non-TLS bytes end the tunnel (`server-name-mismatch`, `server-name-missing`, `not-tls`). It resolves each name itself and refuses private, loopback, and link-local addresses. Before a plain HTTP request leaves, it removes `X-Usine-Gateway-Token` and any `Authorization` or `x-api-key` value that is a caller token, and leaves other credentials alone.
- **An admin API** for the executor: attach, renew, detach, and list a worker's repo credentials, and list the [LLM providers](#llm-providers) it has credentials for. It requires the admin token as a bearer token. Attachments are kept in memory; the executor attaches again when it renews or restarts. A [reload](#reload) keeps them.

Refused requests log `Gateway refused a request` at warning level, with the reason, host, client address, and the caller token's worker. Forwarded requests log at info with the worker, repo, method, path, and status, and with the host of the response's `Location` header (`target`), if any; release downloads log as `Served a GitHub release download`. A [rewritten](#github-paths) `Location` header also logs `Rewrote a GitHub Location header to the gateway`, with the original host (`from`) and the new path. No token, key, request body, or query string is logged.

## Install

`@usine/gateway` is on npm from 0.1.0. On the gateway host, this installs it with its `usine-gateway` command in `node_modules/.bin`:

```sh
npm install --omit=dev @usine/gateway
```

To run an unreleased build, pack it in a usine checkout with the `@usine/core` it depends on, whose published version can lag, and install both tarballs with one `npm install`:

```sh
pnpm build
pnpm --filter @usine/core --filter @usine/gateway pack --pack-destination .
npm install --omit=dev ./usine-core-<version>.tgz ./usine-gateway-<version>.tgz
```

On Hetzner Cloud, `gateway.sh install` does either on the gateway VM and restarts the service; see [`infra/hetzner/gateway/README.md`](../../infra/hetzner/gateway/README.md).

## Entry points

| Import | Contents |
| --- | --- |
| `@usine/gateway` | The platform-free core: `GatewaySettings`, `SettingsInForce` (the allowlist and LLM providers that a reload replaces), `Attachments`, `CallerTokens`, `GatewayProxy` (the reverse proxy as an `HttpServerRequest` handler), `adminRoutes` (the admin API for an `HttpRouter`), `gatewayServices`, the egress allowlist parser, and the domain records. It needs an `HttpClient` that leaves `content-encoding` alone. |
| `@usine/gateway/admin` | `GatewayAdminApi`, the admin API contract for `HttpApiClient.make` in the executor, with the records a client sends and reads (`AttachRequest`, `InstallationCredential`, `Attached`, `AttachmentId`, `CallerToken`, `Detached`, `AttachmentList`, `LlmProviderList`) and `GATEWAY_TOKEN_HEADER`. |
| `@usine/gateway/node` | `gatewayLayer` (the three servers on Node, with undici upstream), `gatewayFromEnvironment`, `settingsFromEnvironment`, `GatewayAddresses`, and `GatewayReload`. |
| `usine-gateway` | The gateway VM's command. It reads the settings below, reloads on SIGHUP, and logs one JSON object per line. |

`GatewayDomain` is re-exported from `@usine/core/worker`; gateway settings and worker configuration share its lowercase DNS domain schema.

## Attachments and caller tokens

At the start of an attempt, the executor attaches the attempt's installation token for the worker and repo, with its expiry:

```http
POST /v1/attachments
Authorization: Bearer <admin token>

{"worker": "worker-one", "repository": "acme/demo",
 "credential": {"_tag": "InstallationCredential", "token": "ghs_..."},
 "expiresAt": "2026-10-13T18:00:00Z"}
```

The response has the attachment without the token, including its assigned `id`, and a caller token, which the executor gives the attempt's children in place of every credential. The caller token names the attachment id, worker, and repo, and is signed with the gateway's caller key. Each attempt gets its own attachment, even on a shared worker and repo.

Before the installation token expires, the executor renews with `PUT /v1/attachments/<id>` and the same body with the new token. The response has the same caller token, so children keep working, and after a gateway restart the renewal stores the attachment again under its id. `DELETE /v1/attachments/<id>` detaches; `GET /v1/attachments` lists attachments in force.

A caller token works only while its attachment is in force. After a detach or token expiry, every request with it is refused, LLM requests included, and a new attach for the same worker and repo gets a new id, so the old token stays refused (`stale-caller-token`). A request whose path names another repo than the token is refused. An `AnonymousCredential` attachment adds no credential, which is enough to read a public repo.

A child sends its caller token wherever its tool sends a credential: the `X-Usine-Gateway-Token` header, `Authorization` as `Bearer`, `token`, or `Basic` (password), or `x-api-key`. The gateway removes all of them before forwarding.

## GitHub paths

`git.<domain>` serves these paths with the attachment's installation token. A path that names another repo than the caller token is refused with `repository-mismatch`; other paths, such as web pages, with `unsupported-path`.

| Path on `git.<domain>` | Upstream | Token sent as |
| --- | --- | --- |
| `/OWNER/REPO.git/info/refs`, `/OWNER/REPO.git/git-upload-pack`, `/OWNER/REPO.git/git-receive-pack`, `/OWNER/REPO.git/info/lfs/...`, each also without `.git` | `https://github.com` | the `x-access-token` password |
| `/OWNER/REPO/releases/download/TAG/FILE`, `/OWNER/REPO/releases/latest/download/FILE` | `https://github.com` | the `x-access-token` password |
| `/api/v3/...`, `/api/graphql` | `https://api.github.com` | a bearer token |
| `/api/uploads/...` | `https://uploads.github.com` | a bearer token |

GitHub answers a release download with a redirect to an asset host, such as `release-assets.githubusercontent.com` or `objects.githubusercontent.com`, in a URL signed for that file for a few minutes. The gateway returns the redirect unchanged and doesn't follow it, so the token goes only to github.com. The worker fetches the asset through the forward proxy, which needs the asset hosts on the egress allowlist: the GitHub release assets rows of [`egress-allowlist`](../../infra/hetzner/gateway/egress-allowlist). On a worker, where `GH_TOKEN` holds the caller token:

```sh
curl -fL -u ":$GH_TOKEN" -o tool.tar.gz http://git.<domain>/OWNER/REPO/releases/download/TAG/FILE
```

curl sends `-u` credentials only to the host of the first URL; a header set with `-H` would also reach the asset host.

GitHub redirects some requests for a renamed or transferred repo: API calls to `https://api.github.com/repositories/ID/...`, and release downloads to the new name on github.com. The gateway rewrites a `Location` on github.com or api.github.com to `http://git.<domain>`, with API paths under `/api/v3`, and keeps the path and query, so the client follows it through the gateway. A `Location` on any other host passes unchanged. The gateway checks the followed request like any other, so a redirect to a path with the repo's new name is refused with `repository-mismatch` until the executor attaches the repo under that name.

## LLM providers

`GET /v1/providers` lists the providers the gateway has a credential for, with each credential's kind, never the credential:

```json
{"providers": [{"provider": "anthropic", "credential": "api-key"}]}
```

`credential` is `api-key` for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and `subscription` for `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`. Providers without a credential are absent. The list follows a [reload](#reload). The executor reads it when it checks a worker whose `llm_providers` lists `anthropic`, so usage counts Claude Code children on the gateway's API key in the API keys pool, not the Claude plan ([ADR 0013](../../docs/adr/0013-cost-accounting-native-meters-guardrails.md)). Gateways released before this endpoint answer 404.

## Worker environment

`infra/hetzner/gateway/worker-cloud-init.yaml` sets up the machine. For each attempt, the executor adds the caller token and sends each variable that contains it over the SSH connection, not the command line; the worker's sshd accepts them with `AcceptEnv`. The Claude Code row applies if the gateway has the Anthropic credential; otherwise Claude Code, like Codex, uses its login on the worker and `HTTPS_PROXY`. The Codex row is what a Codex child would need to use the gateway's OpenAI route; the executor doesn't set it ([#235](https://github.com/basaltbytes/usine/issues/235)).

| Tool | Setting |
| --- | --- |
| git | remote `http://git.<domain>/OWNER/REPO.git`; `GIT_CONFIG_KEY_0=http.http://git.<domain>/.extraHeader`, `GIT_CONFIG_VALUE_0="X-Usine-Gateway-Token: <caller token>"`, and `url.http://git.<domain>/.insteadOf` for `https://github.com/` and `https://git.<domain>/` |
| gh | `GH_HOST=git.<domain>`, `GH_ENTERPRISE_TOKEN=<caller token>`, `GH_TOKEN=<caller token>`; gh's config sets `http_unix_socket: /run/usine-gateway/http.sock`, which `systemd-socket-proxyd` forwards to the gateway, because gh speaks only HTTPS to a custom host but plain HTTP over a socket |
| Claude Code | `ANTHROPIC_BASE_URL=http://llm.<domain>/anthropic`, `ANTHROPIC_AUTH_TOKEN=<caller token>` |
| Codex | a `model_provider` with `base_url = "http://llm.<domain>/openai/v1"`, `env_key` naming a variable that contains the caller token, `wire_api = "responses"` |
| package managers, harness logins | `HTTPS_PROXY` and `HTTP_PROXY` set to `http://<gateway>:3128`, `NO_PROXY=<domain>` |

A client that sends every request through `HTTPS_PROXY`, as Claude Code does, still reaches `git.<domain>` and `llm.<domain>`: the forward proxy sends their port 80 requests to the reverse proxy.

## Configuration

The [CLI reference](https://docs.usine.dev/reference/configuration/cli/) lists every `usine-gateway` variable, with defaults and the environment file rules. Changing `USINE_GATEWAY_CALLER_KEY` invalidates every caller token.

The gateway sends `ANTHROPIC_API_KEY` as `x-api-key` on `/anthropic`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` (from `claude setup-token`) as a bearer token with the OAuth beta flag, and `OPENAI_API_KEY` as a bearer token on `/openai`. `USINE_GATEWAY_OPENAI_UPSTREAM` can be any OpenAI-compatible provider. Run the placeholder swap test in [Tests](#tests) before you rely on the subscription token. A provider without a credential is refused with `provider-not-configured`.

## Reload

On SIGHUP, `usine-gateway` rereads its environment files and allowlist, and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, both upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST`. Under systemd, `ExecReload=kill -HUP $MAINPID` makes `systemctl reload usine-gateway` send it.

Attachments, the admin API, listening sockets, and open tunnels stay, so running attempts keep their GitHub and LLM requests. An open tunnel stays until a side closes it; each new `CONNECT` or plain HTTP request uses the new allowlist, and each later LLM request the new key. The domain, listeners, admin token, and caller key change only with a restart. A reload that finds one of them changed logs `Settings changed that take effect only after a restart` at warning level with the variable names, and applies the rest.

Each reload ends with `Reloaded the gateway settings`, which gives the environment files, the allowlist path and rule count, whether the allowlist and providers were reloaded or kept, and the names, never values, of changed provider settings (`changed`). Unusable input keeps what's in force:

| Problem | The reload keeps | Log line, at error level |
| --- | --- | --- |
| The allowlist can't be read or doesn't parse | The previous allowlist | `Kept the previous egress allowlist`, with the path, the line, and the problem |
| A provider setting is invalid, or both Anthropic credentials are set | The previous providers | `Kept the previous LLM providers` |
| An environment file can't be read | Everything | `Kept the gateway settings: an environment file could not be read`, with the path |

`systemctl reload` returns before the reload ends; the journal has the result. Variables from the process environment at startup don't change, so a gateway without environment files reloads only its allowlist.

## Tests

`pnpm --filter @usine/gateway test` runs the unit tests and an end-to-end test that starts the gateway on loopback ports, clones `octocat/Hello-World` through it, calls `gh api` through a Unix socket as a worker does, and opens a tunnel to `registry.npmjs.org`. It needs network access but no secret.

`pnpm --filter @usine/gateway test:placeholder-swap` checks whether Claude Code works when the worker has only a caller token as `CLAUDE_CODE_OAUTH_TOKEN` and the gateway sends a subscription token instead. It needs `claude` on `PATH`. The first case runs Claude Code against a local stand-in for the Anthropic API and checks what reached it. The second runs against `api.anthropic.com` with the real token in `CLAUDE_CODE_OAUTH_TOKEN`, and is skipped without it.
