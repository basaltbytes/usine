# @usine/config

## 0.7.0

### Minor Changes

- f8f311c: boxd workers connect to any boxd cluster. `provisioner.endpoint` sets the cluster's account endpoint, such as `https://boxd.example.com:9443`, and defaults to the hosted service at `https://boxd.sh:9443`. The driver sends account calls and `ListRegions` there, and derives the token exchange URL from it as the boxd SDK does: `https://app.<host>/api/v1/auth/token`, without the port, or the endpoint itself for a `localhost`, IP address, or `app.` host.
  
  `provisioner.region` is optional and no longer defaults to `fra`. Without it, every call goes to the endpoint, and machines start where the endpoint runs them: Frankfurt on the hosted service, or the only location of a self-hosted cluster. A region that the endpoint serves itself needs no API endpoint in the region listing. Preflight compares the snapshot's region with the region that boxd serves, and fails with advice to remove `provisioner.region` when a cluster that runs in one place lists no regions.
  
  Over TLS or to a loopback address, the driver sends the API key as the bearer. It falls back to the token exchange when boxd refuses the key as a bearer, and keeps renewing the session and retrying a call once on `UNAUTHENTICATED`. `Exec` calls carry the session too once boxd refuses the key, so a cluster behind a load balancer that terminates TLS runs commands. `provisioner.endpoint` accepts `http://` only for `localhost`, `127.0.0.0/8`, or `[::1]`, and a port only from 1 to 65535. The driver refuses to connect to a region that boxd lists at an `http://` API endpoint on another host. When boxd doesn't answer or rate-limits, the error names the URL that usine called. The operator view and the worker form show the endpoint, and the view reports a missing region as null.
- 2b3ac6b: boxd workers accept `provisioner.egress`, the complete egress allowlist of each machine: host names, `*.` wildcards, public IPv4 addresses or CIDR ranges of at most `/8`, or `none`. Like boxd, the configuration refuses an address with host bits set or one in a private, CGNAT, loopback, link-local, multicast, or reserved range. The driver sends it in the machine spec of the restore request, so each machine is created with it, and waits one second before it connects to the machine: processes that the snapshot resumes can reach hosts outside the list for up to about a second. If boxd reports the new machine unrestricted, the driver deletes the machine and retries creation. A reused machine gets the list again. Without `egress`, machines keep unrestricted egress.
  
  Behind a gateway, the configuration is refused when the list omits `*.tailscale.com`, or admits `github.com`, `api.github.com`, or the API and login hosts of a provider in `gateway.llm_providers`. Address entries aren't checked against the gateway; preflight logs a warning that names them. The operator view and the worker form show the list. `infra/boxd/egress.mjs` prints the gateway's `egress-allowlist` as `provisioner.egress`, so both enforcement points use one list.
- b580789: `@usine/config` and `@usine/executor/ssh` no longer export the deprecated `BoatTailnet` alias. Use `ProvisionerTailnet`.
  
  A boxd `Exec` call takes its exit code from the last response only: one without data, or one with a non-zero exit code. A call whose last response is output fails as unreachable, even after an earlier empty response, and a last response that carries output and an exit code keeps both. Error messages stay readable when the boxd credential is empty. A dead `Exec` connection fails within 50 seconds by default.
  
  `infra/boxd/build-snapshot.mjs --no-isolated` builds a snapshot without isolation. A machine restored from an isolated snapshot is always isolated, so a worker's `isolated: false` takes effect only with such a snapshot.
  
  The worker page shows a boxd worker's region, snapshot, size, and isolation, with the default that applies when a setting is empty.
