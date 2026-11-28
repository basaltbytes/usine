# @usine/agents

## 0.8.0

### Minor Changes

- c99ca54: A child that answered while its background work ran no longer waits without end after that work ends. When a snapshot lists no work and no turn starts within five minutes, the child returns its answer, and its `SessionFinished` event doesn't set `backgroundWaitLimitPassed`. A turn that starts within the five minutes runs to its own answer, and work that runs again keeps the child waiting. With `settings.max_background_wait_minutes` set, the limit sets `backgroundWaitLimitPassed` only if work still runs when it passes. An operator Hold or pause keeps the answer for a Release, as it does at the limit.
  
  Codex and Pi children drop their own inputs, such as the task, that a turn didn't record when the turn ends. An operator message that repeats the task is then read at its own record in a later turn, and Codex no longer sends it again.
  
  The run page shows no "No background work" note for a session whose first snapshot is empty, and a snapshot during a run of tool calls follows the run instead of splitting it.
- 4289b0b: A session reports its background work, the work that runs independently of its current turn, with the session event `BackgroundWorkUpdated` in `@usine/core/agent/session`. Each event replaces the previous snapshot: `work` lists each `BackgroundWork` with its ID, kind (`command`, `agent`, or `other`), and description, an empty list means that nothing runs, and an event without `work` means that the harness doesn't report it. Claude Code children report each change to their background tasks, without ambient watchers, and report the work as not reported after a process restart until the new process lists its tasks. Codex and Pi children report no background work. The operator API's transcript reads return the event.
  
  The wait for background work after an answer, and `settings.max_background_wait_minutes`, now apply in the conversation that every harness adapter shares, so any harness that reports its background work gets the same wait and the same limit. The wait behaves as before for Claude Code children. Its log lines name the session instead of the harness, and name the remaining work in `backgroundWorkIds`.
  
  The run page shows each change to a session's background work as a note, and a warning note when a session returned its answer because its background work outlasted the wait limit.
- 2cc7a34: Billing pools are data that each harness declares in the harness catalog, so a harness or a login with its own plan adds its pool without changes to usage, statistics, plan windows, or the web app. The pools that usine records stay the same: API keys, the Claude plan, and the ChatGPT plan, and stored records read as before.
  
  Usage and statistics list pools in catalog order under the labels that the catalog declares, and price usage in a plan pool as an estimate. `GET /api/configuration/capabilities` returns the catalog's `pools`, and usage, statistics, and pool warnings return each pool's `label`. A pool that the catalog doesn't declare, such as one of a removed harness, follows the declared pools under its ID, and its price is an estimate because usine can't tell how it was billed.
  
  - `@usine/core/agent/pool`: `BillingPool` moves here from `/agent/session` and becomes a branded camelCase ID that validates syntax only, like `Harness`. `PoolDescriptor` declares a pool's `id`, `label`, `billing` (`plan` or `metered`), and `windows` (`none`, `together`, or `separately`). `BillingPools` is a required service with the catalog's pools. `declaredPool(pools, id)` returns the pool that `pools` declares with that ID, or, for an undeclared pool, an `UndeclaredPool` labelled with its ID, with `billing` `unknown` and no plan windows.
  - `@usine/agents/harness`: `apiKeys` is the pool of usage billed to a provider API key. `HarnessDescriptor.pools` lists the descriptor's `HarnessPool`s, each a pool and the credential routes that determine it at admission, and `HarnessCatalog.pools` lists each declared pool once, in catalog order. The catalog refuses a pool ID that two harnesses define differently. `/pi/authentication` exports `piLoginPools`, the plan pool of each Pi subscription login that usine accepts; `requiredPiPool` and `resolvePiPool` return a `BillingPool`, and `PiPool` is removed.
  - `@usine/engine`: `RunStore` keeps an omitted window of a pool whose windows are reported `separately` in `BillingPools`, as it kept Claude plan windows before. `RunStore.layer` and the engine layers of `/local-sqlite` require `BillingPools`.
  - `@usine/orchestrator/operator`: `PoolUsageView`, `TaskPoolUsageView`, `PoolTokensView`, and `PoolLimitNeed` have a `label`. `RunUsageReader`, `OperatorObservation`, `Operator`, `TaskReader`, and `OperatorStatistics` read the pools from `BillingPools` when their layers are built, and `/board/projection`'s `projectBoard` takes the pools after its Runs.
  - `@usine/server`: provides `BillingPools` from the harness catalog for the server's lifetime.
- 55c75fe: boxd workers run commands over boxd's gRPC `Exec` stream instead of SSH. A boxd worker needs only its API key: neither the boxd account nor the snapshot needs an SSH key, and a boxd worker that still sets `identity_file`, as earlier releases required, loads and ignores it, with a preflight warning that names the file. The executor runs boxd commands in its own process through a new `ExecShell` child host, with one HTTP/2 connection per worker that raises the receive windows, sends stdin in small chunks, and sends keepalive pings. A lost command is a typed `HostUnreachable` error instead of exit code 255. The executor reports an SSH client's exit code 255 as the same error, so a machine that SSH loses during a preflight or preparation check fails with a message that names the host and the SSH client's reason, and the executor no longer pins a proxy host key or refreshes a proxy port for boxd machines.
- fe7ceaa: A provider capacity refusal, such as a subscription usage limit, no longer fails a run. A run waits until the reset time that the harness reports. When the harness reports none, the run waits 5, 15, and 30 minutes, then 60 minutes between tries, with no limit on the total wait. Before, three tries a few minutes apart ended every run that needed the provider, even when the limit lasted hours.
  
  One refusal marks the capacity group of the refused attempt as at capacity: its harness and model, and the holder of the credential that the harness used. Workers behind a gateway whose `llm_providers` lists the harness's provider share the gateway's group, so a refusal on one makes runs on the others wait, and an answer releases them all. Any other worker holds its own login or its provisioner's API key. Runs that need the group release their worker slot and wait without starting an attempt. At each next try, one attempt tests the group. The provider's first answer in that attempt, or the attempt's end without a refusal, releases the other runs; a notice that the harness writes itself, such as Claude Code's usage-limit message, isn't an answer. Runs on another harness or model, or with a credential that another worker or gateway holds, keep running. Each group backs off after its own refusals. A run waits for the group of its latest refusal, or for the group of the worker slot it gets next when that group is at capacity too. After a restart, each waiting run registers its refusals in that group again from the stored attempts.
  
  Needs attention shows one entry for each capacity group at capacity (`ProviderCapacityNeed`), with its worker or gateway, the time the group started refusing, its next try, and the number of waiting runs. A waiting run, including one that has no attempt yet, shows the next try of its group. While another run's attempt tests the group, a waiting run shows that its next try comes after that test. **Retry** on a waiting run starts its next attempt now, and that attempt tests the group; **Cancel run** stops the wait.
  
  - `@usine/agents`: a Claude Code usage limit without a `rejected` rate-limit report takes the latest reset time of the allowance windows that the session's reports show used up, by the same rule as Codex. Claude Code, Codex, and Pi sessions report `ProviderAnswered` at the first answer of their model provider in each harness process. `HarnessCatalog.gatewayHolds` returns whether a gateway with the given `llm_providers` holds the credential of a harness.
  - `@usine/core/worker`: `CredentialHolder` is a `WorkerCredentialHolder` or a `GatewayCredentialHolder`, by the gateway's `ssh` destination.
  - `@usine/core/agent/session`: `ProviderAnswered` reports a model provider's first answer, and `usedUpUntil` returns when the used-up rate-limit windows reset.
  - `@usine/core/attempt`: `shouldAutoRetry` takes the earlier attempts, always retries a `ProviderCapacityFailure`, and leaves capacity refusals out of the `InfraFailure` attempt cap. `pendingProviderRetry` has no attempt cap, waits `capacityBackoff` of the run's consecutive refusals in the capacity group of the latest one, and keeps the latest reset time that they report. `CapacityGroup` is a capacity group, `capacityGroupOf` returns an attempt's group with the caller's `CredentialHolderOf`, and `capacityGroupKey` identifies a group. `capacityRefusals` splits a run's consecutive refusals into the `streak` in the group of the latest one and those `elsewhere`. `awaitsProviderRetry` returns whether a running run's latest attempt ended with a capacity refusal. `capacityRefusal` returns the refusal that ended an attempt. `ProviderRetry.nextAttempt` accepts attempt 1, for a run that waits for its group before its first attempt, and `ProviderRetry.testedByAnotherRun` is true while another run's attempt tests the group.
  - `@usine/engine/engine`: `RunEngine.capacityWaits` lists the groups at capacity as `CapacityWait`, with the `CapacityGroup` of `@usine/core/attempt`. `CredentialHolders` is the port through which the engine reads each harness's credential holder on each worker; without a provider, each worker holds its own credentials. `RunEngine.retry` of a run that waits after a capacity refusal, or that waits for its group without an attempt, starts its next attempt.
  - `@usine/orchestrator/scheduler`: `stepExecutorLayer` provides the engine's `CredentialHolders` from the declared workers.
  - `@usine/orchestrator/operator`: `NeedView` includes `ProviderCapacityNeed`. A run's `providerRetry` is at the next try of its capacity group, also for a run that waits for the group without a refused attempt, and `canRetry` is true while the run waits.
