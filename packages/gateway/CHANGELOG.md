# @usine/gateway

## 0.4.0

### Minor Changes

- beaf1bf: A provider with a static key is added with its catalog entry and the descriptors that use it. The operator connects its key in Settings or with `usine login <provider> --api-key`, and a harness reaches it through the gateway or in a Cloudflare sandbox. The two subscription logins, `claude` and `chatgpt`, stay a closed set, because usine implements each one's sign-in.
  
  - `@usine/gateway`: the admin API connects and disconnects a static key for any provider of the gateway's catalog that accepts one. `PUT /v1/provider-credentials` takes the kind `<provider ID>-api-key`, which gateways up to 0.3.0 accept for the built-in providers, and returns 422 with `UnservedProvider` for a provider that the catalog doesn't have or that doesn't take the credential; `DELETE /v1/provider-credentials/:provider` takes a slot or a provider ID. `GET /v1/provider-credentials` lists every slot of the catalog in `catalog`, with its provider's `id`, `label`, and `accepts`, and the built-in slots in `providers`, which orchestrators up to 0.6.0 read. A connected static key or Claude setup token goes to the upstream that the provider's upstream variable sets. A login is stored under the slot of the catalog's provider that signs in with it, and a saved static key whose provider no longer takes one is ignored with a warning. `provider-credentials.json` keeps the format of gateways up to 0.3.0 for the built-in providers' credentials, so those gateways still read it, and holds other providers' keys under `staticKeys`, which they ignore. `ProviderCredential` decodes to a `StaticKey` or a `LoginSecret`; `credentialProvider` and `loginLlmProvider` are removed, and `providerEntry` and `AcceptedCredentials` are added.
  - `@usine/server`: Provider connections and `usine login` list each provider that a destination serves, with the credentials it takes. Settings shows a provider without a subscription login with only its API key field. `usine login <provider>` takes a provider ID, a slot, or a login name, and lists the destination's providers when the name matches none. A key or a disconnect replaces a local credential whose status can't be read, such as a malformed Codex `auth.json`. The operator API's `PUT /api/providers/key` and `POST /api/providers/disconnect` take a provider by its slot or ID, or by its subscription login as before. Worker routing changes only for providers that the orchestrator's harnesses use. The Cloudflare worker and provisioner forms list the catalog's providers.
  - `@usine/cloudflare`: the Worker serves `<provider ID>.usine.internal` for each provider of its catalog that takes an API key, and sends each request to the upstream of the protocol that serves its path, with the key in that protocol's header. It forwards each route of the catalog with the methods that the route's entry lists, and serves only a provider whose upstreams use HTTPS. A sandbox stores the provider hosts that it registered, and denies each one that the Worker's catalog no longer has. Codex uses the base URL of the provider that the sandbox has a key for. `PROVIDER_HOSTS` is replaced by `sandboxHost`, `interceptionsFor` takes the catalog, `providerRequest` takes a `ModelProvider`, `SandboxSettings` has `providers`, and `ProviderGrant.provider` is a `ModelProviderId`.
  - `@usine/core`: `CloudflareLlmProvider` is removed. `ModelProvider` adds `login`, `passes`, and `sharedUpstream`; `ProviderProtocol` adds `methods` and `allows`; `ModelProviderCatalog` adds `signingIn` and refuses a subscription login that is also a provider ID or slot; and `selectProvider` resolves a provider name.
  - `@usine/config`: a Cloudflare worker's `llm_providers` names any catalog provider that takes an API key.
  - `@usine/executor`: `CloudflareProviderKey.provider` is a `ModelProviderId`.
  - `@usine/agents`: a descriptor that offers the `api-key` route outside a sandbox refuses a provider whose protocols have different upstreams, and `HarnessCredential.apiKeyBaseUrl` gives the upstream they share.
  - `@usine/durable`: Pi's gateway route takes the slot of the first of the Pi harness's catalog providers that serves the model request and has a credential, for both authentication and requests.