- 55c75fe: boxd workers run commands over boxd's gRPC `Exec` stream instead of SSH. A boxd worker needs only its API key: neither the boxd account nor the snapshot needs an SSH key, and a boxd worker that still sets `identity_file`, as earlier releases required, loads and ignores it, with a preflight warning that names the file. The executor runs boxd commands in its own process through a new `ExecShell` child host, with one HTTP/2 connection per worker that raises the receive windows, sends stdin in small chunks, and sends keepalive pings. A lost command is a typed `HostUnreachable` error instead of exit code 255. The executor reports an SSH client's exit code 255 as the same error, so a machine that SSH loses during a preflight or preparation check fails with a message that names the host and the SSH client's reason, and the executor no longer pins a proxy host key or refreshes a proxy port for boxd machines.
- 095438d: boxd `provisioner.region` accepts any lowercase region id, with `fra` as the default. The boxd driver finds the region's API endpoint with `ListRegions` on `boxd.sh`, so a worker can run on a boxd deployment in your own cloud account and region. Preflight fails with a `provider` capability error that names the listed region ids when boxd lists no region with the configured id. The worker form suggests `fra` and `nyc`.
  
  If boxd doesn't answer or rate-limits while the driver connects to the region, attempt launch waits and tries again instead of failing the Worker's check, and preflight names the hosts to reach: `app.boxd.sh`, `boxd.sh:9443`, and the region's API endpoint.
- 6aa5e72: boxd workers follow how boxd restores machines. `provisioner.size` is optional and takes any `<vcpu>x<GiB>` size, such as `1x32` on a self-hosted cluster, instead of the hosted sizes only. A restore keeps its snapshot's size, so the setting only asserts it: when it is set, preflight compares the snapshot's vCPU count and memory with it and names the snapshot's size on a mismatch. Without it, preflight accepts the snapshot's size. Preflight logs the snapshot's size in `boxd provisioner verified`. `BoxdSize` is a branded `<vcpu>x<GiB>` string, and the operator view reports a missing size as null. `infra/boxd/build-snapshot.mjs --size` takes the same pattern and puts it in the temporary machine's spec.
  
  Each boxd machine is created with SSH off, since usine runs every command through `Exec`. A boxd worker ignores `provisioner.reuse`: boxd restores a machine in under a second, so every attempt gets a new machine. A stored worker that sets it still loads, and preflight warns that it has no effect and names the worker. The executor's `BoxdProvisioner` has no reuse policy and reports the ignored setting as `ignoredReuse`, `MachineDriver.assign` is optional and absent from the boxd driver, and the boxd client no longer updates labels.
- 539349e: Add boxd as an SSH provisioner with snapshot size and region checks, machine reuse, and gateway tailnet support. Add worker configuration fields and a snapshot setup guide.
- e828b51: The new instance setting `settings.max_background_wait_minutes` limits how long a child that answers while its background tasks still run waits for that work to start a turn. The default is no limit: such a child waits for its background work and the turn it starts, however long they take. **Configuration > Settings** shows and edits the setting.
  
  Claude Code children apply the limit. When it passes and the child is still idle, the child returns its last answer as its report, and a warning names the limit and the background task IDs. Closing the child ends the Claude Code process, which stops its background tasks, and their results never reach the Attempt. The child's `SessionFinished` event sets `backgroundWaitLimitPassed`, and when the Attempt ends, even as a success, cleanup salvages its checkout as after a failure, so work that the child hasn't pushed is kept. Cleanup applies the limit that the Attempt started with. If that salvage doesn't push all the work, the checkout stays, and startup recovery salvages it again instead of removing it. A turn that starts within the limit runs to its own answer. If the operator holds or pauses the child when the limit passes, the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The limit runs in memory, so a child that was already waiting when usine restarted waits without one.