- beaf1bf: A provider with a static key is added with its catalog entry and the descriptors that use it. The operator connects its key in Settings or with `usine login <provider> --api-key`, and a harness reaches it through the gateway or in a Cloudflare sandbox. The two subscription logins, `claude` and `chatgpt`, stay a closed set, because usine implements each one's sign-in.
  
  - `@usine/gateway`: the admin API connects and disconnects a static key for any provider of the gateway's catalog that accepts one. `PUT /v1/provider-credentials` takes the kind `<provider ID>-api-key`, which gateways up to 0.3.0 accept for the built-in providers, and returns 422 with `UnservedProvider` for a provider that the catalog doesn't have or that doesn't take the credential; `DELETE /v1/provider-credentials/:provider` takes a slot or a provider ID. `GET /v1/provider-credentials` lists every slot of the catalog in `catalog`, with its provider's `id`, `label`, and `accepts`, and the built-in slots in `providers`, which orchestrators up to 0.6.0 read. A connected static key or Claude setup token goes to the upstream that the provider's upstream variable sets. A login is stored under the slot of the catalog's provider that signs in with it, and a saved static key whose provider no longer takes one is ignored with a warning. `provider-credentials.json` keeps the format of gateways up to 0.3.0 for the built-in providers' credentials, so those gateways still read it, and holds other providers' keys under `staticKeys`, which they ignore. `ProviderCredential` decodes to a `StaticKey` or a `LoginSecret`; `credentialProvider` and `loginLlmProvider` are removed, and `providerEntry` and `AcceptedCredentials` are added.
  - `@usine/server`: Provider connections and `usine login` list each provider that a destination serves, with the credentials it takes. Settings shows a provider without a subscription login with only its API key field. `usine login <provider>` takes a provider ID, a slot, or a login name, and lists the destination's providers when the name matches none. A key or a disconnect replaces a local credential whose status can't be read, such as a malformed Codex `auth.json`. The operator API's `PUT /api/providers/key` and `POST /api/providers/disconnect` take a provider by its slot or ID, or by its subscription login as before. Worker routing changes only for providers that the orchestrator's harnesses use. The Cloudflare worker and provisioner forms list the catalog's providers.
  - `@usine/cloudflare`: the Worker serves `<provider ID>.usine.internal` for each provider of its catalog that takes an API key, and sends each request to the upstream of the protocol that serves its path, with the key in that protocol's header. It forwards each route of the catalog with the methods that the route's entry lists, and serves only a provider whose upstreams use HTTPS. A sandbox stores the provider hosts that it registered, and denies each one that the Worker's catalog no longer has. Codex uses the base URL of the provider that the sandbox has a key for. `PROVIDER_HOSTS` is replaced by `sandboxHost`, `interceptionsFor` takes the catalog, `providerRequest` takes a `ModelProvider`, `SandboxSettings` has `providers`, and `ProviderGrant.provider` is a `ModelProviderId`.
  - `@usine/core`: `CloudflareLlmProvider` is removed. `ModelProvider` adds `login`, `passes`, and `sharedUpstream`; `ProviderProtocol` adds `methods` and `allows`; `ModelProviderCatalog` adds `signingIn` and refuses a subscription login that is also a provider ID or slot; and `selectProvider` resolves a provider name.
  - `@usine/config`: a Cloudflare worker's `llm_providers` names any catalog provider that takes an API key.
  - `@usine/executor`: `CloudflareProviderKey.provider` is a `ModelProviderId`.
  - `@usine/agents`: a descriptor that offers the `api-key` route outside a sandbox refuses a provider whose protocols have different upstreams, and `HarnessCredential.apiKeyBaseUrl` gives the upstream they share.
  - `@usine/durable`: Pi's gateway route takes the slot of the first of the Pi harness's catalog providers that serves the model request and has a credential, for both authentication and requests.
- 4ff30ae: `@usine/agents/child-host` exports `STDIN_ENVIRONMENT_PREFIX`, the start of a remote command line that reads the secret environment block from stdin, and the `HostInput` and `HostCommandOptions` types: a command on a host takes its input as a stream, so an `ExecShell` command no longer buffers a `"pipe"` input without a limit. An `ExecShell` command whose input stream fails reads end of file, also when `endOnDone` is `false`. `@usine/agents/harness` no longer exports `gatewayTokenVariables`, which had no caller.
  
  When an SSH client exits with code 255, the executor logs it at debug instead of as a warning, so a booting machine that preflight or preparation polls no longer logs a warning on each try; the caller that handles the `HostUnreachable` error chooses the level. When the gateway preflight's check of the variables sent on stdin fails with output on stderr, the error's cause keeps the names of the variables that the machine didn't receive and the exit code next to the stderr.
- 322d45e: `startChildProcess` from `@usine/agents/child-host/owner` takes its transport, output acknowledgement mode, and input acknowledgement callback as one options record, the new exported `ProcessOptions` type, after the input stream.
- e828b51: The new instance setting `settings.max_background_wait_minutes` limits how long a child that answers while its background tasks still run waits for that work to start a turn. The default is no limit: such a child waits for its background work and the turn it starts, however long they take. **Configuration > Settings** shows and edits the setting.
  
  Claude Code children apply the limit. When it passes and the child is still idle, the child returns its last answer as its report, and a warning names the limit and the background task IDs. Closing the child ends the Claude Code process, which stops its background tasks, and their results never reach the Attempt. The child's `SessionFinished` event sets `backgroundWaitLimitPassed`, and when the Attempt ends, even as a success, cleanup salvages its checkout as after a failure, so work that the child hasn't pushed is kept. Cleanup applies the limit that the Attempt started with. If that salvage doesn't push all the work, the checkout stays, and startup recovery salvages it again instead of removing it. A turn that starts within the limit runs to its own answer. If the operator holds or pauses the child when the limit passes, the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The limit runs in memory, so a child that was already waiting when usine restarted waits without one.
- dead029: A Claude Code child stops at its first request on usage credits. When a Claude subscription reaches its plan's usage limit and the account has usage credits turned on, Claude Code keeps working and bills the credits. A Claude Code child now stops at the first rate-limit report that says a request ran on usage credits, and the attempt ends with a capacity refusal: the run waits in its capacity group until the plan window resets, and **Needs attention** shows the reason. The report arrives after its request, so that request is already billed; other requests that Claude Code sent before usine closed the child can be billed too.
  
  The new instance setting `settings.allow_usage_credits`, `false` by default, lets Claude Code children keep working on usage credits instead. An attempt applies the value that it started with, and the supervisor keeps working on usage credits. **Configuration > Settings** shows and edits the setting.
- b71cabb: Workers install Codex CLI 0.172.0, which offers `gpt-6.2-astra` and `gpt-6.2-sol`. The app-server protocol baseline stays at 0.164.0, the latest release with a published `@pwrdrvr/codex-app-server-protocol` package. `CODEX_CLI_VERSION` is now the installed release and no longer equals `CODEX_PROTOCOL.version`. Preflight accepts 0.172.0, 0.164.0, and 0.159.0 through 0.159.3, so workers built from older images pass until they are rebuilt. The worker image tag, the Hetzner cloud-init, and the Cloudflare sandbox image install 0.172.0.
  
  When Codex's `model/list` lacks the requested model, the `UnknownModelError` message and the `Codex rejected an unknown model` log entry list the model IDs that Codex offers and the Codex CLI version that the app server reports. `initializeCodex` returns that version, read from the `initialize` user agent, and `checkCodexModel` takes it.
  
  The OpenAI price table adds `gpt-6.2-astra`, `gpt-6.2-sol`, and `gpt-6.1-terra`.
- f889e77: Retry Codex and Pi usage limits after they reset, as Claude Code usage limits already are. A Codex turn that fails with `usageLimitExceeded` or `rateLimitExceeded`, or with HTTP 429 after Codex's own retries, now fails the session with `AgentCapacityError`, whose `resetsAt` is the latest reset time among the used-up windows of Codex's last rate-limit snapshot. A Codex billing quota, a plan without Codex, or a workspace that is out of credits or at its spend cap still fails the attempt for the operator. A Pi turn that ends on a ChatGPT plan limit, a shared ChatGPT subscription limit, or an HTTP 429 rate limit also fails with `AgentCapacityError`; a plan limit that states its wait resets after that wait. The Pi parent classifies the error that ends its turn the same way, and `@usine/agents/pi/refusal` exports that classifier as `piFailure`. The attempt fails with `ProviderCapacityFailure`, so the run retries after the reset, or after the default capacity delay when the harness reports no reset time, without the operator.
- d6fb554: Codex serves usine tool sets. `HarnessRuntime.open` on Codex registers the toolkit on `thread/start` as client-served dynamic tools in the namespace `usine`, through the app server's experimental API, which the connection opts into only for a session with usine tools. Codex sends each call as an `item/tool/call` request on the session's connection, and the handler's result answers it; a failed call reaches the model as a tool error. When Codex cancels a call, such as on a turn interrupt, the session interrupts its handler instead of letting it finish unseen. A resumed thread restores its tools, and the reopened connection serves their calls. `ToolStarted` and `ToolFinished` carry the toolkit's names, and the name `mcp`, which Codex reserves, gets an alias.
  
  The Codex descriptor declares `usine-tools`, which the `host-tool` contract scenario proves on Codex 0.164.0. It still lacks `closed-tools`: its model catalog keeps `apply_patch`, the code-mode `exec` and `wait` tools, and the MCP resource tools on in every thread, so Codex refuses a role that closes native tools.
  
  `CodexClient` adds `serve`, which answers the app server's requests to the client; the connection still refuses every request that `serve` doesn't take. `initializeCodex` takes `{ experimentalApi }`.
