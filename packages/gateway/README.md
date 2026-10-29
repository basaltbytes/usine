# @usine/gateway

The service on the gateway host in front of usine's worker VMs ([ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md), [#223](https://github.com/basaltbytes/usine/issues/223)). Worker VMs have no public address, GitHub token, API key, or subscription login. They reach GitHub through the gateway, which adds the credential. They reach an LLM provider the same way if the gateway has that provider's credential: an API key, a Claude subscription token, or a ChatGPT login. Otherwise they use the harness's own login through the gateway's forward proxy, which allows only allowlisted hosts: package registries and the harness login hosts. [Workers and the gateway](https://docs.usine.dev/architecture/workers-and-gateway/) describes the deployment.

The gateway serves:

- **A reverse proxy** for workers on the private network. `git.<domain>` serves git smart HTTP at `/OWNER/REPO.git`, release downloads, and the GitHub REST and GraphQL API under `/api/`, as GitHub Enterprise Server does, so `gh` works with `GH_HOST=git.<domain>`. It adds the installation token that the executor attached for that worker and repo; see [GitHub paths](#github-paths). `llm.<domain>` serves the Anthropic API under `/anthropic`, and under `/openai` an OpenAI-compatible API or, with a [ChatGPT login](#chatgpt-login), the ChatGPT backend that Codex uses, with the gateway's credential. Other hosts are refused; the forward proxy serves the allowlisted ones.
- **A forward proxy** for `HTTPS_PROXY` and `HTTP_PROXY`: `CONNECT` on port 443 for HTTPS and absolute-form requests for plain HTTP mirrors, to allowlisted hosts only. A tunnel opens only if the client's TLS ClientHello names the CONNECT host. A ClientHello naming another host or none, an encrypted ClientHello, or non-TLS bytes end the tunnel (`server-name-mismatch`, `server-name-missing`, `not-tls`). It resolves each name itself and refuses private, loopback, and link-local addresses. Before a plain HTTP request leaves, it removes `X-Usine-Gateway-Token` and any `Authorization` or `x-api-key` value that is a caller token, and leaves other credentials alone.
- **An admin API** for the executor: attach, renew, detach, and list a worker's repo credentials, and list the [LLM providers](#llm-providers) it has credentials for. It requires the admin token as a bearer token. The gateway command persists encrypted attachments across restarts. A [reload](#reload) keeps them.

Refused requests log `Gateway refused a request` at warning level, with the reason, host, client address, and the caller token's worker. Forwarded requests log at info with the worker, repo, method, path, and status, and with the host of the response's `Location` header (`target`), if any; release downloads log as `Served a GitHub release download`. A [rewritten](#github-paths) `Location` header also logs `Rewrote a GitHub Location header to the gateway`, with the original host (`from`) and the new path. A repo's [new name](#github-paths) that an attachment learns from GitHub logs `Learned the new name of an attached repository`, with `newName`; a new name that GitHub's API doesn't confirm logs `GitHub's API didn't confirm the new name of an attached repository` at warning level, with `newName` and the `reason`. A ChatGPT login logs each load, refresh, and failure; see [ChatGPT login](#chatgpt-login). No token, key, request body, or query string is logged.

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
| `@usine/gateway` | The platform-free core: `GatewaySettings`, `SettingsInForce` (the allowlist and LLM providers that a reload replaces), `Attachments`, `CallerTokens`, `ChatGptLogins` (the ChatGPT logins and their refresh), `GatewayProxy` (the reverse proxy as an `HttpServerRequest` handler), `adminRoutes` (the admin API for an `HttpRouter`), `gatewayServices`, the egress allowlist parser, and the domain records. It needs an `HttpClient` that leaves `content-encoding` alone and returns redirects without following them, and a `FileSystem` for ChatGPT auth files. |
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

Before the installation token expires, the executor renews with `PUT /v1/attachments/<id>` and the same body with the new token. Renewal returns the same caller token and recreates a missing attachment under its original ID. The executor also restores each live attachment every two minutes, so lost state recovers without changing a running child's environment. `DELETE /v1/attachments/<id>` detaches; `GET /v1/attachments` lists attachments in force.

The `usine-gateway` command saves attachments to `attachments.enc` in `STATE_DIRECTORY`, which systemd sets from `StateDirectory=usine-gateway`. Outside systemd, set `STATE_DIRECTORY` to a writable directory; it defaults to `/var/lib/usine-gateway`. The snapshot includes credentials, expiry, attachment IDs, workers, repositories, and learned repository names. AES-256-GCM encrypts and authenticates the snapshot with a purpose-specific key derived from `USINE_GATEWAY_CALLER_KEY`. Files have mode 0600 and are replaced atomically before a mutation succeeds. A failed write returns 503 and preserves the live state.

Startup restores unexpired attachments before opening any listener. Caller tokens use deterministic HMAC signatures, so the saved attachment claims and the unchanged caller key preserve the original tokens without a separate token table. Keep the state directory and caller key across upgrades and configuration changes. A corrupt snapshot or a different caller key stops startup without replacing the file. To rotate the caller key, finish running attempts, stop the gateway, and remove its old snapshot before starting with the new key.

On SIGTERM, the gateway stops accepting connections and closes idle sockets, active requests, and CONNECT tunnels before exiting. Clients must reconnect after a restart; their caller tokens remain valid.

Embedded gateways use `Attachments.layer` in memory by default. Use `Attachments.layerWithPersistence` with `gatewayServicesWithAttachments`, or supply an attachment layer to `gatewayLayer`, to persist an embedded gateway's state.

A caller token works only while its attachment is in force. After a detach or token expiry, every request with it is refused, LLM requests included, and a new attach for the same worker and repo gets a new id, so the old token stays refused (`stale-caller-token`). A request whose path names another repo than the token is refused. An `AnonymousCredential` attachment adds no credential, which is enough to read a public repo.

A child sends its caller token wherever its tool sends a credential: the `X-Usine-Gateway-Token` header, `Authorization` as `Bearer`, `token`, or `Basic` (password), or `x-api-key`. The gateway removes all of them before forwarding.

## GitHub paths

`git.<domain>` serves these paths with the attachment's installation token. A path that names another repo than the caller token is refused with `repository-mismatch`, unless it's the repo's new name after a rename (see below); other paths, such as web pages, with `unsupported-path`. Paths that name no repo, such as `/api/graphql`, `/api/v3/user`, and `/api/v3/repositories/ID/...`, have no repo for the gateway to check: the installation token, issued for the attempt's repo only, limits them.

| Path on `git.<domain>` | Upstream | Token sent as |
| --- | --- | --- |
| `/OWNER/REPO.git/info/refs`, `/OWNER/REPO.git/git-upload-pack`, `/OWNER/REPO.git/git-receive-pack`, `/OWNER/REPO.git/info/lfs/...`, each also without `.git` | `https://github.com` | the `x-access-token` password |
| `/OWNER/REPO/releases/download/TAG/FILE`, `/OWNER/REPO/releases/latest/download/FILE` | `https://github.com` | the `x-access-token` password |
| `/api/v3/...`, `/api/graphql` | `https://api.github.com` | a bearer token |
| `/api/uploads/...` | `https://uploads.github.com` | a bearer token |

For a `GET` on these download paths, the gateway follows GitHub's redirect to the download host and streams its response to the worker:

| Path | Download |
| --- | --- |
| `/api/v3/repos/OWNER/REPO/actions/jobs/ID/logs` | Job log |
| `/api/v3/repos/OWNER/REPO/actions/runs/ID/logs` | Run logs |
| `/api/v3/repos/OWNER/REPO/actions/runs/ID/attempts/NUMBER/logs` | Run attempt logs |
| `/api/v3/repos/OWNER/REPO/actions/artifacts/ID/zip` | Artifact ZIP |
| `/api/v3/repos/OWNER/REPO/releases/assets/ID` | Release asset with `Accept: application/octet-stream` |
| `/OWNER/REPO/releases/download/TAG/FILE`, `/OWNER/REPO/releases/latest/download/FILE` | Release asset |

The attachment must serve the repository in the path. The API paths also work directly on `api.github.com`, without `/api/v3`, when gh uses its socket. `gh run view --log`, `gh run view --log-failed`, `gh run download`, and `gh release download` can use these paths without connecting to download hosts themselves. curl can use the same gateway paths:

```sh
curl -fL -u ":$GH_TOKEN" -o tool.tar.gz http://git.<domain>/OWNER/REPO/releases/download/TAG/FILE
```

Each followed request is a fresh GET with no worker headers, cookies, credential, or body. The gateway follows at most three HTTPS redirects and returns 502 for an invalid location or a longer chain. It preserves the final response's status, end-to-end headers, and streamed body. An initial redirect to GitHub itself retains the repository checks described below. Other methods and paths retain their existing redirect behavior.

The download hosts, including `results-receiver.actions.githubusercontent.com` and Azure Blob Storage, need no egress allowlist entry. The gateway trusts GitHub to choose the destination for these fixed download paths; workers cannot use this behavior to request arbitrary URLs. [ADR 0027](../../docs/adr/0027-gateway-credential-proxy.md) records this exception to the allowlist model. Each followed redirect logs `Following a GitHub download redirect without credentials`, with the attachment, worker, repository, target host, status, and redirect count. Signed URLs and headers are excluded from logs and client traces.

Repository archives retain their redirects to `codeload.github.com`. Download them with curl through the forward proxy, with that host on the egress allowlist:

```sh
curl -fL -u ":$GH_TOKEN" -o repo.tar.gz http://git.<domain>/api/v3/repos/OWNER/REPO/tarball/REF
```

curl sends `-u` credentials only to the host of the first URL; a header set with `-H` would also reach the archive host. gh sends redirected requests through its socket, where the reverse proxy refuses these hosts with `unknown-host`.

GitHub redirects some requests for a renamed or transferred repo: API calls to `https://api.github.com/repositories/ID/...`, and release downloads to the new name on github.com. The gateway rewrites a `Location` on github.com or api.github.com to `http://git.<domain>`, with API paths under `/api/v3`, and keeps the path and query, so the client follows it through the gateway. A `Location` on another host passes unchanged except for the download GETs listed above.

The gateway checks the followed request like any other. An attachment learns the repo's new name only from a permanent redirect (301 or 308) of the repo itself to the same path with another owner or repo name: git's `/OWNER/REPO/info/refs`, which starts every clone and fetch, or the API's `/repos/OWNER/REPO`. Before the attachment learns the name, the gateway confirms it with GitHub's API and the attachment's credential: `/repos/OWNER/REPO` with the attached name must redirect to `/repositories/ID`, and the `full_name` of that repo must be the new name. The attachment then serves paths with either name until it's detached or expires. Other attachments, temporary redirects, redirects of anything else, such as a release download or `/repositories/ID/...`, and names that the API doesn't confirm teach no name, so a path with another name is still refused with `repository-mismatch`. A release download under the repo's former name works once a git clone or fetch under that name has taught the attachment the new name.

## LLM providers

`GET /v1/providers` lists the providers the gateway has a credential for, with each credential's kind, never the credential:

```json
{"providers": [{"provider": "anthropic", "credential": "api-key"}]}
```

`credential` is `api-key` for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and `subscription` for `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` and `USINE_GATEWAY_CHATGPT_AUTH_FILE`. Providers without a credential are absent. The list follows a [reload](#reload). The executor reads it when it checks a worker whose `llm_providers` lists a provider, so usage counts Claude Code and Codex children on the gateway's API key in the API keys pool, and on a subscription in the Claude or ChatGPT plan pool ([ADR 0013](../../docs/adr/0013-cost-accounting-native-meters-guardrails.md)). Gateways released before this endpoint answer 404.

## Worker environment

`infra/hetzner/gateway/worker-cloud-init.yaml` sets up the machine. For each attempt, the executor adds the caller token and sends each variable that contains it over the SSH connection, not the command line; the worker's sshd accepts them with `AcceptEnv`. The Claude Code row applies if the gateway has the Anthropic credential, and the Codex row if it has the OpenAI credential; otherwise the harness uses its login on the worker and `HTTPS_PROXY`.

| Tool | Setting |
| --- | --- |
| git | remote `http://git.<domain>/OWNER/REPO.git`; `GIT_CONFIG_KEY_0=http.http://git.<domain>/.extraHeader`, `GIT_CONFIG_VALUE_0="X-Usine-Gateway-Token: <caller token>"`, and `url.http://git.<domain>/.insteadOf` for `https://github.com/` and `https://git.<domain>/` |
| gh | `GH_HOST=git.<domain>`, `GH_ENTERPRISE_TOKEN=<caller token>`, `GH_TOKEN=<caller token>`; gh's config sets `http_unix_socket: /run/usine-gateway/http.sock`, which `systemd-socket-proxyd` forwards to the gateway, because gh speaks only HTTPS to a custom host but plain HTTP over a socket |
| Claude Code | `ANTHROPIC_BASE_URL=http://llm.<domain>/anthropic`, `ANTHROPIC_AUTH_TOKEN=<caller token>` |
| Codex | `CODEX_HOME=<root>/workers/<worker>/codex/<attempt>`, whose `config.toml` sets `model_provider = "usine-gateway"` with `base_url = "http://llm.<domain>/openai/v1"`, `env_key = "USINE_GATEWAY_TOKEN"`, `wire_api = "responses"`, and `requires_openai_auth = false`; `USINE_GATEWAY_TOKEN=<caller token>` |
| package managers, harness logins | `HTTPS_PROXY` and `HTTP_PROXY` set to `http://<gateway>:3128`, `NO_PROXY=<domain>` |

Codex with this `model_provider` sends its caller token as a bearer token, needs no login, and calls only `POST <base_url>/responses` over HTTP with server-sent events, since a custom provider uses neither the Responses WebSocket nor the remote model list. The same configuration works whether the gateway holds an API key or a ChatGPT login.

A client that sends every request through `HTTPS_PROXY`, as Claude Code does, still reaches `git.<domain>` and `llm.<domain>`: the forward proxy sends their port 80 requests to the reverse proxy.

## Configuration

The [CLI reference](https://docs.usine.dev/reference/configuration/cli/) lists every `usine-gateway` variable, with defaults and the environment file rules. Changing `USINE_GATEWAY_CALLER_KEY` invalidates every caller token.

Each provider holds one credential; setting both of a provider's variables is an error.

| Provider | Variable | Credential | Sent upstream as |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | An Anthropic API key | `x-api-key` |
| `anthropic` | `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` | A Claude subscription token from `claude setup-token` | A bearer token, with the OAuth beta flag merged into `anthropic-beta` |
| `openai` | `OPENAI_API_KEY` | An OpenAI-compatible API key | A bearer token |
| `openai` | `USINE_GATEWAY_CHATGPT_AUTH_FILE` | The absolute path of a Codex `auth.json` with a ChatGPT login | A bearer token with the login's access token, and `ChatGPT-Account-ID`; see [ChatGPT login](#chatgpt-login) |

`USINE_GATEWAY_ANTHROPIC_UPSTREAM` (default `https://api.anthropic.com`) is the Anthropic upstream. `USINE_GATEWAY_OPENAI_UPSTREAM` (default `https://api.openai.com`) is the upstream for an OpenAI API key and can be any OpenAI-compatible provider, and `USINE_GATEWAY_CHATGPT_UPSTREAM` (default `https://chatgpt.com/backend-api/codex`) the one for a ChatGPT login. A provider without a credential is refused with `provider-not-configured`.

### LLM routes

Each provider serves only the routes its harness calls, whatever the credential, so a worker can't use the gateway's credential for the rest of the provider's API, such as files, batches, or organization administration. A route matches whole path segments, so a percent-encoded separator (`%2F`, `%5C`), a doubled or trailing `/`, or a dot segment, which URL parsing resolves first, never reaches the upstream. Other paths are refused with `unsupported-path` before any credential is used or refreshed.

| Prefix | Routes | Harness |
| --- | --- | --- |
| `/anthropic` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/v1/models/MODEL` | Claude Code |
| `/openai` | `/v1/responses`, `/v1/responses/compact`, `/v1/models` | Codex |

The query string passes unchanged, such as Claude Code's `?beta=true`.

## Claude subscription token

A `claude setup-token` token is valid for one year and has no refresh token, so the gateway doesn't refresh it ([authentication](https://code.claude.com/docs/en/authentication)). Before it expires, run `claude setup-token` again, replace `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, and reload. The token is opaque, so the gateway can't tell when it expires; once it has, Anthropic refuses each request and Claude Code reports the error. Run the placeholder swap test in [Tests](#tests) before you rely on the subscription token.

## ChatGPT login

With `USINE_GATEWAY_CHATGPT_AUTH_FILE`, the gateway serves Codex's [LLM routes](#llm-routes) under `/openai` on `llm.<domain>` from the ChatGPT backend, which has them without `/v1`: Codex's `/openai/v1/responses` goes to `https://chatgpt.com/backend-api/codex/responses`. The gateway replaces the caller token with `Authorization: Bearer <access token>`, sets `ChatGPT-Account-ID` to the login's account, and passes Codex's other headers, such as `originator` and `session-id`, and the streamed body unchanged.

The file is the `auth.json` that `codex login` writes in `CODEX_HOME`. The gateway reads its `tokens.access_token`, `tokens.refresh_token`, and `tokens.account_id` (or the account in `tokens.id_token`) on first use and on each [reload](#reload), and keeps them in memory. It refreshes the access token as Codex does:

- When the access token expires within five minutes, or the backend answered a request with 401, the next request first sends the refresh token to `https://auth.openai.com/oauth/token` with Codex's client ID. A 401 for a token refreshed less than a minute earlier doesn't start another refresh.
- Refreshes run one at a time, and requests that arrive during a refresh wait for its result. A refresh runs apart from the request that started it, so a request that ends early doesn't stop it between the rotation and the write-back.
- The response's new access token, rotated refresh token, and ID token go to the file, through a temporary file with mode 0600 in the same directory that replaces it, so the service needs write access to the directory. The file's other fields stay. If the file holds a login the gateway didn't refresh, such as one you just copied in, it's left for the next reload.
- If a refresh fails, the waiting requests are refused with `provider-login-unavailable`, and nothing is sent upstream with the old token. After a network error, a server error, a 408, or a 429 from the token endpoint, the refusal is 503, which Codex retries: requests fail without calling the token endpoint for ten seconds, then the next one tries again. Any other client error, such as `invalid_grant`, or the codes `refresh_token_expired`, `refresh_token_reused`, and `refresh_token_invalidated`, rejects the refresh token: the refusal is 401, which Codex doesn't retry, and the gateway doesn't try again until a reload reads another login. An auth file that can't be read is refused with 503. Refusals give a fixed message and never the token endpoint's text; the log has its error code.

At startup and each reload, the gateway reads the file and checks that it can write next to it, and fails or keeps the previous providers if it can't. A reload keeps the tokens in memory if the file has their refresh token or one they replaced, so it never goes back to a used refresh token, and otherwise uses the file's login.

| Log line | Level | When |
| --- | --- | --- |
| `Loaded the ChatGPT login` | info | The file was read, with `authFile`, the access token's `expiresAt`, and `replaced` on a reload |
| `Refreshing the ChatGPT login`, `Refreshed the ChatGPT login` | info | A refresh started (`reason` is `expiring` or `refused-by-upstream`) and ended, with `rotated` |
| `Wrote the refreshed ChatGPT login to its auth file` | info | The rotated tokens are in the file |
| `Left the auth file as it is: it holds another ChatGPT login` | warning | The file has a login the gateway didn't refresh; reload to use it |
| `Could not write the refreshed ChatGPT login to its auth file` | error | The login works from memory, but after a restart the file's refresh token may no longer work |
| `Could not refresh the ChatGPT login; a later request tries again` | error | A network error or server error, with `error` and the `backoff` |
| `The token endpoint rejected the ChatGPT login's refresh token` | error | The login needs a new `auth.json` and a reload |
| `The ChatGPT backend refused the gateway's access token` | warning | The backend answered 401; the next request refreshes first, unless the token is less than a minute old |

Make the gateway's login separate from the one on your own machine. A refresh token works once, so if two copies of one `auth.json` refresh, the second is rejected with `refresh_token_reused`. [`infra/hetzner/gateway/README.md`](../../infra/hetzner/gateway/README.md) gives the steps.

## Reload

On SIGHUP, `usine-gateway` rereads its environment files and allowlist, and replaces the egress allowlist and the LLM provider settings: `ANTHROPIC_API_KEY`, `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN`, `OPENAI_API_KEY`, `USINE_GATEWAY_CHATGPT_AUTH_FILE`, the three upstreams, and `USINE_GATEWAY_EGRESS_ALLOWLIST`. It also rereads the ChatGPT auth file, so copying a new `auth.json` over the old one and reloading replaces the login. Under systemd, `ExecReload=kill -HUP $MAINPID` makes `systemctl reload usine-gateway` send it.

Attachments, the admin API, listening sockets, and open tunnels stay, so running attempts keep their GitHub and LLM requests. An open tunnel stays until a side closes it; each new `CONNECT` or plain HTTP request uses the new allowlist, and each later LLM request the new key. The domain, listeners, admin token, and caller key change only with a restart. A reload that finds one of them changed logs `Settings changed that take effect only after a restart` at warning level with the variable names, and applies the rest.

Each reload ends with `Reloaded the gateway settings`, which gives the environment files, the allowlist path and rule count, whether the allowlist and providers were reloaded or kept, and the names, never values, of changed provider settings (`changed`). Unusable input keeps what's in force:

| Problem | The reload keeps | Log line, at error level |
| --- | --- | --- |
| The allowlist can't be read or doesn't parse | The previous allowlist | `Kept the previous egress allowlist`, with the path, the line, and the problem |
| A provider setting is invalid, both of a provider's credentials are set, or the ChatGPT auth file can't be read or isn't a ChatGPT login | The previous providers | `Kept the previous LLM providers` |
| An environment file can't be read | Everything | `Kept the gateway settings: an environment file could not be read`, with the path |

`systemctl reload` returns before the reload ends; the journal has the result. Variables from the process environment at startup don't change, so a gateway without environment files reloads only its allowlist.

## Tests

`pnpm --filter @usine/gateway test` runs the unit tests and an end-to-end test that starts the gateway on loopback ports, clones `octocat/Hello-World` through it, calls `gh api` through a Unix socket as a worker does, and opens a tunnel to `registry.npmjs.org`. It needs network access but no secret.

The unit tests for the ChatGPT login (`test/chatgpt.test.ts`) use stand-ins for the token endpoint and the ChatGPT backend: refresh timing, write-back of rotated tokens, one refresh for concurrent requests, failed and rejected refreshes, header rewriting, refused paths, and streaming through the Node gateway.

`pnpm --filter @usine/gateway test:placeholder-swap` runs the harnesses themselves against the gateway and local stand-ins, so CI, which has neither binary, doesn't run it. Run it on a machine with the harnesses on `PATH` before you rely on a subscription credential at the gateway:

- Claude Code (needs `claude`): the worker has only a caller token as `CLAUDE_CODE_OAUTH_TOKEN`, and the gateway sends a subscription token instead. The first case runs Claude Code against a local stand-in for the Anthropic API and checks what reached it. The second runs against `api.anthropic.com` with the real token in `CLAUDE_CODE_OAUTH_TOKEN`, and is skipped without it.
- Codex (verified with 0.164.0; needs `codex`): `codex exec` disables plugin and app sync, update checks, and analytics, and runs with the `model_provider` the executor writes and only a caller token, against a stand-in for the ChatGPT backend and its token endpoint. The login's access token expires within a minute, so the case checks that the gateway refreshes it, sends the new token and the account to the backend, and writes the rotated refresh token to the auth file. Nothing reaches OpenAI.