- d7e00bc: Configuration selects what coordinates an attempt. The `coordinator` setting in `usine.yaml` takes `session`, the default, where a Pi parent session coordinates the attempt, or `events`, where the event-driven coordinator applies rules to the attempt's lifecycle events with no parent session. An agent file's `coordinator` overrides the instance setting, and the scheduler resolves it when each attempt launches. Startup, reloads, and saved edits check the parent brain only of agents that resolve to `session`, so an instance whose agents all resolve to `events` starts without a Pi credential and quarantines no agent. Imports, reloads, and saved edits refuse `parent_model` or `parent_effort` in the same agent file or `settings` block as `coordinator: events`, with the field path in the problem. An agent file also accepts an optional `decision` with a `model` and an `effort` for its decision sessions, which run on the agent's own harness; no behavior reads it yet.
  
  `ParentKind` (`pi` or `none`) is now `CoordinatorKind` (`session` or `events`), and `RunSpec.parent` is now `RunSpec.coordinator`, which decodes as `session` for attempts stored without it. A fourth attempt journal migration rewrites a stored `RunSpec.parent` of `pi` or `none` as `session` or `events`. `Agent` adds the optional `coordinator` and `decision` (`DecisionBrain`), and `resolveCoordinator` returns the agent's kind, else the instance setting. `CheckoutRequest.coordinator` carries the resolved kind into the `RunSpec`. In the operator API, `SettingsView.coordinator`, `AgentFileView.coordinator`, and `AgentFileView.resolvedCoordinator` report the setting. The web configuration pages show the coordinator of the instance and of each agent and edit it in the settings and agent forms; an agent on `events` shows no parent model or effort.
- 5c1ff0a: An `exe.dev` worker is refused with a message that names it and says that this version of usine doesn't run the kind. The configuration store refuses a commit that leaves an `exe.dev` worker in the configuration, and `usine up` refuses a stored one when it starts running attempts. Setup mode, which runs no attempts, still starts. Before, an instance whose workers were all `exe.dev` was told that the worker differed from the other workers. `@usine/config/factory` exports `exeDevWorkerRefusal`, the shared message. `@usine/config/configuration` exports `replay`, which applies stored revisions without this refusal. Replaying stored revisions, for a revert or when the running server applies a new revision, still accepts `exe.dev` workers.
- 360d371: `outcome_labels` entries use the GitHub label name rules and messages: a trimmed name of at most 50 characters. A loop file whose outcome labels differ only in letter case is rejected, because GitHub compares labels without case. A schedule loop that sets `outcome_labels` fails schema validation, because its runs have no item to label. An outcome label that `usine.yaml` doesn't declare under `labels` adds an `UndeclaredOutcomeLabelWarning` to `LoadedInstance.warnings` and logs `Loop outcome label is not a declared GitHub label` when the instance folder loads and each time `CurrentInstance` installs a configuration. The loop still loads. `logConfigWarnings` in `@usine/config/instance` logs these warnings.
  
  The SQLite configuration store rewrites stored loops that earlier versions accepted and these rules reject, so the stored configuration keeps loading. When it opens, it removes a schedule loop's outcome labels and each label that repeats an earlier one in a different letter case, records the change as one revision without an actor, and logs each loop. If the upgraded configuration is still invalid, the store leaves the stored loops unchanged and logs a warning with the problems. **Configuration > History** shows a stored agent or loop value that the current rules reject as YAML of its stored fields, through `formatRevisionEntity` in `@usine/config/folder-codec`, instead of failing to load the revision.
  
  `GitHubLabelName` and `canonicalLabelName` are exported from `@usine/core/label`; import them from there instead of `@usine/config/label`. `OutcomeLabels` in `@usine/core/loop`, and the `outcomeLabels` field of `Submission` in `@usine/engine`, now contain `GitHubLabelName` values.
  
  The loop detail page in **Configuration > Loops** lists a loop's outcome labels and warns about undeclared ones. `LoopFileView` in the operator API adds `outcomeLabels` and `undeclaredOutcomeLabels`. The loop form writes `outcome_labels` only when the loop sets at least one label.
