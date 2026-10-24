# @usine/gateway

## 0.1.0

### Minor Changes

- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- 6eb66ff: New package: the gateway service for worker VMs without public addresses. A reverse proxy serves GitHub at `git.<domain>` and the Anthropic and OpenAI-compatible APIs at `llm.<domain>` and replaces the worker's caller token with the attached installation token or the gateway's API key; a forward proxy connects only to allowlisted hosts whose TLS ClientHello matches the CONNECT host; an admin API manages attachments. `@usine/gateway/node` runs the three servers on Node, and the `usine-gateway` command runs them from the environment.
- be90a08: `usine-gateway` reloads on SIGHUP (`systemctl reload usine-gateway`): it rereads its environment files and allowlist file and replaces the egress allowlist and LLM provider settings, without dropping attachments or open connections. If the new settings are invalid, it keeps the current ones and logs why; the domain, listeners, admin token, and caller key still need a restart.
  
  The command reads the environment files listed in `USINE_GATEWAY_ENVIRONMENT_FILES`, separated by `:`, and `@usine/gateway/node` exports `GatewayReload`. The gateway unit in `infra/hetzner/gateway` sets `USINE_GATEWAY_ENVIRONMENT_FILES` instead of `EnvironmentFile=` and adds `ExecReload=`; its README lists the steps for an existing gateway.
- fba2a72: First release on npm. Install the `usine-gateway` command on a gateway host with `npm install @usine/gateway`; `@usine/executor` depends on `@usine/gateway/admin`.

### Patch Changes

- a3a230c: The forward proxy logs a tunnel that the client closes before sending a byte at info level, as `The client abandoned a tunnel before sending anything`, instead of as a `not-tls` warning. Non-ClientHello or truncated bytes are still refused.
- a3a230c: A refused admin request logs its endpoint (`attach`, `renew`, `detach`, or `list`) instead of `HttpApiEndpoint`.
- a3a230c: `usine-gateway` exits with status 0 after SIGTERM or SIGINT once its servers close, so systemd records a stop or restart as a success. A failure still exits non-zero.
- 425e240: Fixes `systemctl stop usine-gateway` waiting for the stop timeout: the forward proxy no longer waits for a tunnel without a ClientHello, and an interrupted tunnel destroys its client socket.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 455652c: `@usine/gateway` re-exports `GatewayDomain` from `@usine/core/worker`, so `USINE_GATEWAY_DOMAIN` and a worker's `gateway.domain` use the same schema. The export doesn't change for callers.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [6764fa7]
- Updated dependencies [466e711]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [d933ab6]
- Updated dependencies [a3a230c]
  - @usine/core@0.4.0
