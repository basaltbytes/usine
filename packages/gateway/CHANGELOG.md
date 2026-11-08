# @usine/gateway

## 0.3.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 6316707: Connect Claude and ChatGPT from setup, Settings, or `usine login`, with subscription and API-key options. Save completed logins on the configured gateway or in local harness storage, show credential metadata, and replace or disconnect credentials without manually transferring files.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.

### Patch Changes

- 5c3a684: Report provider refresh capability and explain Claude setup-token expiry and manual replacement in Settings. Preserve reported OAuth dates and accept older gateways without refresh metadata.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- Updated dependencies [6a1cf79]
- Updated dependencies [e0cedc8]
- Updated dependencies [6e60662]
- Updated dependencies [01467e3]
- Updated dependencies [a1c0d36]
- Updated dependencies [e007d09]
- Updated dependencies [9290433]
- Updated dependencies [1c981c9]
- Updated dependencies [82b55aa]
- Updated dependencies [9786f67]
- Updated dependencies [7e5bb5b]
- Updated dependencies [d740598]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [5796627]
- Updated dependencies [4d60236]
- Updated dependencies [9476883]
- Updated dependencies [10154eb]
- Updated dependencies [7c58461]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [0e34ec1]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0

## 0.2.1

### Patch Changes

- c3ace3b: Persist encrypted gateway attachments in the state directory so running attempts retain their caller tokens across restarts. Restore unexpired credentials before listening, return typed errors for failed writes, and close HTTP sockets and CONNECT tunnels promptly on SIGTERM.
- a7f5a57: Document the public gateway API, including attachment persistence, caller-token verification, egress rules, provider credentials, and Node listener settings.
- 2ca5ae8: Stream GitHub Actions logs, artifact downloads, and release assets through the gateway. Follow up to three download redirects without credentials so gh can download through its Unix socket without adding download hosts to the egress allowlist.
- Updated dependencies [d1fd769]
- Updated dependencies [6541e90]
- Updated dependencies [6d7f66f]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0

## 0.2.0

### Minor Changes

- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)).
  
  The admin API still answers an attach or renew body with an unknown key with 400, through `HttpApi.PayloadParseOptions` on the attachments group. Effect 4.0 ignores the payload annotation that did this before.
  
  Effect's Node server now aborts a reverse-proxy response whose upstream body fails after its headers, so the gateway no longer destroys the response itself. It still logs `The reverse proxy response body failed`. A listener bound to `::` reports its host as `::` instead of `0.0.0.0`.
- 8425053: `git.<domain>` serves release downloads at `/OWNER/REPO/releases/download/TAG/FILE` and `/OWNER/REPO/releases/latest/download/FILE` for the attached repository, with the installation token as the `x-access-token` password. The gateway returns GitHub's redirect to the asset host unchanged, so `curl -L` on a worker fetches the asset through the forward proxy and the token reaches only github.com. A release download for another repository is refused with `repository-mismatch`.
  
  The gateway rewrites a `Location` header that points at github.com or api.github.com to `http://git.<domain>`, with API paths under `/api/v3`, and keeps the path and query, so a worker follows GitHub's redirects for a renamed repository through the gateway. `Location` headers on other hosts pass unchanged. Each release download logs `Served a GitHub release download`, each rewrite logs `Rewrote a GitHub Location header to the gateway`, and a forwarded response's log line has its `Location` host as `target`, without the path or query string.
- 2fad241: A renamed or transferred repository's new name works through the gateway. If GitHub answers git's `/OWNER/REPO/info/refs` or the API's `/repos/OWNER/REPO` for the attached repository with a permanent redirect (301 or 308) to the same path under another owner or repository name, the gateway confirms the rename with GitHub's API and the attachment's credential: `/repos/OWNER/REPO` with the attached name must redirect to `/repositories/ID`, and the `full_name` of that repository must be the new name. The attachment then serves paths with the new name until it's detached or expires, and a renewal keeps the learned names. Other attachments, temporary redirects, redirects of anything else, such as a release download or `/repositories/ID/...`, and names that the API doesn't confirm teach no name. Each learned name logs `Learned the new name of an attached repository`, with `newName`, and each unconfirmed one logs `GitHub's API didn't confirm the new name of an attached repository` at warning level, with `newName` and the `reason`.
  
  `LiveAttachment` lists the learned names in `newNames` and answers `serves(repository)`, and `Attachments` has `learnNewName`.
- 4942c44: The gateway holds a Codex ChatGPT login. `USINE_GATEWAY_CHATGPT_AUTH_FILE` names the `auth.json` that `codex login` writes; the gateway keeps its tokens in memory, refreshes the access token before it expires, one refresh at a time, and writes the rotated tokens back to the file through a temporary file with mode 0600. Codex's `/openai/v1/responses` goes to `USINE_GATEWAY_CHATGPT_UPSTREAM` (default `https://chatgpt.com/backend-api/codex`) with the access token and `ChatGPT-Account-ID`. A failed refresh is refused with `provider-login-unavailable` and sends nothing upstream: with 503 after a network or server error, which Codex retries, and with 401 once the token endpoint rejects the refresh token. A reload rereads the file and keeps the tokens in memory if the file has their refresh token or one they replaced. The admin API reports the login as a `subscription`.
  
  `llm.<domain>` serves only the routes Claude Code and Codex call, for every credential: `/anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens`, `/anthropic/v1/models` and `/anthropic/v1/models/MODEL`, and `/openai/v1/responses`, `/openai/v1/responses/compact`, and `/openai/v1/models`. Other paths, percent-encoded separators, and dot segments are refused with `unsupported-path` before any credential is used.
  
  `OpenAiProvider` takes a `credential`, an `OpenAiApiKey` or a `ChatGptLogin`, instead of `key`. `ConflictingProviderCredentials` replaces `ConflictingAnthropicCredentials` and names the provider. `gatewayServices` includes `ChatGptLogins`, which needs a `FileSystem`; `gatewayLayer` provides Node's.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 2fad241: The `unknown-host` refusal for a host on the egress allowlist says to download with `curl -fL -u ":$GH_TOKEN"` from `git.<domain>` instead, with the release download and archive URLs. gh gets this refusal when it follows GitHub's redirect to a download host through its socket, as in `gh release download`.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/core@0.5.0

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