- 331a899: Workers accept `paused`. A paused worker takes no new attempts, and its running attempts finish; a run that reattaches an attempt already on the worker still takes a free slot there. The scheduler sends other runs to the next unpaused worker, so pausing the workers listed before a new worker sends attempts to it. Pausing or resuming applies on reload without a restart or a preflight. The worker page, the worker list, and the **Workers** line on **Overview** show a paused worker, and **Needs attention** lists it until it resumes. The worker form has a **Paused** option, and exports omit `paused: false`.
- 8fa25bb: Sign-in rate limits count each client address separately. Each sign-in operation allows 60 requests per minute from one client address and 600 per minute for the whole instance. The client address is the address of the connection. When that address is in the new `auth.trusted_proxies` setting, such as `[127.0.0.1/32, ::1/128]` for a reverse proxy on the same machine, the server reads the client address from `X-Forwarded-For`. Without the setting, the server ignores the header.
  
  On an instance behind a reverse proxy, the per-client limits take effect only after you list the proxy in `auth.trusted_proxies`. Until then, every client behind the proxy counts as the proxy's address and shares one allowance, so one client can still lock every member out of sign-in.
- c7bd772: SSH workers keep their disks from filling up with worker images. After each image pull, usine removes the other images of the attempt image's repository. It keeps the current image, the most recently built other image, and every image that a container uses. After a rollback, the retained image can be newer than the current image. Cleanup recognizes Docker Hub name aliases and tracks images replaced by mutable tags such as `latest`.
  
  Preflight and each new attempt, before its checkout starts, check the free disk space on the filesystem of the worker's `root` and on the container runtime's image storage. Below the threshold, the check fails with a `disk` capability error that states the free space and the threshold. **Needs attention** shows the error, and attempts wait until a preflight passes. The threshold defaults to 10 GiB; set `min_free_disk_gib` on the worker to change it, or to `0` to turn the check off. An attempt whose check fails before its checkout fails with an infrastructure failure, which usine retries.
  
  When one of usine's own commands on a worker, such as an image pull or a checkout, reports `ENOSPC` or `No space left on device` during preflight or preparation, usine reports the same `disk` error instead of the command's failure. A report from the attempt's agent keeps the outcome that the agent gave it.
- 4aebd77: The supervisor is a role of the harness contract. `@usine/agents/harness` exports `supervisor`, a role that runs on the orchestrator on a gateway credential route, lists only its usine tool set, keeps its conversation between turns, and takes interventions, and `admitSupervisor`, which requires `usine-tools`, `closed-tools`, `resume-session`, `steer`, `interrupt`, and `token-usage`. `@usine/agents/supervisor` exports `runSupervisorTurn`, which opens a supervisor session through `Harnesses` with a toolkit, or reopens the saved session for the conversation's next turn, and returns the answer, the saved session, and the session's cumulative usage across turns. A failed turn returns `SupervisorTurnError` with the usage that the session had spent. When a Claude Code process resumes a session, the first result's `modelUsage` minus its `model_usage_since_last_result` is the usage that Claude restored. usine counts that usage once and logs it at Info. This applies to a replacement process, to a process that the adapter resumes after its remote process stops, and to either one when the orchestrator reattaches it before its first result. `SessionTokensUpdated.processUsage` records `awaitsFirstResult` until then.
  
  `settings.supervisor: { harness, model, effort }` selects the supervisor's brain. Saving the configuration refuses a harness that can't serve the role and names what it lacks; Codex is refused, because it lists its own tools in every thread. An instance without the setting starts, and `SettingsView.supervisor` is null, which **Configuration > Settings** shows as not configured. The settings form edits the brain.
  
  The server builds the supervisor's operator toolkit from the operator tools that the MCP endpoint serves, filtered by the member's grants and operation ceiling, and answers each call through the operator API with the member's credential.

### Patch Changes