- 07b1f29: OpenCode agents can run models of the OpenCode Go plan through the gateway. Connect the plan's key with `usine login opencode-go --api-key`, or `OPENCODE_GO_API_KEY` on the gateway, and set `model` to `opencode-go/<model ID>`, such as `opencode-go/glm-5.3`. A model ID without a provider stays an OpenAI model. The gateway holds the key, and the worker gets only the caller token and the URL of the gateway's `opencode-go` slot.
  
  - `@usine/core`: the provider catalog adds `opencodeGo`, whose slot `opencode-go` serves `/chat/completions` and `/responses` at the plan's OpenAI upstream, `/messages` at its Anthropic upstream, and `/models/{model}:streamGenerateContent` at its Google upstream, each with the key in that protocol's header. It passes OpenCode's session headers and the Anthropic version and beta headers, and accepts only an API key.
  - `@usine/gateway`: the gateway serves the `opencode-go` slot and returns the plan's error bodies unchanged, so OpenCode recognizes its limits.
  - `@usine/agents`: a `HarnessDescriptor` lists the providers that an attempt API key outside a sandbox doesn't reach in `gatewayOnly`, and returns the others as `apiKeyProviders`. A `HarnessCredential` names the variable of each provider's slot URL in `slots`, which `slotEnvironment` renders for the providers that a gateway holds. A descriptor's `modelNotation` and `providerOf` read the provider of a model, as a branded `ModelChoice`, and `reaches` tells whether a route reaches it; `admitBrain` refuses a gateway-only provider's model outside the gateway route. `catalog.modelProvider` and `catalog.modelGatewayProvider` return a brain's provider, and whether a gateway holds its slot. OpenCode lists `openai` and `opencode-go`, reads the gateway's OpenAI slot from `USINE_OPENCODE_OPENAI_BASE_URL` and the attempt's API key's base URL from `USINE_OPENCODE_BASE_URL`, uses the attempt's API key on a gateway route without a slot of the model's provider, reads the provider of the model in OpenCode's `provider/model` notation, and refuses a provider that it doesn't list with the list in the message. Its session allows only the model's provider, and preflight and launch check the model against that provider.
  - `@usine/cloudflare`: the Worker serves `opencode-go.usine.internal` for a sandbox with the plan's key, and denies it otherwise, as for every catalog provider.
  - `@usine/executor`: a gateway route sets the URL of each slot of a harness that the gateway holds in the variable that the descriptor names, and the attempt's gateway credential kind, credential route, provisioner API key, caller token, and logged slot follow the provider of its model, not the harness's first provider. An attempt whose model's provider slot the gateway doesn't hold gets no caller token, so an OpenCode attempt on the provisioner's `openai` key sends only that key to OpenAI. A provisioner's `api_keys` give an attempt only a key that the harness reaches with one. The gateway upgrade notice lists only the paths that changed with slots.
  - `@usine/config`: configuration admits an agent on a gateway route only when the worker's gateway holds the slot of its model's provider, so it refuses an OpenCode Go agent on a worker whose gateway doesn't list `opencode-go`.
  - `@usine/server`: the agent and worker references document the OpenCode Go provider.
- 1634d92: The model provider catalog refuses entries that could send a key to the wrong place, the gateway's provider report stays readable by orchestrators from before the catalog, and the gateway ignores a stored credential under the wrong slot.
  
  - `@usine/core/agent/provider`: a catalog refuses two providers that read the same credential or upstream variable. `KeyHeader` refuses a hop-by-hop header or one that frames the body, such as `host`, `connection`, `transfer-encoding`, `content-type`, or `content-length`. `ModelProvider` refuses two protocols whose routes can match one path. `RoutePattern` refuses a `.` or `..` segment, and two placeholders in one segment without a literal between them. `ProviderProtocol.serves` compiles its routes once and matches a path in time linear in its length. `HOP_BY_HOP_HEADERS` lists the headers that a proxy never forwards; `routeServes` is removed.
  - `@usine/gateway`: `GET /v1/providers` reports each slot's credential kind as `credential` on its entry in `slots`, and lists in `providers` only `anthropic-messages` and `openai-responses`, so a third slot with a credential no longer fails the read of an orchestrator from before the catalog. The gateway ignores a record in `provider-credentials.json` under a slot whose provider doesn't accept it, and logs the slot and the record's kind at Warning.
  - `@usine/executor`: the gateway preflight reads each slot's credential kind from `slots` when the gateway reports it there, and from `providers` otherwise.
