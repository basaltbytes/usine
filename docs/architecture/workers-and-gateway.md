This page describes commit `c56246f` of basaltbytes/usine as it was on 2026-10-16.

# Workers and the Gateway

A Worker is the machine where an Attempt's checkout is and where its children run. The Pi parent always runs in the orchestrator. The operating recipes (creating machines, logging in to the harnesses, the SSH configuration, deleting) are in [`infra/hetzner/README.md`](../../infra/hetzner/README.md) and [`infra/hetzner/gateway/README.md`](../../infra/hetzner/gateway/README.md); this page explains what the code does.

## Worker kinds in `usine.yaml`

`Worker` is a union of three classes in `packages/config/src/factory.ts:150`. Without a `workers` key the factory has one Worker named `local` (`factory.ts:214`).

| `kind` | Fields | Executor | Children run | GitHub credential on the machine |
| --- | --- | --- | --- | --- |
| `local` | `name`, `max_concurrent_attempts` (default 1) | `packages/executor/src/local/local.ts` | as processes of the orchestrator's machine | token file in a private temporary directory |
| `ssh` | `name`, `destination`, `root`, optional `identity_file`, `port`, `max_concurrent_attempts`, `gateway` | `packages/executor/src/ssh/ssh.ts` | one SSH command each | token file under `<root>/workers/<name>/credentials/` |
| `ssh` with `gateway` | `gateway.domain`, `gateway.admin_url`, `gateway.admin_token_env`, optional `gateway.llm_providers` (only `anthropic`) | the same SSH executor | one SSH command each; the operator's SSH configuration routes it through the Gateway with `ProxyJump` | none; a caller token in the SSH session's environment |
| `exe.dev` | `name`, `max_concurrent_attempts` | `packages/executor/src/exe-dev/exe-dev.ts` | one SSH command each on the VM | none; exe.dev's edge adds it |

`usine up` uses one executor for all Workers. `workerEngineLayer` (`packages/orchestrator/src/worker-engine.ts:13`) picks the SSH executor when every Worker is `ssh` and the local executor otherwise. `stepExecutorLayer` then refuses any Worker whose kind differs from the executor's with `UnsupportedWorkerError` (`packages/orchestrator/src/scheduler.ts:76`). A mix of kinds, or any `exe.dev` Worker, therefore stops startup. The exe.dev executor also needs `githubIntegrations` options that `usine.yaml` cannot express (`exe-dev.ts:34`), so it runs only from the integration test (`pnpm --filter @usine/orchestrator test:exe-dev`). #228 tracks both.

## What the executor does for each kind

### local

State is under `<instance>/.usine/workers/<worker>/`: `repos/` for bare caches, `attempts/` for worktrees, `turbo/` for `TURBO_CACHE_DIR` (`local.ts:103`, `:290`). Credentials go to a `usine-credentials-*` directory in the OS temporary folder, mode 700, with the token in `token` and gh's `hosts.yml` and `config.yml` beside it (`packages/executor/src/local/credentials.ts:22`). Git reads the token through a credential helper and gh through `GH_CONFIG_DIR` (`packages/executor/src/credential-environment.ts:15`), so a renewed file takes effect without restarting a child. Git output is scrubbed of every issued token before it goes into an error or a log (`local.ts:133`).

### ssh without a Gateway

