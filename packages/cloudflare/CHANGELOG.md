# @usine/cloudflare

## 0.3.0

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
- e740eff: The gateway and the Cloudflare outbound handlers close the ways that a later change or a careless setting could send a provider key or a caller token to the wrong host.
  
  - `@usine/gateway`: an upstream variable, such as `USINE_GATEWAY_OPENAI_UPSTREAM` or `USINE_GATEWAY_CHATGPT_UPSTREAM`, takes an `https://` URL, or an `http://` URL to a loopback host only. Another `http://` URL fails the startup, and a reload with one keeps the provider settings in force, with an error that names the variable. A provider slot refuses a method that the route's entry doesn't list with `unsupported-path`, as the Cloudflare handler does. The `key` query parameter no longer reaches a provider's upstream. `provider-credentials.json` records the provider ID of each key under `staticKeys`, and the gateway ignores, with a warning, a key saved for another provider than its slot's; a key saved without an ID still loads. A saved Anthropic or OpenAI key, and a saved Claude setup token, load only for the built-in `anthropic` or `openai` provider, and a Claude login connects only to `anthropic`, so a catalog that gives a built-in slot or the `claude` login to another provider never sends it those credentials.
  - `@usine/cloudflare`: `ProviderProps` carries the provider's ID instead of its entry, and reads the props that earlier Workers registered for the entry's ID. `providerOutbound` takes the Worker's catalog and reads the entry from it on each request, so a handler that a container keeps across a deployment serves the current entry. It refuses a provider that the catalog no longer serves in a sandbox, or props that it can't decode, with status 403. `providerRequest` takes the catalog and leaves out `cookie`, the key header of every catalog provider, and the `key` query parameter.
  - `@usine/core/agent/provider`: `upstreamSearch` returns a query without the parameters that can carry a key, and `ModelProviderCatalog.keyHeaders` lists the header that each protocol takes its key in.

### Patch Changes

- b71cabb: Workers install Codex CLI 0.172.0, which offers `gpt-6.2-astra` and `gpt-6.2-sol`. The app-server protocol baseline stays at 0.164.0, the latest release with a published `@pwrdrvr/codex-app-server-protocol` package. `CODEX_CLI_VERSION` is now the installed release and no longer equals `CODEX_PROTOCOL.version`. Preflight accepts 0.172.0, 0.164.0, and 0.159.0 through 0.159.3, so workers built from older images pass until they are rebuilt. The worker image tag, the Hetzner cloud-init, and the Cloudflare sandbox image install 0.172.0.
  
  When Codex's `model/list` lacks the requested model, the `UnknownModelError` message and the `Codex rejected an unknown model` log entry list the model IDs that Codex offers and the Codex CLI version that the app server reports. `initializeCodex` returns that version, read from the `initialize` user agent, and `checkCodexModel` takes it.
  
  The OpenAI price table adds `gpt-6.2-astra`, `gpt-6.2-sol`, and `gpt-6.1-terra`.
- Updated dependencies [c99ca54]
- Updated dependencies [4289b0b]
- Updated dependencies [2cc7a34]
- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [55c75fe]
- Updated dependencies [095438d]
- Updated dependencies [6aa5e72]
- Updated dependencies [539349e]
- Updated dependencies [fe7ceaa]
- Updated dependencies [beaf1bf]
- Updated dependencies [7626bb7]
- Updated dependencies [b6fd6b2]
- Updated dependencies [4ff30ae]
- Updated dependencies [039daa4]
- Updated dependencies [322d45e]
- Updated dependencies [f898c14]
- Updated dependencies [bfa02ef]
- Updated dependencies [c8ea557]
- Updated dependencies [589ad7b]
- Updated dependencies [71ecb9e]
- Updated dependencies [e828b51]
- Updated dependencies [322d45e]
- Updated dependencies [dead029]
- Updated dependencies [b71cabb]
- Updated dependencies [f889e77]
- Updated dependencies [650d14a]
- Updated dependencies [3fef8e2]
- Updated dependencies [4eec609]
- Updated dependencies [d6fb554]
- Updated dependencies [34f71e5]
- Updated dependencies [dd2a806]
- Updated dependencies [d7e00bc]
- Updated dependencies [64afcbb]
- Updated dependencies [fd52df7]
- Updated dependencies [e8003db]
- Updated dependencies [650d14a]
- Updated dependencies [eb83984]
- Updated dependencies [fa97db3]
- Updated dependencies [c8241d7]
- Updated dependencies [3eccfe4]
- Updated dependencies [edf94cf]
- Updated dependencies [07b1f29]
- Updated dependencies [053494a]
- Updated dependencies [9a85543]
- Updated dependencies [3eccfe4]
- Updated dependencies [d185132]
- Updated dependencies [08de94f]
- Updated dependencies [eb83984]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [b74919c]
- Updated dependencies [2882f71]
- Updated dependencies [b74919c]
- Updated dependencies [fa97db3]
- Updated dependencies [eb83984]
- Updated dependencies [1634d92]
- Updated dependencies [2d9ee2e]
- Updated dependencies [e740eff]
- Updated dependencies [360d371]
- Updated dependencies [cfd02df]
- Updated dependencies [eb83984]
- Updated dependencies [fa97db3]
- Updated dependencies [eb58cad]
- Updated dependencies [b74919c]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [5ae7631]
- Updated dependencies [6a42cb3]
- Updated dependencies [1eddd3d]
- Updated dependencies [1b04776]
- Updated dependencies [7bc55d5]
- Updated dependencies [4aebd77]
- Updated dependencies [33bab87]
- Updated dependencies [c5be05b]
- Updated dependencies [ce404bf]
- Updated dependencies [039daa4]
- Updated dependencies [b1b75bd]
  - @usine/agents@0.8.0
  - @usine/core@0.8.0