- 2d9ee2e: A model provider is one catalog entry, and the gateway serves one slot for each. An entry gives the provider's ID, its slot at the gateway, its label, each wire protocol's upstream, routes, and key header, the credentials it accepts, the request headers that pass to the upstream, and the variable that replaces its upstreams. One key can serve several protocols: each path under the slot goes to the upstream of the protocol that serves it, with the key in that protocol's header. A provider with a static key needs only its entry. The Anthropic and OpenAI providers are entries with the slots `anthropic-messages` and `openai-responses`, and behave as before, subscription logins included.
  
  - `@usine/core/agent/provider`: `ModelProvider`, `ProviderProtocol`, `KeyHeader`, `ApiKeyCredential`, `SubscriptionCredential`, `ModelProviderCatalog`, the `ModelProviderId`, `GatewaySlot`, `WireProtocol`, `RoutePattern`, `HeaderName`, `GatewayVariable`, and `UpstreamBase` schemas, and `modelProviders`, the catalog of the `anthropic` and `openai` entries. `/worker` no longer exports `GatewayLlmProvider`, `GatewayLlmProtocol`, `GATEWAY_LEGACY_PROVIDERS`, `gatewayLlmProtocolOf`, or `GatewayLlmProtocolFromName`; `ModelProviderCatalog.find` and `slotFromName` read a slot or a provider ID.
  - `@usine/agents/harness`: `HarnessDescriptor.providers` lists the providers a harness can use, in the order it prefers them; `HarnessCredential` drops `provider`, `protocol`, `label`, `apiHost`, and `apiKeyBaseUrl`, and its `gatewayPath` becomes `slotPath`, the path under the slot. `HarnessCatalog.providers` lists each declared provider once, `gatewayProvider` returns the provider whose gateway credential a harness uses, and the catalog refuses a provider ID that two harnesses define differently. A pool route `gateway-api-key` or `gateway-subscription` needs a provider of the harness that accepts that kind of credential.
  - `@usine/gateway`: `GatewaySettings.catalog` holds the providers it serves, and `LlmProviders` holds an `LlmProvider` (an `ApiKey`, `AnthropicSubscriptionToken`, or `ChatGptLogin`, and an optional upstream) by slot; `AnthropicApiKey`, `OpenAiApiKey`, `AnthropicProvider`, and `OpenAiProvider` are removed. The gateway reads each provider's credential from the variables of its entry, reads a caller token from each protocol's key header, and refuses paths outside the entry's routes. `GET /v1/providers` also lists every slot it serves, with its routes, as `slots`. `provider-credentials.json` keeps its format.
  - `@usine/config`: `gateway.llm_providers` accepts the slots of the harness catalog's providers, and their IDs as before slots. `ProviderApiKeys` maps a catalog provider ID to a variable, so a provisioner's `api_keys` accepts any catalog provider and refuses an unknown one; stored `anthropic` and `openai` keys read as before.
  - `@usine/executor`: the gateway preflight refuses a gateway that doesn't serve a listed slot, or a route under it that the catalog declares, and asks to upgrade the gateway to the orchestrator's release; it reports a gateway that doesn't list its slots in `gatewayUpgrade`. `ProviderApiKeys` is a record by provider ID, and `provisionedApiKey` returns the key with its provider. `GatewayModelRoute.request` takes a slot and a path, and replaces `countTokens`. The supervisor relay forwards a model request to any route of a catalog provider.
  - `@usine/durable`: `GatewayModelTransport` takes a slot and, for requests, a path.
  - `@usine/orchestrator`: provisioner views replace `anthropicKeyEnv` and `openaiKeyEnv` with `apiKeys`, the variable of each provider's key by provider ID.
  - `@usine/server`: the operator API's provisioner views have `apiKeys`, and the worker page lists each provider's API key variable.