Every command is `ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4 [-p port] [-i key -o IdentitiesOnly=yes] <destination> -- <quoted command>` (`packages/executor/src/remote/commands.ts:87`, `ssh.ts:22`). The SSH client inherits only `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `SSH_AGENT_PID`, `SSH_AUTH_SOCK`, `TMPDIR`, and `USER` (`commands.ts:70`). The Worker directory on the machine is `<root>/workers/<name>`.

The token is written to `<root>/workers/<name>/credentials/<attempt>` by a shell script that reads it from standard input, so it is in no command line (`packages/executor/src/ssh/credentials.ts:25`). The directories are mode 700 and the files 600. The first Attempt of each Worker in a process removes every credential directory an earlier process left. All Attempts on one machine run as the same user and can read each other's tokens ([ADR 0026](../adr/0026-eu-ssh-worker.md), #231).

### ssh behind a Gateway

`gatewayAttachmentsFor` (`packages/executor/src/ssh/gateway/attachments.ts:58`) gives the Attempt repository access with no token on the machine:

1. Write gh's configuration to `<worker directory>/gh`: `http_unix_socket: /run/usine-gateway/http.sock` and the host `git.<domain>`. Neither file contains a token (`packages/executor/src/ssh/gateway/environment.ts:42`).
2. Mint the Attempt's token and `POST /v1/attachments` on the Gateway's admin API. The answer has the attachment id and a caller token.
3. Renew the same attachment id with `PUT` before the token expires, and store it again every two minutes (`attachments.ts:35`), because the Gateway keeps attachments in memory and forgets them on restart.
4. `DELETE` the attachment when the Attempt's scope closes.
5. Once per process and Worker, detach the attachments an earlier process left for that Worker (`attachments.ts:64`).

The children's environment has two parts (`environment.ts:88`). The exported part, visible in the command line, contains no secret: `GIT_CONFIG_KEY_0=http.http://git.<domain>/.extraHeader`, two `insteadOf` rewrites from `https://github.com/` and `https://git.<domain>/` to `http://git.<domain>/`, `GH_HOST=git.<domain>`, `GH_CONFIG_DIR`, `HTTPS_PROXY` and `HTTP_PROXY` set to `http://<domain>:3128`, and `NO_PROXY` for localhost and the domain. The sent part travels with OpenSSH `SendEnv` (`commands.ts:101`): `GIT_CONFIG_VALUE_0` (`x-usine-gateway-token: <caller token>`), `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, and, when `llm_providers` contains `anthropic`, `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL=http://llm.<domain>/anthropic`. The clone URL is `http://git.<domain>/<owner>/<repo>.git` (`environment.ts:33`).

### Shared by every remote kind

`remoteExecutorFor` (`packages/executor/src/remote/remote.ts:44`) has the checkout, salvage, recovery, and reattach code that SSH and exe.dev share. Each Claude Code or Codex child is one SSH command with a pid file `<worktree>.child-<n>.pid` (`packages/agents/src/child-host/child-host.ts:96`). `CHILD_KILL_SCRIPT` sends TERM, waits up to five seconds, then KILL, before the worktree is kept or removed (`child-host.ts:106`).

## Preflight

`stepExecutorLayer` runs `Executor.preflight` for every configured Worker with every rostered brain while the runtime layer is built (`scheduler.ts:96`). A failure stops `usine up`. `prepare` repeats the check for the Attempt's brain only (`local.ts:331`). A capability gap found there fails the Attempt with `AgentFailure`, and a transport failure or a timeout stays a retryable `InfraFailure` (`scheduler.ts:51`).

| Worker | Checks | Code |
| --- | --- | --- |
| local | `git --version`; each brain where children run, with the child's environment | `local.ts:256`, `packages/agents/src/preflight/preflight.ts` |
| ssh | SSH connects (`true`); `root` is a writable directory; `git --version`; each brain over SSH; Pi is refused on a remote machine | `packages/executor/src/ssh/preflight.ts:31` |
| ssh with a Gateway | The checks above, plus: the admin API answers the admin token; sshd accepts the variables that contain the caller token; `curl http://git.<domain>/` from the machine is refused for want of a caller token; for each harness that uses its login on the machine, the login's hosts answer through the forward proxy; Claude Code is checked for its binary only when the Gateway has the Anthropic key | `packages/executor/src/ssh/gateway/preflight.ts:47`, `:162` |

Local and direct SSH preflight do not check the GitHub credential. Only the exe.dev preflight raises the `credentials` capability (`packages/executor/src/exe-dev/preflight.ts:123`).