- 64afcbb: The event-driven coordinator applies operator input instead of refusing it. Input for a child goes to that child. Input addressed to the parent, including the runaway guard's warning steer, goes to the attempt's live child, and its receipts name the child in `forwardedTo`. Input addressed to the parent waits while the next child starts, as after a reattachment, so the runaway guard's restored warning reaches the resumed child. With no live or starting child, the input is rejected with `InterventionRejected`. An operator message holds the child's report until a release, an interrupt pauses the child, and a working child's queued message gets a second receipt when the child reads it, or a rejection once the child ends without reading it, including when a cancel stops the child. The attempt journal keeps each child's Hold, pause, and queued input, so a child resumed after an orchestrator restart restores them. The coordinator stores what an input implies before the child applies it, so an input that the child applied survives a stop. `AttemptJournal` adds `supervise`, `queueInput`, `forgetInput`, which reserves the input's receipts in the same transaction, and `recordInbound`, and `CoordinatorSnapshot` adds `supervision`, `inputs`, and `nextInbound`; a third migration adds their tables and column.
  
  `SessionResult.answeredOperator` is true when a session read an operator message or steer after its last tool call. The shared conversation sets it for Claude Code, Codex, and Pi, and the coordinator passes it to `AttemptReport.answeredOperator`, so an attempt whose child answered the operator and produced no commit, pull request, comment, or step output fails with `AgentFailure`, as it does for a Pi parent. `SessionIdle.answeredOperator` and `ChildRequest.idleAnsweredOperator` keep that answer across an orchestrator restart under a Hold. Claude Code's task prompt and continuation input carry a client UUID, so each result names every message that its turn consumed, and a steer that the result leaves out stays unread. A steer that a result names, or that an older Claude Code counts as read, without the turn's first reply naming it, counts as read at the first tool result after it was queued, where Claude folds it in, or at the turn's end if no tool call finished since. A steer that a result leaves queued, or a message sent while no turn runs, such as to an idle child under a Hold, starts a turn of its own, and counts as read when that turn starts, unless the turn's first reply leaves it out.