- e740eff: The gateway and the Cloudflare outbound handlers close the ways that a later change or a careless setting could send a provider key or a caller token to the wrong host.
  
  - `@usine/gateway`: an upstream variable, such as `USINE_GATEWAY_OPENAI_UPSTREAM` or `USINE_GATEWAY_CHATGPT_UPSTREAM`, takes an `https://` URL, or an `http://` URL to a loopback host only. Another `http://` URL fails the startup, and a reload with one keeps the provider settings in force, with an error that names the variable. A provider slot refuses a method that the route's entry doesn't list with `unsupported-path`, as the Cloudflare handler does. The `key` query parameter no longer reaches a provider's upstream. `provider-credentials.json` records the provider ID of each key under `staticKeys`, and the gateway ignores, with a warning, a key saved for another provider than its slot's; a key saved without an ID still loads. A saved Anthropic or OpenAI key, and a saved Claude setup token, load only for the built-in `anthropic` or `openai` provider, and a Claude login connects only to `anthropic`, so a catalog that gives a built-in slot or the `claude` login to another provider never sends it those credentials.
  - `@usine/cloudflare`: `ProviderProps` carries the provider's ID instead of its entry, and reads the props that earlier Workers registered for the entry's ID. `providerOutbound` takes the Worker's catalog and reads the entry from it on each request, so a handler that a container keeps across a deployment serves the current entry. It refuses a provider that the catalog no longer serves in a sandbox, or props that it can't decode, with status 403. `providerRequest` takes the catalog and leaves out `cookie`, the key header of every catalog provider, and the `key` query parameter.
  - `@usine/core/agent/provider`: `upstreamSearch` returns a query without the parameters that can carry a key, and `ModelProviderCatalog.keyHeaders` lists the header that each protocol takes its key in.
- c5be05b: The orchestrator can run supervisor turns in a read-only container on its host, with the instance's source to read, on Claude Code, Codex, and Pi. No interface opens a supervisor conversation yet.
  
  `RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host, and its grep runs as a Node.js script there, with Pi's glob, pattern, and output limits.
  
  `@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. The relay and the route drop every header in `CALLER_CREDENTIAL_HEADERS`, which `@usine/gateway/admin` now exports. The sandbox writes the harness's settings without following a symbolic link, and runs one turn of a conversation at a time. A container whose orchestrator stops ends itself, and the next start removes any that remain. `makeSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount, and holds each tree until the turn ends. It removes a tree once the tree is no longer the head and no turn holds it.
  
  `@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.

### Patch Changes

- d159025: `usine-gateway` accepts `0` in `USINE_GATEWAY_PROXY_PORT`, `USINE_GATEWAY_EGRESS_PORT`, and `USINE_GATEWAY_ADMIN_PORT`, as the reference documents. The operating system assigns an available port, and each listener logs the port it bound.
- Updated dependencies [c99ca54]
- Updated dependencies [4289b0b]
- Updated dependencies [2cc7a34]
- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [095438d]
- Updated dependencies [6aa5e72]
- Updated dependencies [539349e]
- Updated dependencies [fe7ceaa]
- Updated dependencies [beaf1bf]
- Updated dependencies [f898c14]
- Updated dependencies [bfa02ef]
- Updated dependencies [c8ea557]
- Updated dependencies [589ad7b]
- Updated dependencies [e828b51]
- Updated dependencies [dead029]
- Updated dependencies [34f71e5]
- Updated dependencies [dd2a806]
- Updated dependencies [d7e00bc]
- Updated dependencies [64afcbb]
- Updated dependencies [fd52df7]
- Updated dependencies [e8003db]
- Updated dependencies [650d14a]
- Updated dependencies [eb83984]
- Updated dependencies [c8241d7]
- Updated dependencies [07b1f29]
- Updated dependencies [eb83984]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [2882f71]
- Updated dependencies [1634d92]
- Updated dependencies [2d9ee2e]
- Updated dependencies [e740eff]
- Updated dependencies [cfd02df]
- Updated dependencies [fa97db3]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [1eddd3d]
- Updated dependencies [1b04776]
- Updated dependencies [7bc55d5]
- Updated dependencies [4aebd77]
- Updated dependencies [33bab87]
- Updated dependencies [ce404bf]
  - @usine/core@0.8.0

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