## The Hetzner Gateway VM

`infra/hetzner/gateway/gateway.sh create` creates a private network (`10.42.0.0/16`), the Gateway VM with a public address, and a Hetzner firewall that admits SSH from the orchestrator's address. `gateway-cloud-init.yaml` installs the parts below and generates the admin token and the caller key with `openssl rand -hex 32` into `/etc/usine-gateway/secrets.env` on first boot.

| Part | Listens on | Does | Code |
| --- | --- | --- | --- |
| Reverse proxy (`usine-gateway`) | port 80 on the private address (the binary's default is `127.0.0.1:80`) | `git.<domain>` forwards to github.com, api.github.com (paths under `/api/`), and uploads.github.com with the attached installation token; `llm.<domain>` forwards to Anthropic or OpenAI with the Gateway's own credential. Every request needs a caller token whose attachment is in force; any other host is refused with 404 | `packages/gateway/src/proxy/proxy.ts`, `packages/gateway/src/github/github.ts:15` |
| Forward proxy | port 3128 | `CONNECT` to port 443 of an allowlisted host only, after checking that the TLS ClientHello's server name is that host and that the name resolves to public addresses only; plain HTTP is relayed with caller tokens removed | `packages/gateway/src/node/egress-proxy.ts:241`, `packages/gateway/src/egress/client-hello.ts:88` |
| Admin API | `127.0.0.1:7070` | `POST /v1/attachments`, `PUT /v1/attachments/:id`, `DELETE /v1/attachments/:id`, `GET /v1/attachments`, bearer admin token | `packages/gateway/src/admin/api.ts:92` |
| dnsmasq | port 53 on the private address | Answers `<domain>` and its subdomains with the Gateway's address and refuses other names; `local=/<domain>/` answers AAAA with no address, for Codex's musl resolver (#260) | `infra/hetzner/gateway/gateway-cloud-init.yaml:41` |
| nftables | | Input: SSH, plus DNS, 80, and 3128 from the private network. No forwarding. Outbound SSH only into the private network | `infra/hetzner/gateway/gateway-nftables.conf` |
| sshd | port 22 | Bastion with `AllowTcpForwarding local`, for `ssh -J` to Workers and the admin API forward | `gateway-cloud-init.yaml:66` |

The caller token is HMAC-signed with the caller key and contains its attachment id, Worker, and repository (`packages/gateway/src/caller/caller.ts:93`). A token from a detached attachment is refused even when a new attachment exists for the same Worker and repository. Refusals have a reason in the `x-usine-gateway-refusal` header (`proxy.ts:33`); the forward proxy has its own reasons, such as `host-not-allowed` and `server-name-mismatch` (`packages/gateway/src/egress/egress.ts:59`). The service reads its settings once at start (`packages/gateway/src/node/environment.ts:63`): `USINE_GATEWAY_DOMAIN`, `USINE_GATEWAY_ADMIN_TOKEN`, `USINE_GATEWAY_CALLER_KEY`, the allowlist file (default `/etc/usine-gateway/egress-allowlist`), and optionally `ANTHROPIC_API_KEY` or `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN` (not both) and `OPENAI_API_KEY`. It logs one JSON object per line to journald (`packages/gateway/src/node/main.ts:7`). [ADR 0027](../adr/0027-gateway-credential-proxy.md) records why usine wrote its own proxy instead of a TLS-intercepting one.

## Credential flow

```
GitHub App private key: env USINE_GITHUB_PRIVATE_KEY or .usine/github-app.json (orchestrator only)
  |
  | GitHubApp.workerToken: POST /app/installations/:id/access_tokens with one repository id,
  | at most one hour (packages/github/src/github-app.ts:294)
  v
CredentialProvider.issue (packages/orchestrator/src/credentials.ts:79)
  |
  | renewableCredential: re-issued when less than 5 minutes remain, checked every 30 s
  | (packages/executor/src/renewable-credential.ts:11, :69)
  v
  +--> local Worker:   token file in a temporary directory; git credential helper, gh hosts.yml
  +--> ssh Worker:     token file on the machine, written from standard input over SSH
  +--> ssh + Gateway:  admin API attach (bearer admin token from env <admin_token_env>)
                         | answer: caller token
                         v
                       SSH SendEnv -> sshd AcceptEnv -> GIT_CONFIG_VALUE_0, GH_TOKEN,
                       GH_ENTERPRISE_TOKEN, ANTHROPIC_AUTH_TOKEN in the child's environment
                         | git header x-usine-gateway-token, gh token, Claude Code auth token
                         v
                       Gateway: verify caller token and attachment, replace it with the
                       installation token, send over HTTPS to GitHub
```

The orchestrator reads the admin token once at startup from the environment variable that `admin_token_env` gives; an unset variable stops startup with a `gateway` capability error (`packages/orchestrator/src/ssh.ts:27`). The orchestrator does not open the SSH forward to the admin API itself (#249).

## Harness logins on the Worker

The Claude Code and Codex logins are the operator's, made on the Worker as the `usine` user with `claude auth login` and `codex login --device-auth`. Behind a Gateway the logins call their providers through the forward proxy, so `infra/hetzner/gateway/egress-allowlist` lists `api.anthropic.com`, `platform.claude.com`, `chatgpt.com`, and `auth.openai.com`. With `llm_providers: [anthropic]`, Claude Code children call `llm.<domain>/anthropic` instead and the Gateway sends its own key; its swap of a Claude subscription token is not verified against Anthropic (#234), and the Gateway has no ChatGPT login (#235). [ADR 0027](../adr/0027-gateway-credential-proxy.md), amendment of 2026-10-15, explains why the logins stay on the Worker.

## cloud-init files

| File | Adds |
| --- | --- |
| `infra/hetzner/cloud-init.yaml` | Debian 13 with the `usine` user, key-only SSH (`AllowUsers usine`). Packages `build-essential`, `bubblewrap` for Codex's sandbox (#269), `ca-certificates`, `chromium`, `curl`, `git`, `gnupg`, `jq`. A 2 GB swap file and `vm.overcommit_memory = 1` for the 6 GiB virtual buffer of the lint gates (#270). `/etc/environment` gets `DISABLE_AUTOUPDATER=1` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. A setup script installs gh, Node.js 24, pnpm 11.20.0, Claude Code 2.1.296, Codex 0.153.4, and creates `/home/usine/.usine`. |
| `infra/hetzner/gateway/worker-cloud-init.yaml` | Appended for a Worker behind the Gateway: the Gateway as the only resolver, apt through the forward proxy, Worker nftables (gateway only), `/etc/environment` with `GH_HOST`, the proxy variables, `NO_PROXY`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, a systemd socket that forwards `/run/usine-gateway/http.sock` to the Gateway's port 80, and `AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN`. |
| `infra/hetzner/gateway/gateway-cloud-init.yaml` | The Gateway VM: nftables, dnsmasq, the bastion sshd settings, Node.js, the `usine-gateway` systemd service, the secrets file. |
| `infra/hetzner/create-worker.sh` | Creates a server from `cloud-init.yaml`, labels it `usine=worker`, attaches a firewall that admits SSH from one address. |
| `infra/hetzner/gateway/gateway.sh` | `create`, `delete`, `install <tarballs>`, and `worker-user-data`, which renders the two Worker files as one MIME cloud-init. |

`gateway.sh` writes the Gateway's private address into the Worker nftables file and the domain into the Worker cloud-init; the defaults are `10.42.0.2` and `gw.internal` (`infra/hetzner/gateway/gateway.sh:19`). A Worker behind the Gateway has no time source (#254), and infrastructure changes are applied to running machines only by hand (#264).