- eb58cad: Configuration checks, worker preflight, and coordinator startup admit brains through role declarations. A refusal names the missing capability, placement, or credential route with the harness's reason. For example, a Pi child placed on an SSH or container worker is refused with "Pi runs its tools in the orchestrator process and supports only local children".
- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [55c75fe]
- Updated dependencies [095438d]
- Updated dependencies [6aa5e72]
- Updated dependencies [539349e]
- Updated dependencies [7626bb7]
- Updated dependencies [b6fd6b2]
- Updated dependencies [4ff30ae]
- Updated dependencies [039daa4]
- Updated dependencies [322d45e]
- Updated dependencies [bfa02ef]
- Updated dependencies [c8ea557]
- Updated dependencies [589ad7b]
- Updated dependencies [71ecb9e]
- Updated dependencies [e828b51]
- Updated dependencies [322d45e]
- Updated dependencies [f889e77]
- Updated dependencies [3fef8e2]
- Updated dependencies [4eec609]
- Updated dependencies [d6fb554]
- Updated dependencies [d7e00bc]
- Updated dependencies [64afcbb]
- Updated dependencies [fd52df7]
- Updated dependencies [e8003db]
- Updated dependencies [fa97db3]
- Updated dependencies [c8241d7]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [2882f71]
- Updated dependencies [fa97db3]
- Updated dependencies [360d371]
- Updated dependencies [fa97db3]
- Updated dependencies [eb58cad]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [5ae7631]
- Updated dependencies [6a42cb3]
- Updated dependencies [1eddd3d]
- Updated dependencies [4aebd77]
- Updated dependencies [c5be05b]
- Updated dependencies [039daa4]
  - @usine/core@0.8.0
  - @usine/agents@0.8.0

## 0.6.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 25728fa: Allow a boolean CEL condition to require approval per run. Save and display the
  approval decision, require approval when evaluation fails, and validate conditions
  in the loop editor and configuration API.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- dba9075: Support gateway credentials over Tailscale on long-lived SSH workers. Set `tailnet.gateway_address` with a gateway; preflight configures gateway access through passwordless sudo, and attempts use direct internet egress.
- 4f87593: Add project roles and revisioned role bindings, enforce API permissions, and filter project data by access. Add token permission ceilings and controls for bindings and token scopes. Attribute local API writes and configuration CLI revisions to local admin. Existing members retain instance admin access through a one-time migration.
  
  Authorize run actions and cycle-budget resets against the repository’s current project, including after a repository moves. Refresh the configuration revision after writes and stale-revision failures so later writes use the current revision.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- a7bd195: Add an exact browser origin allowlist with credentialed CORS and security headers on all server responses. Configure additional origins in `auth.origins` and restart; loopback browser origins now require an explicit entry unless they are the canonical server origin. Document public HTTPS deployment with Caddy, Cloudflare Tunnel, and Tailscale Serve.
- 7c58461: Add opt-in machine reuse for Boat and Hetzner SSH workers with `provisioner.reuse: { attempts: 5, max_age: 2h }`. Reuse requires Docker, successful cleanup, gateway attachment revocation, and preflight before each assignment. Machines retire at the attempt or age limit and when their worker connection is removed.
  
  Show machine assignment counts and age on the overview and worker page, and persist daily machine-start counts for statistics.
- 0e34ec1: Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.

### Patch Changes

- 6a1cf79: Run SSH attempt containers with memory-backed `/dev/shm` and `/tmp` storage. Configure their capacities per worker with `container.shm_size_mib` and `container.tmpfs_size_mib`; each defaults to 2048 MiB and is capped at the container memory limit.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 12c3921: Check harness capabilities by role, credential route, and placement with one admission policy. Configuration and preflight refusals identify the missing requirement and adapter reason. Validate parent models, efforts, and credentials before accepting configuration imports, reloads, or saved edits. At startup, quarantine agents with refused parent brains and their loops in Needs attention while keeping the server available. Restore them after a corrected reload.
- 81330c9: Allow PR loop conditions and task templates to read `item.baseRefOid`. The field evaluates to `null` for older stored payloads that omit it.
- 03d2f48: Add role binding support to the configuration form codec. Edit role bindings in the web UI with a member picker, scope selector, and role selector. Open a binding from Members or add one with the member preselected. Keep the text editor and revision history available for each binding.
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
  - @usine/expression@0.6.0
  - @usine/agents@0.7.0

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- fdecd7e: Add schema validation for configuration form drafts and API endpoints for supported harnesses, efforts, installation repositories, and live repository labels.
- 88eac4f: Add operator API endpoints to read configuration revisions, edit and delete entities, and revert changes. Reject stale writes and report validation problems by entity and field. Check runtime compatibility before saving API changes, apply accepted revisions live, and start newly created loops paused.
- 9e14070: Add a configuration aggregate, atomic revision log, SQLite and in-memory stores, and strict folder import and export. Validate schema, CEL, and references before saving, and reject stale revisions. Expose an explicit CEL engine factory for deterministic validation without layers.
  
  Preserve worker preference order when importing configuration, including imports that also change worker values, and restore that order when replaying revisions.