## 0.2.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- 1c981c9: Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.
  
  Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.

### Patch Changes

- 389f35e: Generate worker image packages and tags from harness descriptors. Export `workerImageInputs` from `@usine/agents/harness`, derive the default SSH attempt image from it, and keep both Dockerfiles, Hetzner cloud-init, image publishing, and snapshot creation consistent with the catalog.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- Updated dependencies [6a1cf79]
- Updated dependencies [e0cedc8]
- Updated dependencies [6e60662]
- Updated dependencies [47c0f07]
- Updated dependencies [df0bd8f]
- Updated dependencies [b70b5fe]
- Updated dependencies [09417f7]
- Updated dependencies [b7ff637]
- Updated dependencies [10822d3]
- Updated dependencies [1674238]
- Updated dependencies [3e822f6]
- Updated dependencies [92f21ce]
- Updated dependencies [01467e3]
- Updated dependencies [8c079aa]
- Updated dependencies [389f35e]
- Updated dependencies [a1c0d36]
- Updated dependencies [8d28709]
- Updated dependencies [e007d09]
- Updated dependencies [9290433]
- Updated dependencies [12c3921]
- Updated dependencies [548e6b7]
- Updated dependencies [1c981c9]
- Updated dependencies [82b55aa]
- Updated dependencies [9786f67]
- Updated dependencies [7e5bb5b]
- Updated dependencies [9d7dfb0]
- Updated dependencies [35f68ef]
- Updated dependencies [d740598]
- Updated dependencies [fc15261]
- Updated dependencies [3229601]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [5796627]
- Updated dependencies [89ae7ee]
- Updated dependencies [4d60236]
- Updated dependencies [9476883]
- Updated dependencies [b6a858e]
- Updated dependencies [0e34ec1]
- Updated dependencies [10154eb]
- Updated dependencies [10154eb]
- Updated dependencies [7c58461]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [ef5aa4d]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [fc18d3f]
- Updated dependencies [0e34ec1]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0
  - @usine/agents@0.7.0

## 0.1.1

### Patch Changes

- a7692ae: Upgrade the Codex protocol baseline and worker images to 0.164.0, which includes updated TLS certificate roots. Preflight rejects 0.153.4 and accepts 0.159.0 through 0.159.3 for one release while existing worker images upgrade. The gateway model-provider configuration remains compatible. Claude Code stays at 2.1.308.
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

## 0.1.0

### Minor Changes

- b3e696a: Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).
  
  - `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a stop that ends every process that a command started, including what it left running after it exited, a keepalive alarm that also keeps a held sandbox running, an image init that records the platform's SIGTERM, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex, only on the provider routes that the harnesses call. Each sandbox applies its credential changes one at a time and refuses credentials older than the ones it holds, so a delayed renewal can't undo a revocation. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
  - `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
  - `@usine/executor/cloudflare` creates a sandbox per attempt, checks the attempt's harness version in it before it grants credentials, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps and holds it until it reconciles or destroys it, drains an attempt within the platform's 15 minutes after SIGTERM by salvaging its checkout and failing it retryably, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions. Each child reports the outbound handler's API key as its credential, so a Codex child runs without a ChatGPT login check, and Claude Code and Codex children count in the API keys pool.
  - `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
  
  Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). The sandbox API still answers a create or credentials body with an unknown key with 400, through `HttpApi.PayloadParseOptions` on the sandbox group. Effect 4.0 ignores the payload annotation that did this before.

### Patch Changes

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