- fd52df7: The event-driven coordinator decides a child's report without a reserved marker or a CI handoff with a structured completion when the agent sets `decision`. A report that starts with `[usine:awaiting-ci]` keeps its rule, so the attempt completes with the handoff unchanged. The completion runs once on the agent's harness with the `decision` model and effort, on the attempt's worker and the child's credential route, with no usine tools and no saved conversation (a harness that can't turn its own tools off runs them read-only), and returns one decision: complete, replace the child, or fail the attempt. Its usage counts as a separate session of the attempt, including the usage of a failed completion. A refusal, an invalid answer, a usage limit, a timeout, or a replacement past the child-session budget completes the attempt with the report, as without `decision`, and logs the reason at Warning. An agent without `decision` and every other event keep their rule.
  
  `@usine/agents` adds `workerAdmissionContext` to `/harness`, which returns the placement and credential route of a session of any role on a worker, and the platform-free `/harness/registry` subpath for `Harnesses`.
  
  `@usine/core/ci` adds `handsOffCi`, which tells whether a final answer starts with `[usine:awaiting-ci]`. `ciHandoff` and the coordinator both use it.
- fa97db3: The harness runtime seam no longer names a role. `HarnessRuntime` has `open(spec, start, continuation)` and `stop(spec)` next to `preflight`, and no longer extends `ChildBackendService`. `@usine/agents/harness/contract` exports `SessionSpec`, the session's identity, placement and credential route, host, worker, machine, checkout, and environment; `StartPrompt` and `StartResume`, which start a conversation or reopen a saved one; and `NativeSession`, which `open` returns. Claude Code, Codex, and Pi read only the spec and the continuation policy, so any role can open a session. A runtime from `Harnesses` admits the spec's brain at its placement and credential route before opening it, and requires `resume-session` to reopen a saved conversation.
  
  `childContinuation(catalog, runtime)` in `@usine/agents/continuation` builds child launch, resume, and stop over a runtime. It admits each `ChildRequest` with the catalog and splits it into a spec and a `RestartState`, exported from `@usine/agents/runtime`, which the continuation policy carries as `restored`. `continuationPolicy(spec, task, restored)` makes that policy for any spec. The single-harness `ChildBackend` layers admit children with their own descriptor.
- 07b1f29: OpenCode agents can run models of the OpenCode Go plan through the gateway. Connect the plan's key with `usine login opencode-go --api-key`, or `OPENCODE_GO_API_KEY` on the gateway, and set `model` to `opencode-go/<model ID>`, such as `opencode-go/glm-5.3`. A model ID without a provider stays an OpenAI model. The gateway holds the key, and the worker gets only the caller token and the URL of the gateway's `opencode-go` slot.
  
  - `@usine/core`: the provider catalog adds `opencodeGo`, whose slot `opencode-go` serves `/chat/completions` and `/responses` at the plan's OpenAI upstream, `/messages` at its Anthropic upstream, and `/models/{model}:streamGenerateContent` at its Google upstream, each with the key in that protocol's header. It passes OpenCode's session headers and the Anthropic version and beta headers, and accepts only an API key.
  - `@usine/gateway`: the gateway serves the `opencode-go` slot and returns the plan's error bodies unchanged, so OpenCode recognizes its limits.
  - `@usine/agents`: a `HarnessDescriptor` lists the providers that an attempt API key outside a sandbox doesn't reach in `gatewayOnly`, and returns the others as `apiKeyProviders`. A `HarnessCredential` names the variable of each provider's slot URL in `slots`, which `slotEnvironment` renders for the providers that a gateway holds. A descriptor's `modelNotation` and `providerOf` read the provider of a model, as a branded `ModelChoice`, and `reaches` tells whether a route reaches it; `admitBrain` refuses a gateway-only provider's model outside the gateway route. `catalog.modelProvider` and `catalog.modelGatewayProvider` return a brain's provider, and whether a gateway holds its slot. OpenCode lists `openai` and `opencode-go`, reads the gateway's OpenAI slot from `USINE_OPENCODE_OPENAI_BASE_URL` and the attempt's API key's base URL from `USINE_OPENCODE_BASE_URL`, uses the attempt's API key on a gateway route without a slot of the model's provider, reads the provider of the model in OpenCode's `provider/model` notation, and refuses a provider that it doesn't list with the list in the message. Its session allows only the model's provider, and preflight and launch check the model against that provider.
  - `@usine/cloudflare`: the Worker serves `opencode-go.usine.internal` for a sandbox with the plan's key, and denies it otherwise, as for every catalog provider.
  - `@usine/executor`: a gateway route sets the URL of each slot of a harness that the gateway holds in the variable that the descriptor names, and the attempt's gateway credential kind, credential route, provisioner API key, caller token, and logged slot follow the provider of its model, not the harness's first provider. An attempt whose model's provider slot the gateway doesn't hold gets no caller token, so an OpenCode attempt on the provisioner's `openai` key sends only that key to OpenAI. A provisioner's `api_keys` give an attempt only a key that the harness reaches with one. The gateway upgrade notice lists only the paths that changed with slots.
  - `@usine/config`: configuration admits an agent on a gateway route only when the worker's gateway holds the slot of its model's provider, so it refuses an OpenCode Go agent on a worker whose gateway doesn't list `opencode-go`.
  - `@usine/server`: the agent and worker references document the OpenCode Go provider.
- 053494a: Agents can run on OpenCode: set `harness` to `opencode` and `model` to an OpenAI model ID from OpenCode's catalog, such as `gpt-5.4-mini`. The harness pins `@opencode/cli` 2.3.2 and runs `opencode serve` behind the OpenCode bridge on SSH workers, on an OpenAI API key from the attempt or through the gateway's `openai-responses` slot; local workers, which offer only the host's login, refuse it. Its sessions run the coding agent: they take steering, operator messages, and interrupts, report each message that OpenCode reads, wait for background commands, subagents, and input that OpenCode hasn't read yet, report tokens and cost, end with a capacity refusal on a distant retry, a quota, or a plan limit, and reopen their saved session after a restart. Each session gets its own OpenCode data directory, OpenCode reads no configuration from the checkout except its root `AGENTS.md`, and tool commands run with the worker's environment, not with OpenCode's directories. Preflight checks the OpenCode version and the model on every credential route. OpenCode serves no structured completions, so it refuses decision models, and it doesn't run at the orchestrator, so it refuses the supervisor role.
  
  - `@usine/agents/harness`: the catalog registers `opencode`. A `worker.install` entry takes `method: "launcher"`, and `workerImageInputs(catalog, placement)` returns the packages and tag of the harnesses that run at `placement`, with launchers in `launcherPackages`, which images install without optional dependencies into a prefix of their own. The Cloudflare sandbox image installs only the harnesses with a `sandbox` placement, so it doesn't install OpenCode.
  - `@usine/executor`: the attempt image is `ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.172.0-opencode-2.3.2`, which also installs `rg`. It installs OpenCode's launcher into `/usr/local/lib/usine-launchers`, so the launcher fetches only the platform's binary, and its build fails when that prefix holds a platform package. Hetzner workers install OpenCode the same way, and `rg` too.
- d185132: OpenCode serves usine tool sets. `HarnessRuntime.open` on OpenCode attaches the toolkit as the client MCP server `usine` through OpenCode's client MCP WebSocket, which the OpenCode bridge relays as JSON lines: a connect line `{"id","mcp","directory"}`, and `{"mcp","message"}` lines in both directions. The model sees each tool as `usine_<tool>`, and `ToolStarted` and `ToolFinished` carry the toolkit's names. The session's permissions allow `usine_*` and deny OpenCode's `execute` tool, so Code Mode doesn't hide the tools; with `nativeTools: none`, the model's tool list is exactly the usine tools. The runtime waits until OpenCode has listed the tools before the prompt, serves only the calls of the session that opened them, interrupts a handler when OpenCode cancels its call, and reattaches the tools after a restart; the bridge reconnects a socket that OpenCode closes. The OpenCode descriptor declares `usine-tools` and `closed-tools`, which the `host-tool` and `closed-tools` contract scenarios prove on OpenCode 2.3.2.
- eb83984: A session reports each operator message that it reads with the session event `OperatorMessageRead`, which names the message's `OperatorMessageId` and sits in the transcript where the harness reported the read: at once for a message that starts or joins a turn, or at the harness's receipt for a queued one. The operator API's transcript reads return it; the web app's transcript doesn't show it. `OperatorMessageId` moves to `@usine/core/agent/session`; `@usine/core/attempt/channel` still exports it.
  
  The Claude Code, Codex, and Pi adapters share one implementation of receipt matching: each decodes its harness's signals into receipts that name messages by ID, by recorded text, or by count, and the shared conversation decides which messages the session read.
- fa97db3: `ProbeTarget` takes a `placement` and a `credential` from the admission vocabulary (`Placement` and `CredentialRoute`). The `sandbox-api-key` credential becomes the `api-key` route at the `sandbox` placement.
- 2d9ee2e: A model provider is one catalog entry, and the gateway serves one slot for each. An entry gives the provider's ID, its slot at the gateway, its label, each wire protocol's upstream, routes, and key header, the credentials it accepts, the request headers that pass to the upstream, and the variable that replaces its upstreams. One key can serve several protocols: each path under the slot goes to the upstream of the protocol that serves it, with the key in that protocol's header. A provider with a static key needs only its entry. The Anthropic and OpenAI providers are entries with the slots `anthropic-messages` and `openai-responses`, and behave as before, subscription logins included.
  
  - `@usine/core/agent/provider`: `ModelProvider`, `ProviderProtocol`, `KeyHeader`, `ApiKeyCredential`, `SubscriptionCredential`, `ModelProviderCatalog`, the `ModelProviderId`, `GatewaySlot`, `WireProtocol`, `RoutePattern`, `HeaderName`, `GatewayVariable`, and `UpstreamBase` schemas, and `modelProviders`, the catalog of the `anthropic` and `openai` entries. `/worker` no longer exports `GatewayLlmProvider`, `GatewayLlmProtocol`, `GATEWAY_LEGACY_PROVIDERS`, `gatewayLlmProtocolOf`, or `GatewayLlmProtocolFromName`; `ModelProviderCatalog.find` and `slotFromName` read a slot or a provider ID.
  - `@usine/agents/harness`: `HarnessDescriptor.providers` lists the providers a harness can use, in the order it prefers them; `HarnessCredential` drops `provider`, `protocol`, `label`, `apiHost`, and `apiKeyBaseUrl`, and its `gatewayPath` becomes `slotPath`, the path under the slot. `HarnessCatalog.providers` lists each declared provider once, `gatewayProvider` returns the provider whose gateway credential a harness uses, and the catalog refuses a provider ID that two harnesses define differently. A pool route `gateway-api-key` or `gateway-subscription` needs a provider of the harness that accepts that kind of credential.
  - `@usine/gateway`: `GatewaySettings.catalog` holds the providers it serves, and `LlmProviders` holds an `LlmProvider` (an `ApiKey`, `AnthropicSubscriptionToken`, or `ChatGptLogin`, and an optional upstream) by slot; `AnthropicApiKey`, `OpenAiApiKey`, `AnthropicProvider`, and `OpenAiProvider` are removed. The gateway reads each provider's credential from the variables of its entry, reads a caller token from each protocol's key header, and refuses paths outside the entry's routes. `GET /v1/providers` also lists every slot it serves, with its routes, as `slots`. `provider-credentials.json` keeps its format.
  - `@usine/config`: `gateway.llm_providers` accepts the slots of the harness catalog's providers, and their IDs as before slots. `ProviderApiKeys` maps a catalog provider ID to a variable, so a provisioner's `api_keys` accepts any catalog provider and refuses an unknown one; stored `anthropic` and `openai` keys read as before.
  - `@usine/executor`: the gateway preflight refuses a gateway that doesn't serve a listed slot, or a route under it that the catalog declares, and asks to upgrade the gateway to the orchestrator's release; it reports a gateway that doesn't list its slots in `gatewayUpgrade`. `ProviderApiKeys` is a record by provider ID, and `provisionedApiKey` returns the key with its provider. `GatewayModelRoute.request` takes a slot and a path, and replaces `countTokens`. The supervisor relay forwards a model request to any route of a catalog provider.
  - `@usine/durable`: `GatewayModelTransport` takes a slot and, for requests, a path.
  - `@usine/orchestrator`: provisioner views replace `anthropicKeyEnv` and `openaiKeyEnv` with `apiKeys`, the variable of each provider's key by provider ID.
  - `@usine/server`: the operator API's provisioner views have `apiKeys`, and the worker page lists each provider's API key variable.
- eb83984: `ChildBackend.launch` requires `ChildSessionJournal` from its context, so a durable delegation that leaves out its journal is a type error instead of a child whose checkpoints are silently dropped. `ChildSessionJournal.current`, which fell back to a journal that saved nothing, is removed. `ChildSessionJournal.noop` is that journal, for a session that no delegation owns, and `ChildSessionJournal.layerNoop` provides it in tests. `continuationPolicy` takes the journal from its context and carries it as `ContinuationPolicy.journal`, which the Claude Code, Codex, and Pi adapters save through.
- eb58cad: Roles are declarations. `@usine/agents/harness` exports `RoleSpec`, with `RolePlacements` and `RoleCredentials`, and `requirements(role)`, which derives a role's capabilities from its tools, persistence, interventions, and output. `codingAgent` declares the coding agent; the `Role` literal is gone. `admitBrain(catalog, role, brain, context, { reopens })` takes a `RoleSpec`, refuses a placement or credential route outside the role's lists with the role's reason, and requires `resume-session` only to reopen a saved conversation. `BrainRefused.role` is the role's name.
  
  The capabilities add `closed-tools`, `structured-output`, and `ephemeral`. Descriptors declare only what contract scenarios prove, so Claude Code, Codex, and Pi lack `usine-tools`, and admission refuses the supervisor on every harness.
  
  `AdmittedBrain` carries the role and the billing pool that the credential route determines, and `SessionSpec.admitted` replaces `SessionSpec.route`, so a registered runtime admits each session for its own role. `piSdkLayer(sources)` builds the Pi SDK layer from a model runtime and a settings directory.
- b74919c: `RunningSession.steer` takes only the message and no longer accepts an `OperatorMessageId`. A Codex child sent a steer with an ID past its conversation, which never confirmed the read, so the child sent the steer again when the turn ended. Send operator messages with `RunningSession.intervene`. `ContinuationPolicy.recover` gives its `send` callback its own type.
- 5ae7631: Add a redacted stdin environment to `RemoteShell`. The remote shell consumes the environment block before command input and child protocols, keeping values out of command arguments and files.
- 6a42cb3: Harness runtimes run structured completions. `HarnessRuntime.complete(spec, prompt, output)` sends one prompt and returns a `Completion`: the value that the `output` schema decodes, and its usage as a `SessionTokensUpdated` that records the brain and billing pool. A completion saves no conversation and returns no session reference. Claude Code runs `query()` with no built-in tools and an output format, Codex runs an ephemeral, read-only thread with an output schema, and Pi sends one model request through its credential routes with an output tool. `@usine/agents/harness/contract` exports `Completion`, `CompletionOutput`, and `CompletionError`, which carries the tokens spent before a failure and a `reason`: `CompletionInvalid`, `CompletionRefused`, `AgentCapacityError`, or `SessionOperationError`. A usage limit fails a completion with `AgentCapacityError` and the reset time that a session would report.
  
  A runtime from `Harnesses` admits a completion for a role that returns a structured value and keeps no conversation, accepts a `Schema.Class` or identified output schema, and refuses an output schema whose JSON form isn't an object. A session always saves its conversation and returns text, so `open` refuses a role that keeps no conversation or returns a structured value. A completion fails after 10 minutes, with the tokens spent until then. Claude Code, Codex, and Pi declare `structured-output` and `ephemeral`, which the new `structured-result` and `ephemeral` contract scenarios prove. `PiSdk` adds `complete`.
- 1eddd3d: Wait for a Claude usage limit to reset instead of ending the run as blocked. A Claude Code turn that ends on a usage limit (`rate_limit` or HTTP 429) or another capacity refusal now fails the session with `AgentCapacityError` instead of returning the error text as its answer. The attempt fails with `ProviderCapacityFailure`, whose retry starts no earlier than the reset time from Claude's last rejected rate-limit report. A child's capacity report replaces the Pi parent's own blocker, question, or failure report.
  
  `ProviderCapacityFailure` and `AgentCapacityError` have an optional `resetsAt` field, and `pendingProviderRetry` waits for it. The durable testing stub has a `limit` method that ends a child with a usage limit.
- 1b04776: Members can talk to the supervisor through the operator API. `POST /api/conversations` starts a conversation on the instance or a project, and `POST /api/conversations/:conversation/messages` queues a turn behind the conversation's earlier turns. A turn runs in the supervisor sandbox and is read-only: it has `read` on the conversation's scope within the current access of the token or session that posted the message, and it stores its session events as they arrive; `GET /api/conversations/:conversation/events?after=<sequence>` reads them. `POST /api/conversations/:conversation/turns/:turn/cancel` stops a turn and keeps its events. After a restart, a turn that was running is `failed` with the `Interrupted` failure, and queued turns run. `GET /api/conversations/status` reports `ready` or `setup-required`. Each change emits a `conversation` change notice. The conversation routes are not MCP tools, and a turn can't call them.
  
  `runSupervisorTurn` takes an `observe` callback that receives each session event as it arrives. A turn reads the source of the repositories in its scope that the member can read.
- 4aebd77: The supervisor is a role of the harness contract. `@usine/agents/harness` exports `supervisor`, a role that runs on the orchestrator on a gateway credential route, lists only its usine tool set, keeps its conversation between turns, and takes interventions, and `admitSupervisor`, which requires `usine-tools`, `closed-tools`, `resume-session`, `steer`, `interrupt`, and `token-usage`. `@usine/agents/supervisor` exports `runSupervisorTurn`, which opens a supervisor session through `Harnesses` with a toolkit, or reopens the saved session for the conversation's next turn, and returns the answer, the saved session, and the session's cumulative usage across turns. A failed turn returns `SupervisorTurnError` with the usage that the session had spent. When a Claude Code process resumes a session, the first result's `modelUsage` minus its `model_usage_since_last_result` is the usage that Claude restored. usine counts that usage once and logs it at Info. This applies to a replacement process, to a process that the adapter resumes after its remote process stops, and to either one when the orchestrator reattaches it before its first result. `SessionTokensUpdated.processUsage` records `awaitsFirstResult` until then.
  
  `settings.supervisor: { harness, model, effort }` selects the supervisor's brain. Saving the configuration refuses a harness that can't serve the role and names what it lacks; Codex is refused, because it lists its own tools in every thread. An instance without the setting starts, and `SettingsView.supervisor` is null, which **Configuration > Settings** shows as not configured. The settings form edits the brain.
  
  The server builds the supervisor's operator toolkit from the operator tools that the MCP endpoint serves, filtered by the member's grants and operation ceiling, and answers each call through the operator API with the member's credential.
- c5be05b: The orchestrator can run supervisor turns in a read-only container on its host, with the instance's source to read, on Claude Code, Codex, and Pi. No interface opens a supervisor conversation yet.
  
  `RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host, and its grep runs as a Node.js script there, with Pi's glob, pattern, and output limits.
  
  `@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. The relay and the route drop every header in `CALLER_CREDENTIAL_HEADERS`, which `@usine/gateway/admin` now exports. The sandbox writes the harness's settings without following a symbolic link, and runs one turn of a conversation at a time. A container whose orchestrator stops ends itself, and the next start removes any that remain. `makeSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount, and holds each tree until the turn ends. It removes a tree once the tree is no longer the head and no turn holds it.
  
  `@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.
- ce404bf: Supervisor turns run under the documented systemd unit, which sets `NoNewPrivileges=yes`, on a host with only Docker or Podman. The harness's home is now an in-memory filesystem of `supervisor_limits.conversation_size_mib` in each turn's container, and usine keeps each conversation's saved home on the orchestrator as an archive at `.usine/supervisor/homes/<sha256>.tar`. usine copies the archive into the container before the harness starts, and copies the home back when the turn ends, up to `conversation_size_mib`. A save that fails or exceeds the limit keeps the previous archive and fails the turn with the reason. Pi's session files on the orchestrator are checked against the same limit before and after each turn. Conversation storage no longer needs FUSE, `fuse2fs`, `fusermount`, `e2fsprogs`, `fallocate`, `/dev/fuse`, or `user_allow_other`.
  
  `conversation_size_mib` now defaults to 128. The home and `/tmp` count against `memory_mib`, and together they may use at most half of it; otherwise usine refuses turns and names the settings.
  
  Startup runs a check in the background: a container with a turn's limits and in-memory home, into which usine copies a small home and back out. **Configuration > Settings** and `GET /api/conversations/status` report the supervisor as ready only after the check passes, and give the reason while it runs or after it fails. Under `NoNewPrivileges`, rootless Podman is reported as unable to run, because it needs the setuid helpers `newuidmap` and `newgidmap`.
  
  Startup removes the ext4 conversation images of earlier `next` versions and every conversation directory they used, and logs one line for each. The next turn of such a conversation starts a new harness session.
- 039daa4: `HarnessRuntime.open` takes an `effect/ai` `Toolkit` as its last argument and serves it to the session as a usine tool set. The handlers come from the calling context, so the role that opens the session decides what each call can reach. Claude Code serves the toolkit as the in-process MCP server `usine`, over the CLI's own stdio, and loads its tools in the first prompt. Pi serves it as custom tools. A role with `nativeTools: false` gets a session that lists only the toolkit's tools: Claude Code starts with no built-in tool and ignores other MCP configuration, and Pi activates none of its own tools.
  
  `ToolStarted` and `ToolFinished` carry the toolkit's names without a harness prefix. A name that a harness can't carry gets a stable alias that maps back. The model sees and sends each tool's parameters and result in the JSON form of the tool's schemas, so fields such as `Option` and `DateTime.Utc` work. A handler failure, invalid parameters, an input that isn't JSON, a result that doesn't encode as JSON, or a handler defect returns an error result to the model, and the session continues. A call that the harness cancels interrupts its handler. An alias and a cancelled call are logged at Info, an input that isn't JSON is logged as a warning, and a result that doesn't encode as JSON is logged as an error. The registry refuses a session that opens with a toolkit when its role runs no usine tool set, or without one when its role runs one. Because a structured completion serves no usine tools, the registry also refuses a completion for a role that runs a usine tool set, and a Claude Code completion ignores MCP servers from the worker's configuration.
  
  The Claude Code and Pi descriptors declare `usine-tools` and `closed-tools`, which the new `host-tool` and `closed-tools` contract scenarios prove for both. Codex still lacks `usine-tools`, with a reason that names step 19 of the harness adapter plan. `ClaudeSdk.open` takes the session's tool server as a third argument, and `PiStartOptions` adds `nativeTools` and `hostTools`.

### Patch Changes

- 7626bb7: Child recovery avoids resending a saved task or operator messages already reported as read. A held, paused, or idle child whose saved conversation holds no task receives the original task, replacing any saved idle report. A missing Claude Code prompt acknowledgment can cause a completed task to repeat. A paused Codex child interrupts its task turn until operator guidance arrives. A remote Claude Code child that loses its process before its owner acknowledges the task receives the task again, not the continuation instruction. Codex recovery reports unread guidance that the saved thread's last turn records as read instead of resending it, and previously observed user-message items don't count again after an orchestrator restart. For older delegations without receipt history, recovery of a finished turn keeps guidance queued and records the existing items before matching on later recoveries. On an active reattach, replayed notifications can acknowledge unread guidance, and the next live receipt saves the turn’s existing user-message IDs together. Concurrent guidance never starts a second Codex turn. A Pi recovery steer that Pi handles at once is reported as read. A failed native reopen keeps its error as the cause of the `SessionInterruptedError`. When a restored `subagent` call fails before it restores its child's operator messages, the parent's delivery pass settles them as soon as the call returns.
- b6fd6b2: A remote child whose process owner fails during setup, for example because the owner cannot read its own process identity, now fails at once with the owner's reason as its exit diagnostic. Before, the relay waited 10 seconds and exited without one.
- 039daa4: A child process owner relay no longer crashes when the harness exits while the relay checks its PID file. The relay reported the owner as gone only after it read the file, so a harness that exited between those reads could leave the session reporting a failed shutdown.
- 71ecb9e: By default, Claude Code children add no attribution to commits or pull request descriptions. Each child starts with `attribution` set to an empty `commit` and `pr` text in Claude Code's flag settings, which take precedence over the worker user's `settings.json`. Instructions about attribution in the repository's `CLAUDE.md` or in Claude Code memory still take precedence over these settings.
- 322d45e: A turn result logs a Claude control request that is still unanswered only once, at the first turn result handled after the request, instead of at every turn result. The cancellation log no longer has a `released` field. Both outcomes log at Info: a cancellation that releases a pending request logs "Claude cancelled a control request", and one that releases nothing logs "Claude cancelled a control request that is not pending" instead of a Debug log. Blank Claude stdout lines, such as the empty line after each `\r\n`, are checkpointed without a Debug log. A late response to a cancelled control request no longer answers a later request that reuses its ID, whether the output checkpoint reads the later request before or after that response; the later request stays pending until its own response follows the late one. An acknowledged late response logs "Claude acknowledged the late response to a cancelled control request" at Info with its request ID. Saved Claude usage drops superseded message IDs as soon as an acknowledged hook response lets the output checkpoint catch up, instead of at the next message the checkpoint covers.
- 650d14a: The Codex app-server starts with `sandbox_mode = "danger-full-access"` as its default. Every thread usine starts still sets its own sandbox, and Codex no longer reports `Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.` at each start in a container without user namespaces.
- 3fef8e2: When a Codex app-server has already exited, stopping it no longer logs `Could not force Codex app-server to stop` or `Forcing Codex app-server to stop after graceful shutdown failed` as warnings. A forced stop that fails because the process is gone, or a failed graceful shutdown whose exit code is already known, logs at debug level with the exit code. Both warnings still appear for an app-server that is still running after the forced stop.
- 4eec609: Log a warning when a Codex thread item of a recognized tool kind does not decode, instead of skipping the item silently. The warning includes the decoding cause and the item type, for item notifications and for the in-progress turn of a resumed thread. Log the same warning, with the cause and item type, for an agent or user message item that does not decode, instead of skipping it silently. Log at Info when an item notification of a kind other than a tool or a message is skipped, with its item type.
- 650d14a: An orchestrator upgraded before its gateway keeps attempts running. Preflight reads the gateway's provider report: while the gateway reports `anthropic` and `openai` instead of protocol IDs, attempts on its workers call `/anthropic` and `/openai/v1`, and the orchestrator logs a warning once for each worker. The coordinator and supervisor model route reads the same report when it opens, on each credential check, and every two minutes, and uses those prefixes too, as it does for a gateway without the report. After the gateway is upgraded, the next preflight switches attempts to `/anthropic-messages` and `/openai-responses/v1`, and the route switches at its next report read without an orchestrator restart.
  
  `PreflightReport.gatewayUpgrade` and `MachineCheck.gatewayUpgrade` say why a worker's gateway is older than the orchestrator: it serves only the provider prefixes, or it has no provider-credentials admin API. Needs attention shows each such worker as a `WorkerGatewayNeed`, **Gateway upgrade needed**, without blocking its attempts. `GatewayAdmin.providers` returns the reported providers with the path prefixes the gateway serves, and `GatewayAdmin.servesProviderCredentials` checks the provider-credentials route and logs a warning when the route answers with an error other than 404.
  
  When a gateway answers 404 for the provider-credentials route, Settings > Provider connections says that the gateway is older than the orchestrator and names the `@usine/gateway` version that the server depends on. The server logs a provider destination's error when it changes rather than on every poll.
  
  `@usine/core` exports `GATEWAY_LEGACY_PROVIDERS`, `gatewayLlmProtocolOf`, and `GatewayLlmProtocolFromName`, which read a gateway slot's provider name from before protocol slots as its protocol. A harness credential's `gatewayPath` must start with its protocol.
- eb83984: `HarnessSession.make` requires the harness's conversation `id`; the schema no longer assigns a UUID. The Claude Code adapter draws one for a new conversation, because Claude Code takes the ID from its caller.
- 3eccfe4: A remote OpenCode child no longer fails when its bridge is lost during a read of OpenCode's state that runs after a failed steer made the answer due. The read logs the loss and stops, and the child reopens its session on a new bridge, as it does when the loss happens during any other read. A check that started before a restart doesn't answer for the reopened session.
- edf94cf: An OpenCode child whose execution succeeded no longer fails on one read of OpenCode's running jobs, inbox, or active sessions that gets a server error (HTTP 5xx) or no answer within 60 seconds. The runtime logs the failure at Warning and retries it twice, about 1 and then 3 seconds later. If the read still fails, the child fails with a `SessionOperationError` that names the read. Any other failure of the read, such as a 4xx answer or a body that doesn't decode, fails the child at once with an error that names the read. A read that loses the bridge isn't retried: a remote child reopens its session on a new bridge, and a local child fails with the bridge's own error.
  
  A paused OpenCode child whose late steer OpenCode delivered before it answered the steer's post now ends its turn with the successor execution that the steer starts, not with the paused execution's answer. A late steer that OpenCode delivers while the runtime interrupts the paused execution, before a successor starts, was read by that execution, so the paused execution's answer ends the turn.
- 9a85543: A held OpenCode child reports each answer idle once. Before, when the last steer that an answer waited for failed and a read of OpenCode's state then waited for a retry, an operator message could start and finish the next execution in the meantime, and the child reported that execution's answer idle twice.
- 3eccfe4: An OpenCode child whose execution succeeded while OpenCode's inbox listed input returns that execution's answer when OpenCode cancels the input. Before, the child waited without another check.
- 08de94f: OpenCode starts in a Docker or Podman attempt container that mounts the shared pnpm store (#1450).
  
  - `@usine/agents`: OpenCode sessions, the `opencode --version` check, and the model check keep OpenCode's data, configuration, state, and cache directories in the session's data directory or a temporary directory, never in the home directory. The model check keeps its database there too, even on a worker that sets `OPENCODE_DB`. A version check that exits with a code other than 126 or 127 fails with its exit code instead of an installation check, and the **Harness prerequisite check failed** log entry has the exit code and the end of the command's error output. `hostOutput` and `probeOutput` return the command's trimmed `stderr`.
  - `@usine/executor`: the attempt image gives the `usine` user `~/.local`, `~/.local/share`, `~/.local/state`, and every parent of the shared cache mounts, which the runtime would otherwise create as root. The image's tag ends with the first 12 hexadecimal digits of the SHA-256 digest of the image's files, so a worker that has the earlier image pulls the new one: `ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.172.0-opencode-2.3.2-68d8c89ccdaa`.
- b74919c: Codex and Pi children no longer report an operator message read when the harness records the child's own input with the same text, such as its task or a continuation message. The session's own inputs take those records first, so an operator message that repeats the task stays queued, and Codex sends it again with the next turn if the turn ends without reading it.
- b74919c: Pi children record their prompt receipt after Pi appends the first user message to the conversation file, instead of while Pi's listeners see the message end.
- eb83984: Codex and Pi children record their prompt receipt, as Claude Code children do, so a delegation's saved progress no longer reports that a Codex or Pi child never received its task. Codex records it when its first turn starts, and Pi when it saves the first user message of its conversation. Only Claude Code reads the receipt after a restart.
- 360d371: `reportedOutcome` treats a quoted blocker or question marker as ordinary text. A marker inside a fenced code block, including one indented under a list item, inside a string literal such as `"[usine:blocked]\nmsg"` or a quoted string that spans lines, such as `The child answered "[usine:blocked]` followed by a line break, or after a space in a sentence, such as "The child returned [usine:blocked]", no longer fails the session. A marker at the start of a line, or appended directly to narration at the end of a line, including narration that ends in a closing quote or inline code such as ``run `gh pr view`[usine:blocked]``, still produces `AgentBlockedError` or `AgentQuestionError`. The exception is a run of one repeated quote character at the start of a line or after whitespace, `(`, or `=`, even when it closes a string, as in ``set `FOO=`[usine:blocked]`` or `set to ""[usine:blocked]`: it reads as an opening quote, so that marker stays ordinary text. The same rule applies to child sessions.
- 33bab87: Require container seats for supervisor sessions and enforce configurable CPU, memory, process, temporary storage and persistent conversation limits. Conversation storage on Docker and Podman requires Linux FUSE and a preallocated ext4 filesystem. Make relay request and supervisor Codex frame limits configurable, bound Pi file reads, restrict model forwarding, and remove labeled containers at turn end, shutdown and startup before reopening a conversation.
- b1b75bd: A child's wait for its background work now ends only for the answer that started it. When a later answer replaces an answer that waits, such as an idle report under a Hold, the earlier wait's timers stop. Before, the earlier wait's grace period could return a later answer while its work still ran.
  
  A held child that last reported idle now emits `SessionResumed` when an operator message starts its turn, even if a later answer that waits for background work replaced the idle report. The run page then shows the child working instead of waiting for input.
  
  A turn end no longer drops an own input that the harness holds for its next turn. An operator message that repeats that input stays unread until the harness records it.
  
  The run page shows the "No background work" note for a child's first loaded snapshot when the rows from the child's start aren't loaded, because the work that the snapshot ended can be on an earlier page.
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

## 0.7.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 389f35e: Generate worker image packages and tags from harness descriptors. Export `workerImageInputs` from `@usine/agents/harness`, derive the default SSH attempt image from it, and keep both Dockerfiles, Hetzner cloud-init, image publishing, and snapshot creation consistent with the catalog.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 12c3921: Check harness capabilities by role, credential route, and placement with one admission policy. Configuration and preflight refusals identify the missing requirement and adapter reason. Validate parent models, efforts, and credentials before accepting configuration imports, reloads, or saved edits. At startup, quarantine agents with refused parent brains and their loops in Needs attention while keeping the server available. Restore them after a corrected reload.
- 548e6b7: Register harness preflight and launch through `Harnesses` on `@usine/agents/harness/node`. Registration rejects incomplete descriptor/runtime pairs and duplicate IDs. Gateway, injected-key, and Cloudflare preflight use the registered runtime with their credential route. Refusal messages name the harness and its installation location, mention a login only for host-login probes, and retain sandbox-image guidance for Cloudflare. Successful binary probes log the installed version.
  
  Replace the three harness-specific backend tags with `ChildBackend`, and rename the single-harness layers to `claudeChildLayer`, `codexChildLayer`, and `piChildLayer`. Replace `ClaudeLoginLock` and `claudeLoginLockLayer` with `HostLoginLock` and `hostLoginLockLayer`; `withLock` takes the harness ID before the worker and machine. Share one lock layer between the executor and attempt runtime.
  
  `preflight` accepts a `ProbeTarget` and requires the injected `Harnesses` service. Build the registry once with the process spawner and shared `HostLoginLock`, then provide it to the executors and durable attempt runtime. Registration errors remain typed until the server reports a startup failure. It returns capability gaps as readiness reports and fails on transport errors or timeouts. Custom `HarnessProbe` wrappers forward the worker and machine context in their second argument.
- 1c981c9: Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.
  
  Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.
- fc15261: Save Pi child conversations under each attempt checkout and expose a runtime operation to continue them by saved session ID after the process exits. Record saved session metadata in the transcript and declare the resume-session capability in harness descriptors. Preflight probes remain in memory.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 10154eb: Continue saved child conversations through `ChildRequest.resume`. Launch admission checks the resume capability for the worker and credential route, and each harness restores its saved session location.
  
  Codex stops the original and reconnect app-servers before replacing retained transports for a saved-thread resume.
  
  Restore paused child sessions as idle and wait for operator guidance before starting another model turn.
  
  Initialize resumed Claude Code and Pi usage meters from `ChildRequest.usage` so token and cost totals include earlier processes.
- 9cf0b5e: Share child continuation policy across Claude Code, Codex, Pi, and durable restart. Native resume reopens a conversation without sending input. Working children receive one continuation and unread guidance; supervised children wait. Persist a limit of three continuation turns per ten minutes and close interrupted tool calls with errors.
  
  Assign Claude session UUIDs before the first prompt and give operator messages stable UUIDs. Acknowledge guidance by native message IDs so identical messages have separate delivery receipts, and use Claude's pending-send count only for results without UUID receipts. Send the task to a retained Claude process that never acknowledged its prompt. A restored child keeps its unread messages until its call ends. Preserve unread Codex guidance across turn boundaries and active-turn reattachment. Failed resume returns interrupted without spending another child-session slot, and a replacement clears the previous child's infrastructure failure.
- 9e30c8c: Add the Node `child-host/owner` API and use one process owner for Claude Code and Codex. Remote children reattach across SSH loss and orderly restart, with a two-minute orchestrator lease and bounded exit diagnostics. Local children terminate their process groups when the orchestrator pipe closes, including after a crash.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.

### Patch Changes

- 47c0f07: Ship the child-host worker programs minified. When the worker owner cannot identify its lifeline, the child ends at once with that reason in its exit diagnostic.
- df0bd8f: Log child blocker and question reports at Info with their report kind across Claude Code, Codex, and Pi. Keep harness and infrastructure failures at Error.
- b70b5fe: A control request that Claude Code cancels no longer holds back the output checkpoint of a remote Claude child. A turn result logs the subtype of each control request that is still unanswered. Claude stdout lines also end at a lone carriage return, as in the Claude Agent SDK.
- 09417f7: Preserve Claude Code sessions across orchestrator restarts on container-isolated SSH workers. Store projects in an attempt-scoped worker directory until checkout cleanup, and remove orphan session directories during sweeping and provisioned machine resets. Harness descriptors declare container session storage independently of credential wiring.
- b7ff637: Report Claude Code subscription allowance windows for the Claude plan pool. Five-hour and seven-day utilization reports update pool health and Needs attention warnings, preserving the latest observation of the other window across children and attempts. API-key sessions do not update Claude plan windows.
- 10822d3: Fix Codex checkout trust overrides so children disable project-local configuration, hooks, and exec policies even when the saved configuration marks the checkout as trusted. Start the app server outside the home directory to avoid repeated configuration warnings.
- 1674238: Generate Codex app-server response and notification schemas from a pinned upstream commit. Accept new status and phase strings when decoding saved threads and notifications, while preserving domain validation and the supported CLI version policy.
- 3e822f6: Accept Codex responses that omit keys the app-server protocol marks optional, such as the model list cursor and a turn's error. Codex schema generation fails on the unsupported schema shapes listed in the package README instead of producing a wrong decoder.
- 92f21ce: Keep remote Codex app-servers running through SSH drops and reattach to their pending turns. Resume the saved thread once if the app-server exits, preserving operator pauses and idle sessions. Record child transport failures as infrastructure failures even after earlier child reports or parent blockers, so attempts retry automatically from recorded salvage.
  
  Preserve the original task when an app-server exits before saving its first user message. Recovery continues saved work when the task is already recorded.
  
  Replay unread operator guidance when recovering a Codex thread. Report delivery after the recovered turn accepts the messages, and preserve unread guidance while the child waits for the operator to resume it.
  
  Replay incomplete output frames after an SSH disconnect, preserving the last complete output offset.
  
  Discard incomplete input frames before journaling them so reconnecting preserves the running app-server. Acknowledge guidance included in resumed input when Codex reads it, preventing replay after another pause.
  
  Preserve the recorded process-loss error when the app-server exits before the first turn request starts, so recovery resumes the saved thread.
- 8c079aa: Route coordinator model requests through the instance's first configured gateway with a caller token. The orchestrator host needs no provider login when a gateway is configured. Check coordinator gateway credentials at startup and keep usage in the API-key or ChatGPT plan pool. Expose the gateway model route for orchestrator-hosted runtimes.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- 9d7dfb0: Generate and check the Codex protocol schemas from a committed copy of the pinned upstream schema, so `codex:generate` and `codex:check` work without network access. `codex:check:upstream` also confirms that the copy matches the pinned commit, and reports a failed fetch in one line with exit code 2. A remote child without a session, or a remote readiness check, given a non-empty environment now fails instead of exporting the values on the SSH command line.
- 35f68ef: Stop child connection recovery when an attempt detaches during orchestrator shutdown. Codex preserves its remote supervisor and journals for reattachment, and Codex, Claude Code, and Pi suppress shutdown infrastructure failures.
- 3229601: Run Pi children on a ChatGPT subscription with an `openai-codex` model. Preflight accepts the Pi login without an API key, and child usage counts in the ChatGPT plan pool. OAuth providers without a supported billing pool remain unavailable.
- bb96f16: Save a Claude child's zero usage for its replacement process before the replacement launches, so an orchestrator stop during that launch keeps the earlier process's tokens and cost in the session total. Wait for the worker to acknowledge pending input before the detach checkpoint, so an answered hook is not replayed after the restart. Save active and uncheckpointed assistant message IDs with the process usage, so a reattached process doesn't count their replay again.
- 6316707: Connect Claude and ChatGPT from setup, Settings, or `usine login`, with subscription and API-key options. Save completed logins on the configured gateway or in local harness storage, show credential metadata, and replace or disconnect credentials without manually transferring files.
- 89ae7ee: Group the Claude Code, Codex, and Pi child harness implementations under `harness/` while preserving the published subpaths.
- 9476883: Pass the rendered loop task unchanged to each child, with parent-written text as supplemental context. Record the exact child prompt in the transcript and display it in the run page's attempt details.
- b6a858e: Send remote child environments over stdin so gateway caller tokens stay out of SSH and container command arguments during launch, reconnection, and cleanup.
- 0e34ec1: Recognize blocker and question reports after narration in final answers so interrupted work fails the attempt instead of reporting success.
- 10154eb: Keep held children that finished their turn idle after an orchestrator restart. Release returns the saved report to the parent; operator guidance starts another turn. Include the completed report in SessionIdle events for recovery.
- 1948b10: Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
- ef5aa4d: Save the remote child's output checkpoint when the worker doesn't acknowledge pending input within 4 seconds of a detach, instead of skipping it. The worker relay now ignores an input line cut off by a dropped connection and exits normally. If the worker cannot identify the process that holds the child, it stops that process and exits instead of leaving the child unsupervised.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- fc18d3f: Build the child process owner and lifeline from TypeScript into self-contained Node programs. Add direct worker lifecycle tests for input replay, lease expiry, stale process identities, environment changes, and TERM-to-KILL shutdown.
  
  Track relay input history, retry state, and output checkpoints in Effect refs, with separate connect, replay, stream, and reattach phases.
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

## 0.6.0

### Minor Changes

- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.

### Patch Changes

- a7692ae: Upgrade the Codex protocol baseline and worker images to 0.164.0, which includes updated TLS certificate roots. Preflight rejects 0.153.4 and accepts 0.159.0 through 0.159.3 for one release while existing worker images upgrade. The gateway model-provider configuration remains compatible. Claude Code stays at 2.1.308.
- 93bbe77: Upgrade the Pi packages to 1.4.0 and define the checkpoint policies required by pi-durable. Attempt and hold documents retain their existing delta-storage behavior. Disable the task restart limit to preserve automatic resumption after repeated crashes.
  
  Back up the instance with `usine backup <path>` before upgrading. Starting the upgraded server migrates `durable.sqlite` to SQLite storage schema version 2, which pi-durable 1.3.0 and earlier cannot open. Do not downgrade usine past this release: `usine upgrade <older version>` cannot reverse the storage migration.
- 06a10bf: Disable Codex plugin and app sync, startup update checks, and analytics in child and preflight commands. Disable Claude Code's claude.ai connectors and nonessential traffic in the attempt environment on every worker kind.
- f54b3bd: Record the provider login in `PoolRateLimitsUpdated.login`. Codex records the ChatGPT login email and refreshes it after an account change. Older snapshots and gateway-backed sessions remain readable without a login.
- 98eb9cd: Document the public agent API, including harness SDK contracts, session errors, child hosts, and prompt inputs.
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

## 0.5.0

### Minor Changes

- 113d150: Preflight accepts Codex CLI 0.153.4 and 0.159.0 through 0.159.3, and refuses 0.144.0. The protocol conformance baseline is `@pwrdrvr/codex-app-server-protocol` 0.159.2. `@usine/agents/preflight` exports `supportedCodexVersions`.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)).

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 2f78d3a: A remote Claude child whose SSH connection breaks, for example while the orchestrator's machine sleeps, resumes its saved session instead of failing ([#603](https://github.com/basaltbytes/usine/issues/603)). The backend stops the Claude process left on the worker with the new `CHILD_STOP_SCRIPT`, then starts Claude with `resume` in the same child session, so the parent spends no child budget. It tries after 5 s, 15 s, 30 s, 1 min, 2 min, and 5 min, and fails the child as before after the last try. A child whose Claude process exits on its own, or that runs on the orchestrator's machine, still fails.
  
  `claudeChildLayer` and `claudeChildBackendLayer` require a `ChildProcessSpawner`. `/child-host` exports `SSH_FAILURE`, the exit code of the OpenSSH client when the connection fails.