- 1c1e516: Expose the latest label-addition actor and time for current issue and pull request labels through `item.labelEvents`. Loop conditions can use this history to select App-set labels for approval.
- 59d6496: Add loop forms with live CEL diagnostics, payload completion, registry selectors, and prompt previews. Preview stored matches before saving or resuming a loop. Expose read-only check and preview endpoints, and preserve expression positions in validation errors.
- 79174da: Order waiting runs with integer CEL priority expressions over item labels and other stream fields. Priorities default to zero and sort highest first, followed by lane rank and event arrival. Failed evaluations log a warning and use zero. Overview and wait and lease logs show the evaluated value; loop checks and previews validate and evaluate expressions.
  
  Scheduler layers now require `ExpressionEngine`.
  
  Queue positions now include priority and lane together. Loop preview items and Overview’s queued-run responses include the evaluated priority.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.
- 4f37e20: Add release version and upgrade outcome schemas, plus `upgrade_channel` and `upgrade_mode` settings. The defaults select the `latest` channel and propose available upgrades.

### Patch Changes

- 0536c26: Exclude unchanged configuration entities from import revisions when adding or removing a worker. Preserve worker preference changes and canonical values across configuration export and import.
- 40a70c2: Record configuration revision positions only for workers, relative to the worker list. Adding or removing an entity no longer adds unrelated entities to the revision or their `usine config log` history. Preserve worker order when importing and replaying revisions.
- 24dc884: Support project drafts in the configuration form codec, with validation of repository membership and lanes on save. Keep repository tag edits separate from project lanes.
- dfc713d: Document the public configuration API, including revision stores, project scope, file parsing, and worker settings.
- Updated dependencies [d1fd769]
- Updated dependencies [9e14070]
- Updated dependencies [6541e90]
- Updated dependencies [79174da]
- Updated dependencies [6d7f66f]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [460d50b]
- Updated dependencies [1c1e516]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0
  - @usine/expression@0.5.0

## 0.4.0

### Minor Changes