- 1514af9: On a provisioned worker, the Claude login lock covers one machine instead of the whole worker ([#591](https://github.com/basaltbytes/usine/issues/591)). Each machine has its own login, so a Claude child or preflight check on one machine no longer waits for a Claude start on another. A worker's long-lived machine keeps one lock for all its attempts.
  
  `ClaudeLoginLock.withLock(worker, machine)` takes the provider's `MachineId` of a provisioned machine, or `None` for the worker's shared login. `ChildRequest` and `AttemptRequest` require `machine`, which the executor sets from the attempt's machine. `AttemptRequest.machine` isn't stored; each `execute` call supplies it.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
- 80f2eb6: `HarnessSession` has an optional `home`: the directory the harness saved the session in when the attempt set one in place of the harness's default. A Codex child records its `CODEX_HOME` there and in the `Codex child session saved` log, so a resume command can find a session that an attempt behind a gateway saved in its own Codex home. Older records decode `home` to `Option.none()`.
- 3d54b01: Codex sessions now have a price. `SessionTokensUpdated` has an optional `breakdown` of input, cached input, cache write, and output tokens, which Codex children report. `@usine/agents/openai-prices` exports `openAiPrice`, which prices a breakdown at OpenAI's API rates for the models that the supported Codex CLI versions list.
  
  Run and task usage prices a Codex session that its harness didn't price from that table, marked as an estimate in the ChatGPT plan and not in the API keys pool. ChatGPT plan sessions that Pi prices keep Pi's figure, now shown as an estimate. A Codex model without rates stays unpriced and is logged once. The run page shows ChatGPT plan prices instead of `No dollar rate`.
- d82c6cd: A Pi child gets only Pi's default tools: `read`, `bash`, `edit`, and `write`. Before, the global Pi `defaultTools` setting could add tools such as `grep` and `find`, which run `rg` and `fd` with the orchestrator's environment and its secrets. `bash` still runs with exactly `ChildRequest.environment`.
  
  The `Started` result of `PiSdk.start` adds `tools`, the names of the session's active tools, which the Pi child backend logs at debug level.
- 266986a: The nine `@earendil-works/*` packages are at 1.2.0. pi-durable 1.2 closes the harness on any storage error, a read included, so `DurableHarness` now handles a failed harness instead of a poisoned session or a stuck step:
  
  - An attempt that is running when a storage error fails the harness fails with a retryable `InfraFailure` whose cause is the new `DurableStorageFailed`, and the engine retries it from salvage. The harness reopens the storage, aborts those attempts' tasks, and resumes the other tasks.
  - A storage error before the harness resumes its tasks fails the layer with a `DurableHarnessError` that names the error, and `usine up` doesn't start.
  - If the reopen fails, or the reopened harness fails within a minute, the harness stops until the orchestrator restarts.
  
  `HarnessListener` replaces `onReopen` and `onStop` with `onFailure`, `BeforeResume` also receives the storage, and `StuckStepReports` is removed. The `subagent` tool returns the child's report as `output`, the field that pi-durable 1.2 reads instead of `content`.
- 4c63872: The Pi preflight session's `bash` tool now gets the worker's environment instead of inheriting the orchestrator's. Preflight never prompts, so no tool ran, but the session was built as if it might.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
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

## 0.4.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- 8292038: `ChildRequest` contains the child's complete environment, and Claude Code, the Codex app server, and the Pi child's bash tool run with only that environment. `@usine/agents/pi/authentication` exports `splitPiModel`, `piAuthentication`, `requiredPiPool`, and `resolvePiPool`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- caf041d: Removes the Pi parent runtime, which runs in `@usine/durable`: `@usine/agents/pi/live`, `AgentRuntime`, `LaunchRequest`, `ChildSessions`, `piParentLayer`, the subagents extension, and the `typebox` dependency. Removes `PiStartOptions.toolMode`, makes `PiStartOptions.model` a required `ModelId`, and removes `requiredPool` from the `AuthenticationUnavailable` and `UnsupportedAuthentication` start results.
- a55d12d: `harvestFacts` and `harvestPostedComments` record a comment or review only if its body ends with the signature of the attempt's agent, so attempts of two agents on one item no longer record each other's comments. The harvest log counts other comments as `unsigned`.
  
  `githubSignature` moves from `@usine/agents/prompt` to `@usine/core/agent`, and `HarvestSpec` reads the RunSpec's `agent`.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 0799f4f: `ChildRequest.host` sets where a child runs: `LocalProcess`, or `RemoteShell`, which runs each child through one SSH command in the worktree. `@usine/agents/child-host` also exports `sshArguments` and `CHILD_KILL_SCRIPT`; Claude Code and Codex children support a remote host, and Pi children refuse it with `AgentResultError`.
  
  `preflight(brain, host, environment)` and `verifyHarness(brain, host, environment)` take the host and environment to check. On a `RemoteShell` host, probes run over SSH, an SSH failure is an incomplete check, and a Pi brain is unavailable.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- acef6eb: Upgrades `@anthropic-ai/claude-agent-sdk` to 0.3.308, which bundles Claude Code 2.1.308 without the compromised eMudhra certificate authorities. Claude children still run the worker's own `claude` from PATH.
- a3a230c: Preflight reports a logged-out Claude Code worker as needing `claude auth login` instead of as a failed command. Other non-zero exits and output that isn't a login status still report the command as failed.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 5519ca3: The Pi backend checks a model's effort with `getSupportedThinkingLevels` from `@earendil-works/pi-ai`, as the Pi parent does. `@usine/agents` depends on `@earendil-works/pi-ai` 1.1.0 directly.
- 9b78093: Upgrades `@earendil-works/pi-coding-agent` to 1.1.0; the Pi parent's steer reports whether the message was handled or queued.
- 458033e: A Pi child records provider retries as `ProviderRetrying`, with Pi's message and the turn's retry count, and recovery as `ProviderRecovered`, like Codex and Claude Code children.
- e518906: Pins `@earendil-works/pi-codemode` to 1.1.0, next to `@earendil-works/pi-coding-agent` 1.1.0. Fixes a `SyntaxError` in `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` when a plain install resolved pi-codemode 1.3.0, which doesn't export `MCP_TYPESCRIPT_PREAMBLE`.
- 7078fa8: Pins the `@earendil-works` packages `chord`, `pi-agent-core`, `pi-mcp`, `pi-telemetry`, and `pi-tui` to 1.1.0, matching `pi-coding-agent`, so a plain install gets the workspace's versions.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 71c8b48: Claude children stay open until background work and notification turns finish. An agent reports an unresolved blocker with the `[usine:blocked]` marker, which fails the attempt without a retry.
- 07a4145: An attempt fails if the Pi parent paraphrases a child's `[usine:blocked]` report; the parent receives the report with its marker intact.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
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

## 0.3.0

### Minor Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 34aeb4a: Upgrades Pi to 0.85.1 and the Claude Agent SDK to 0.3.261. Pi supports GPT-6 Astra with OpenAI API keys or Codex subscriptions, and Claude Fable 5.1 with Anthropic API keys.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 28ec315: Supports Codex CLI 0.153.4 and stops Codex child processes, including leftover background commands, before their sessions complete.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- fb24c80: Adds Codex app-server and API-key-only Pi children to the subagents extension (protocol v3).
- 684757f: The Pi parent can use a ChatGPT subscription through the `openai-codex` provider, and has no repository coding tools, so work goes to the child.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