- b3e696a: Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).
  
  - `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a stop that ends every process that a command started, including what it left running after it exited, a keepalive alarm that also keeps a held sandbox running, an image init that records the platform's SIGTERM, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex, only on the provider routes that the harnesses call. Each sandbox applies its credential changes one at a time and refuses credentials older than the ones it holds, so a delayed renewal can't undo a revocation. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
  - `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
  - `@usine/executor/cloudflare` creates a sandbox per attempt, checks the attempt's harness version in it before it grants credentials, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps and holds it until it reconciles or destroys it, drains an attempt within the platform's 15 minutes after SIGTERM by salvaging its checkout and failing it retryably, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions. Each child reports the outbound handler's API key as its credential, so a Codex child runs without a ChatGPT login check, and Claude Code and Codex children count in the API keys pool.
  - `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
  
  Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)).
- ac701f0: A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.
  
  The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.
  
  `@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.
  
  `StepExecutor.reserve` takes the run ID as its first argument.
  
  `WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
- 7d338a2: `usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- 4942c44: Codex children on an SSH worker behind a gateway can use the gateway's OpenAI credential, a ChatGPT login or an API key, instead of a login on the worker. A worker's `gateway.llm_providers` accepts `openai` beside `anthropic` (`GatewayLlmProvider`).
  
  With `openai` listed, the executor writes Codex's `config.toml` with a `model_provider` for `llm.<domain>/openai/v1` to the attempt's Codex home, `<root>/workers/<name>/codex/<attempt>`, exports that directory as `CODEX_HOME`, and sends the caller token as `USINE_GATEWAY_TOKEN`, over SSH (which the worker's sshd must accept in `AcceptEnv`) or to the attempt's container. The container mounts the Codex home read-write, and cleanup removes it after the container; `RemoteAccess` adds `writablePaths` for it. Preflight reads the gateway's OpenAI credential kind, checks only the `codex` binary and its version, and logs each provider's mode (`gateway-api-key`, `gateway-subscription`, or `worker-login`) in `SSH Worker Gateway verified`.
  
  A Codex child with a gateway credential skips the login check and ignores login changes; `brainPool` puts it in `apiKeys` for an API key and in `chatgptPlan` otherwise. `@usine/agents/preflight` exports `unsupportedCodexVersion`.
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
- Updated dependencies [9c7ea97]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/core@0.5.0
  - @usine/expression@0.4.0

## 0.3.0

### Minor Changes

- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.

### Patch Changes

- a3a230c: Renames the decoded agent fields `parent_model` and `parent_effort` to `parentModel` and `parentEffort`; agent files don't change.
- efdcf43: A loop's `if:` accepts unquoted YAML `true` or `false`. Other non-string YAML values fail with a message to quote them.
- 9464a41: Repository names in `usine.yaml` and loop selectors, and board lane labels, match case-insensitively, as on GitHub. `usine.yaml` rejects repos or selector entries that differ only in case, and lane `label` sources that differ only in case count as one.
- 9739f3a: Loop expressions can use CEL optional values, such as `item.?milestone.?title.orValue("none")`, which is `"none"` on an issue without a milestone. `relatedStringLiterals` accepts the same syntax, so a loop that uses `.?` no longer makes the instance load without undeclared-label warnings.
- eedf20c: Behind a gateway, Codex, and Claude Code if the gateway has no Anthropic credential, use the operator's login on the worker machine and reach their provider through the gateway's forward proxy (ADR 0027, amendment of 2026-10-15).
  
  Preflight on an SSH worker behind a gateway accepts these brains if the machine reaches each login host through the forward proxy: `api.anthropic.com` and `platform.claude.com` for Claude Code, `chatgpt.com` and `auth.openai.com` for Codex. A refused host fails preflight with a `gateway` capability error that names the host to add to the egress allowlist, and `SshExecutorOptions.harnessReadiness` replaces only the login and binary checks.
- 32cf39b: Declares nullable GitHub payload fields, such as a team review request's `requestedReviewer.login`, as nullable in the CEL environment. On a null field, a comparison with a value is false, a comparison with `null` works either way, and `has()` below it is false; `ObjectField` takes a `nullable` flag, and prompts accept a `null` result.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- e5d9483: Rewords TSDoc for `Settings.maxAttemptMinutes`, `maxAttemptTokens`, and `parentModel`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 8665053: Depend on `yaml` 2.9.1 to parse `usine.yaml`, loop files, and agent files.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [9739f3a]
- Updated dependencies [af28e0e]
- Updated dependencies [499dd2c]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [32cf39b]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [8c6a3aa]
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
  - @usine/expression@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.

### Patch Changes

- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0
  - @usine/expression@0.2.0

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 95b26af: Loads, validates, and edits the instance folder with per-loop quarantine and checked CEL prompts, and adds a typed CEL service over plain JSON.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.

### Patch Changes

- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 57d383b: Adds GitHub App authentication, installation discovery, per-project installation coverage, local credential loading (mode 0600), and single-repository worker tokens.
- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
