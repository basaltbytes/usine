# @usine/durable

## 0.4.0

### Minor Changes

- 6b7ec62: `@usine/durable/coordinator/journal` adds `AttemptJournal`, the store of the event-driven coordinator, with a memory adapter in `/coordinator/memory` and a SQLite adapter in `/coordinator/sqlite`. The journal keeps each attempt's stored request, an event ledger with the first decision recorded for each event, the coordinator state, the delegations it decided, and an outbox of channel envelopes. A transition commits all of them in one transaction and fails with `StaleRevision` when its expected revision isn't current. The SQLite adapter runs on the application's `SqlClient` with its own `usine_attempt_journal_migrations` ledger. No attempt runs on the journal yet.
- e828b51: The new instance setting `settings.max_background_wait_minutes` limits how long a child that answers while its background tasks still run waits for that work to start a turn. The default is no limit: such a child waits for its background work and the turn it starts, however long they take. **Configuration > Settings** shows and edits the setting.
  
  Claude Code children apply the limit. When it passes and the child is still idle, the child returns its last answer as its report, and a warning names the limit and the background task IDs. Closing the child ends the Claude Code process, which stops its background tasks, and their results never reach the Attempt. The child's `SessionFinished` event sets `backgroundWaitLimitPassed`, and when the Attempt ends, even as a success, cleanup salvages its checkout as after a failure, so work that the child hasn't pushed is kept. Cleanup applies the limit that the Attempt started with. If that salvage doesn't push all the work, the checkout stays, and startup recovery salvages it again instead of removing it. A turn that starts within the limit runs to its own answer. If the operator holds or pauses the child when the limit passes, the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The limit runs in memory, so a child that was already waiting when usine restarted waits without one.
- d7e00bc: Configuration selects what coordinates an attempt. The `coordinator` setting in `usine.yaml` takes `session`, the default, where a Pi parent session coordinates the attempt, or `events`, where the event-driven coordinator applies rules to the attempt's lifecycle events with no parent session. An agent file's `coordinator` overrides the instance setting, and the scheduler resolves it when each attempt launches. Startup, reloads, and saved edits check the parent brain only of agents that resolve to `session`, so an instance whose agents all resolve to `events` starts without a Pi credential and quarantines no agent. Imports, reloads, and saved edits refuse `parent_model` or `parent_effort` in the same agent file or `settings` block as `coordinator: events`, with the field path in the problem. An agent file also accepts an optional `decision` with a `model` and an `effort` for its decision sessions, which run on the agent's own harness; no behavior reads it yet.
  
  `ParentKind` (`pi` or `none`) is now `CoordinatorKind` (`session` or `events`), and `RunSpec.parent` is now `RunSpec.coordinator`, which decodes as `session` for attempts stored without it. A fourth attempt journal migration rewrites a stored `RunSpec.parent` of `pi` or `none` as `session` or `events`. `Agent` adds the optional `coordinator` and `decision` (`DecisionBrain`), and `resolveCoordinator` returns the agent's kind, else the instance setting. `CheckoutRequest.coordinator` carries the resolved kind into the `RunSpec`. In the operator API, `SettingsView.coordinator`, `AgentFileView.coordinator`, and `AgentFileView.resolvedCoordinator` report the setting. The web configuration pages show the coordinator of the instance and of each agent and edit it in the settings and agent forms; an agent on `events` shows no parent model or effort.
- 64afcbb: The event-driven coordinator applies operator input instead of refusing it. Input for a child goes to that child. Input addressed to the parent, including the runaway guard's warning steer, goes to the attempt's live child, and its receipts name the child in `forwardedTo`. Input addressed to the parent waits while the next child starts, as after a reattachment, so the runaway guard's restored warning reaches the resumed child. With no live or starting child, the input is rejected with `InterventionRejected`. An operator message holds the child's report until a release, an interrupt pauses the child, and a working child's queued message gets a second receipt when the child reads it, or a rejection once the child ends without reading it, including when a cancel stops the child. The attempt journal keeps each child's Hold, pause, and queued input, so a child resumed after an orchestrator restart restores them. The coordinator stores what an input implies before the child applies it, so an input that the child applied survives a stop. `AttemptJournal` adds `supervise`, `queueInput`, `forgetInput`, which reserves the input's receipts in the same transaction, and `recordInbound`, and `CoordinatorSnapshot` adds `supervision`, `inputs`, and `nextInbound`; a third migration adds their tables and column.
  
  `SessionResult.answeredOperator` is true when a session read an operator message or steer after its last tool call. The shared conversation sets it for Claude Code, Codex, and Pi, and the coordinator passes it to `AttemptReport.answeredOperator`, so an attempt whose child answered the operator and produced no commit, pull request, comment, or step output fails with `AgentFailure`, as it does for a Pi parent. `SessionIdle.answeredOperator` and `ChildRequest.idleAnsweredOperator` keep that answer across an orchestrator restart under a Hold. Claude Code's task prompt and continuation input carry a client UUID, so each result names every message that its turn consumed, and a steer that the result leaves out stays unread. A steer that a result names, or that an older Claude Code counts as read, without the turn's first reply naming it, counts as read at the first tool result after it was queued, where Claude folds it in, or at the turn's end if no tool call finished since. A steer that a result leaves queued, or a message sent while no turn runs, such as to an idle child under a Hold, starts a turn of its own, and counts as read when that turn starts, unless the turn's first reply leaves it out.
- 6e55876: The event-driven coordinator ends an attempt with `InfraFailure` when a stored state, decision, or delegation outcome no longer decodes, and logs the attempt ID and the record, instead of stopping on a defect. A child whose launch hadn't returned when the orchestrator stopped resumes its saved conversation if available. If no conversation was saved or the harness reports it unavailable, the child launches fresh in its slot without a `SessionFinished` or `ChildInterrupted` for the unfinished launch, or a spent budget slot. An unreadable saved conversation or a changed worker, machine, checkout, harness, or harness home ends the child as interrupted and uses a budget slot. Kept Worker notices stay kept until the transition that reserves `Started` commits.
  
  The SQLite attempt journal reserves and acknowledges envelopes with targeted statements, without loading the attempt's snapshot. The coordinator drops an attempt's in-process state once the attempt completes, fails, or is canceled, and the sink received its last envelope.
  
  `@usine/durable/coordinator/journal` adds the `Launched` progress change and the `ChildProgress.launched` field, which reads as `true` for progress stored before it. The coordinator no longer has a budget event, because each transition numbers its child within the child-session budget.
- fd52df7: The event-driven coordinator decides a child's report without a reserved marker or a CI handoff with a structured completion when the agent sets `decision`. A report that starts with `[usine:awaiting-ci]` keeps its rule, so the attempt completes with the handoff unchanged. The completion runs once on the agent's harness with the `decision` model and effort, on the attempt's worker and the child's credential route, with no usine tools and no saved conversation (a harness that can't turn its own tools off runs them read-only), and returns one decision: complete, replace the child, or fail the attempt. Its usage counts as a separate session of the attempt, including the usage of a failed completion. A refusal, an invalid answer, a usage limit, a timeout, or a replacement past the child-session budget completes the attempt with the report, as without `decision`, and logs the reason at Warning. An agent without `decision` and every other event keep their rule.
  
  `@usine/agents` adds `workerAdmissionContext` to `/harness`, which returns the placement and credential route of a session of any role on a worker, and the platform-free `/harness/registry` subpath for `Harnesses`.
  
  `@usine/core/ci` adds `handsOffCi`, which tells whether a final answer starts with `[usine:awaiting-ci]`. `ciHandoff` and the coordinator both use it.
- e8003db: Attempts can run without a Pi parent session. `RunSpec.parent` selects the coordinator: `pi`, the default and the value that stored attempts decode as, or `none`, which runs the attempt on the event-driven coordinator. `RunSpec.outcomeLabels` gives that coordinator the labels the engine verifies after a success: `RunSnapshot`, `StepExecution`, and `CheckoutRequest` carry the outcome labels saved with the Run's Event, and preparation copies them into the `RunSpec`. Configuration doesn't set `parent: none` yet, so every configured attempt still runs its Pi parent.
  
  The event-driven coordinator starts one child with the rendered task and turns the child's end into the attempt's outcome: a report completes it, a reserved marker fails it with its typed failure, a provider capacity refusal fails it with `ProviderCapacityFailure` and the time the usage limit resets, and a launch or transport failure fails it with `InfraFailure`. Each lifecycle event goes through the `WakeUp` seam, and `WakeUp.rules` applies the event's rule, so the coordinator needs no model credential. Its state lives in the attempt journal in the runtime database: an orchestrator restart resumes the open child, applies a decision recorded before its transition, reads a child's recorded outcome instead of starting another child, and replaces a child that couldn't resume once within the child-session budget. Its outbox sends envelopes that the transcript didn't acknowledge again. A cancel settles an attempt without an outcome before its child stops, so a restart doesn't resume it. It refuses operator input for now.
  
  `@usine/durable/live` routes each attempt to the runtime that started it and requires the runtime database's `SqlClient` for the attempt journal; the orchestrator's `runtimeLayer` and the exe.dev engine layer take the shared database layer. `AttemptJournal` adds `startDelegation`, `saveProgress`, `settleDelegation`, `settleOpen`, `recordResult`, and `recordUnsupervised`, and a second migration adds their columns. `@usine/durable/testing` exports `routedRuntimeLayer`, and its `layer` runs attempts through the router.
- a38a607: The coordinator brain check of a configuration save, reload, or start checks the credential's login once per provider, however many agents, parent models, and efforts use that provider, and still names each refused agent. When Pi selects the parent model, it lists the available models once per check, not once per agent. The 10-second limit covers the whole check, and for `usine config` commands it also covers loading the parent models, so a slow load refuses the write with `ValidationTimeoutError` and stores no revision. `@usine/durable/parent` adds `sharedParentAnswers` and an optional `answers` argument to `resolveParent`.
- 324bfed: An attempt's channel no longer needs a Pi parent session to start. `Started.parentModel` is an `Option`: it names the selected Pi parent model, or is `None` for an attempt without a parent session, and a stored `Started` envelope without the key decodes as `None`. The durable relay sends `Started` once the attempt's task records `started` on its durable record, then the Worker notices kept before the start, then session events. A Pi-parent attempt sends the same envelopes in the same order as before. A `Started` without a model clears the attempt's recorded parent model, and the run page's attempt details show **No parent session**. In the operator API, the `parentModel` of a `Started` payload is `null` for an attempt without a parent session.
- 1eddd3d: Wait for a Claude usage limit to reset instead of ending the run as blocked. A Claude Code turn that ends on a usage limit (`rate_limit` or HTTP 429) or another capacity refusal now fails the session with `AgentCapacityError` instead of returning the error text as its answer. The attempt fails with `ProviderCapacityFailure`, whose retry starts no earlier than the reset time from Claude's last rejected rate-limit report. A child's capacity report replaces the Pi parent's own blocker, question, or failure report.
  
  `ProviderCapacityFailure` and `AgentCapacityError` have an optional `resetsAt` field, and `pendingProviderRetry` waits for it. The durable testing stub has a `limit` method that ends a child with a usage limit.

### Patch Changes

- 7626bb7: Child recovery avoids resending a saved task or operator messages already reported as read. A held, paused, or idle child whose saved conversation holds no task receives the original task, replacing any saved idle report. A missing Claude Code prompt acknowledgment can cause a completed task to repeat. A paused Codex child interrupts its task turn until operator guidance arrives. A remote Claude Code child that loses its process before its owner acknowledges the task receives the task again, not the continuation instruction. Codex recovery reports unread guidance that the saved thread's last turn records as read instead of resending it, and previously observed user-message items don't count again after an orchestrator restart. For older delegations without receipt history, recovery of a finished turn keeps guidance queued and records the existing items before matching on later recoveries. On an active reattach, replayed notifications can acknowledge unread guidance, and the next live receipt saves the turn’s existing user-message IDs together. Concurrent guidance never starts a second Codex turn. A Pi recovery steer that Pi handles at once is reported as read. A failed native reopen keeps its error as the cause of the `SessionInterruptedError`. When a restored `subagent` call fails before it restores its child's operator messages, the parent's delivery pass settles them as soon as the call returns.
- f889e77: Retry Codex and Pi usage limits after they reset, as Claude Code usage limits already are. A Codex turn that fails with `usageLimitExceeded` or `rateLimitExceeded`, or with HTTP 429 after Codex's own retries, now fails the session with `AgentCapacityError`, whose `resetsAt` is the latest reset time among the used-up windows of Codex's last rate-limit snapshot. A Codex billing quota, a plan without Codex, or a workspace that is out of credits or at its spend cap still fails the attempt for the operator. A Pi turn that ends on a ChatGPT plan limit, a shared ChatGPT subscription limit, or an HTTP 429 rate limit also fails with `AgentCapacityError`; a plan limit that states its wait resets after that wait. The Pi parent classifies the error that ends its turn the same way, and `@usine/agents/pi/refusal` exports that classifier as `piFailure`. The attempt fails with `ProviderCapacityFailure`, so the run retries after the reset, or after the default capacity delay when the harness reports no reset time, without the operator.
- 8e2003f: When a process stop interrupts an event-driven coordinator's `execute` call, the call now detaches before its child stops, and the child's harness leaves its session to resume after the restart, as it does for a Pi parent's children. A Claude Code child's turn is interrupted first; a Codex child is detached without a turn interrupt. The stop waits up to 10 seconds for the child. When a cancel or a failed sink ends the call, the child still stops without a resume. Previously the coordinator closed a Claude Code child without interrupting its turn and ended a Codex child's app server.
- ae523e4: The event-driven coordinator gives its `WakeUp` handler the attempt ID, the event's journal sequence, the stored `RunSpec`, and an effect that returns the attached `AttemptRequest`, so a model handler can open a session on the attempt's worker with the agent's brain. A recorded decision names its handler `rule`, `completion`, or `session`, and a model's decision also records the brain, credential route, billing pool, and usage of its model call. A cancel interrupts a running handler. A model can no longer answer an interrupted child: the interruption's rule always applies, so an interrupted child that left no report can't complete the attempt.
- eb58cad: Configuration checks, worker preflight, and coordinator startup admit brains through role declarations. A refusal names the missing capability, placement, or credential route with the harness's reason. For example, a Pi child placed on an SSH or container worker is refused with "Pi runs its tools in the orchestrator process and supports only local children".
- c5be05b: The orchestrator can run supervisor turns in a read-only container on its host, with the instance's source to read, on Claude Code, Codex, and Pi. No interface opens a supervisor conversation yet.
  
  `RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host, and its grep runs as a Node.js script there, with Pi's glob, pattern, and output limits.
  
  `@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. The relay and the route drop every header in `CALLER_CREDENTIAL_HEADERS`, which `@usine/gateway/admin` now exports. The sandbox writes the harness's settings without following a symbolic link, and runs one turn of a conversation at a time. A container whose orchestrator stops ends itself, and the next start removes any that remain. `makeSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount, and holds each tree until the turn ends. It removes a tree once the tree is no longer the head and no turn holds it.
  
  `@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.
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

## 0.3.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 8c079aa: Route coordinator model requests through the instance's first configured gateway with a caller token. The orchestrator host needs no provider login when a gateway is configured. Check coordinator gateway credentials at startup and keep usage in the API-key or ChatGPT plan pool. Expose the gateway model route for orchestrator-hosted runtimes.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- 12c3921: Check harness capabilities by role, credential route, and placement with one admission policy. Configuration and preflight refusals identify the missing requirement and adapter reason. Validate parent models, efforts, and credentials before accepting configuration imports, reloads, or saved edits. At startup, quarantine agents with refused parent brains and their loops in Needs attention while keeping the server available. Restore them after a corrected reload.
- 1c981c9: Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.
  
  Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.

### Patch Changes

- 92f21ce: Keep remote Codex app-servers running through SSH drops and reattach to their pending turns. Resume the saved thread once if the app-server exits, preserving operator pauses and idle sessions. Record child transport failures as infrastructure failures even after earlier child reports or parent blockers, so attempts retry automatically from recorded salvage.
  
  Preserve the original task when an app-server exits before saving its first user message. Recovery continues saved work when the task is already recorded.
  
  Replay unread operator guidance when recovering a Codex thread. Report delivery after the recovered turn accepts the messages, and preserve unread guidance while the child waits for the operator to resume it.
  
  Replay incomplete output frames after an SSH disconnect, preserving the last complete output offset.
  
  Discard incomplete input frames before journaling them so reconnecting preserves the running app-server. Acknowledge guidance included in resumed input when Codex reads it, preventing replay after another pause.
  
  Preserve the recorded process-loss error when the app-server exits before the first turn request starts, so recovery resumes the saved thread.
- 10154eb: Clear child holds and pauses when saved-session recovery returns an interrupted call so the attempt's wall-clock limit resumes. Continue forwarding transcript events and token reports after a failed progress checkpoint, and return the child's final report.
- 5d1254b: Send the coordinator's tool declarations, including `subagent`, on ChatGPT plan models routed through a gateway. The gateway request no longer drops them when it moves the system prompt into `instructions`.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 548e6b7: Register harness preflight and launch through `Harnesses` on `@usine/agents/harness/node`. Registration rejects incomplete descriptor/runtime pairs and duplicate IDs. Gateway, injected-key, and Cloudflare preflight use the registered runtime with their credential route. Refusal messages name the harness and its installation location, mention a login only for host-login probes, and retain sandbox-image guidance for Cloudflare. Successful binary probes log the installed version.
  
  Replace the three harness-specific backend tags with `ChildBackend`, and rename the single-harness layers to `claudeChildLayer`, `codexChildLayer`, and `piChildLayer`. Replace `ClaudeLoginLock` and `claudeLoginLockLayer` with `HostLoginLock` and `hostLoginLockLayer`; `withLock` takes the harness ID before the worker and machine. Share one lock layer between the executor and attempt runtime.
  
  `preflight` accepts a `ProbeTarget` and requires the injected `Harnesses` service. Build the registry once with the process spawner and shared `HostLoginLock`, then provide it to the executors and durable attempt runtime. Registration errors remain typed until the server reports a startup failure. It returns capability gaps as readiness reports and fails on transport errors or timeouts. Custom `HarnessProbe` wrappers forward the worker and machine context in their second argument.
- 9786f67: An attempt whose CI pull request can't be verified now fails with the reason in its message. A handed-off head that differs from the checkout, a pull request that origin doesn't have or that comes from another repository, and a branch that isn't at the pushed head are agent failures. A GitHub read that still fails is a retryable infrastructure failure.
  
  The pull request read during harvesting retries twice, on the same schedule as the GitHub polling reads, and logs the branch's commit on origin against the pull request's head on GitHub.
  
  A loop with a CI policy whose agent ends without a handoff now verifies the open pull request of the checkout's branch on origin and uses branches on origin at HEAD for detached checkouts. When only pull request refs match, it uses GitHub's commit-to-pull-request index. An unchanged detached checkout from a branch or tag revision fails as an agent failure instead of waiting on an unrelated pull request.
  
  For a detached fixed-commit checkout, indexed pull requests from a fork now fail with `RepositoryMismatch`. When an origin branch matches the detached HEAD but has no open pull request, verification fails with `PullRequestNotFound` even if a matching pull request ref is also on origin. The commit index is queried only when no origin branch matches.
  
  A plain success whose GitHub or git verification read fails now records an `InfraFailure` instead of an `AgentFailure`. This includes persistent authorization failures such as HTTP 403, so the attempt can run up to three times. A local branch pushed under a different remote name fails with `BranchNotAtHead`; an explicit handoff verifies the pull request's source branch independently of the local branch name.
- 35f68ef: Stop child connection recovery when an attempt detaches during orchestrator shutdown. Codex preserves its remote supervisor and journals for reattachment, and Codex, Claude Code, and Pi suppress shutdown infrastructure failures.
- d740598: Forward parent steers to the single live child and record the receiving child in delivery receipts. Require a separate parent turn when a steer cannot be delivered, including after a restart. Withdraw unread guidance on interruption and keep the parent paused until new guidance or release. Show forwarding, parent delivery, and unread steers in the run transcript.
- 9476883: Pass the rendered loop task unchanged to each child, with parent-written text as supplemental context. Record the exact child prompt in the transcript and display it in the run page's attempt details.
- 10154eb: Keep held children that finished their turn idle after an orchestrator restart. Release returns the saved report to the parent; operator guidance starts another turn. Include the completed report in SessionIdle events for recovery.
- 10154eb: Resume saved child conversations after an orchestrator restart in the original checkout and attempt transcript. Recovery preserves operator holds and pauses, child IDs, and budget slots and returns committed output as an interrupted result when resume is unavailable or fails.
  
  A resumed child's final report replaces its pre-restart infrastructure failure while preserving blockers from other children.
  
  Failed recovery allows a replacement child to supersede the previous infrastructure failure. Resumed children use the worker's current credential kind; incompatible saved conversations return an interrupted result with the committed output.
  
  Commit child usage with the saved conversation and restore it before launch.
- 4d5036a: Use the replacement child's report after an orchestrator restart instead of failing the attempt with the previous child's stored infrastructure failure. Preserve the previous failure in the transcript.
- 1948b10: Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
- 9cf0b5e: Share child continuation policy across Claude Code, Codex, Pi, and durable restart. Native resume reopens a conversation without sending input. Working children receive one continuation and unread guidance; supervised children wait. Persist a limit of three continuation turns per ten minutes and close interrupted tool calls with errors.
  
  Assign Claude session UUIDs before the first prompt and give operator messages stable UUIDs. Acknowledge guidance by native message IDs so identical messages have separate delivery receipts, and use Claude's pending-send count only for results without UUID receipts. Send the task to a retained Claude process that never acknowledged its prompt. A restored child keeps its unread messages until its call ends. Preserve unread Codex guidance across turn boundaries and active-turn reattachment. Failed resume returns interrupted without spending another child-session slot, and a replacement clears the previous child's infrastructure failure.
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

## 0.2.1

### Patch Changes

- 3fa96e0: Persist outbound envelopes before delivery so a restart preserves child events and intervention results with their original sequences and timestamps. Replay pending batches before new output, and keep terminal envelopes recoverable until delivery completes.
- 93bbe77: Upgrade the Pi packages to 1.4.0 and define the checkpoint policies required by pi-durable. Attempt and hold documents retain their existing delta-storage behavior. Disable the task restart limit to preserve automatic resumption after repeated crashes.
  
  Back up the instance with `usine backup <path>` before upgrading. Starting the upgraded server migrates `durable.sqlite` to SQLite storage schema version 2, which pi-durable 1.3.0 and earlier cannot open. Do not downgrade usine past this release: `usine upgrade <older version>` cannot reverse the storage migration.
- 9af38cb: Install Pi's HTTP dispatcher before opening the first parent harness. Server requests use proxy-aware HTTP/1.1 connections with five-minute stream timeouts, and interrupted response streams reject without an unhandled dispatcher error terminating the process.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 56e79a7: Settle attempts after confirmed cancellation so a task that completes or fails while its relay fails doesn't trigger repeated cancellation on restart. Preserve terminal delivery state and skip settlement during worker drains.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- Updated dependencies [d1fd769]
- Updated dependencies [a7692ae]
- Updated dependencies [6541e90]
- Updated dependencies [6d7f66f]
- Updated dependencies [93bbe77]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [06a10bf]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [98eb9cd]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0
  - @usine/agents@0.6.0

## 0.2.0

### Minor Changes

- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)).
- 266986a: The nine `@earendil-works/*` packages are at 1.2.0. pi-durable 1.2 closes the harness on any storage error, a read included, so `DurableHarness` now handles a failed harness instead of a poisoned session or a stuck step:
  
  - An attempt that is running when a storage error fails the harness fails with a retryable `InfraFailure` whose cause is the new `DurableStorageFailed`, and the engine retries it from salvage. The harness reopens the storage, aborts those attempts' tasks, and resumes the other tasks.
  - A storage error before the harness resumes its tasks fails the layer with a `DurableHarnessError` that names the error, and `usine up` doesn't start.
  - If the reopen fails, or the reopened harness fails within a minute, the harness stops until the orchestrator restarts.
  
  `HarnessListener` replaces `onReopen` and `onStop` with `onFailure`, `BeforeResume` also receives the storage, and `StuckStepReports` is removed. The `subagent` tool returns the child's report as `output`, the field that pi-durable 1.2 reads instead of `content`.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 1514af9: On a provisioned worker, the Claude login lock covers one machine instead of the whole worker ([#591](https://github.com/basaltbytes/usine/issues/591)). Each machine has its own login, so a Claude child or preflight check on one machine no longer waits for a Claude start on another. A worker's long-lived machine keeps one lock for all its attempts.
  
  `ClaudeLoginLock.withLock(worker, machine)` takes the provider's `MachineId` of a provisioned machine, or `None` for the worker's shared login. `ChildRequest` and `AttemptRequest` require `machine`, which the executor sets from the attempt's machine. `AttemptRequest.machine` isn't stored; each `execute` call supplies it.
- 9077f43: Fixes a forced stop that never exited after it released a running attempt ([#573](https://github.com/basaltbytes/usine/issues/573)). The attempt's Pi parent kept running until the durable harness closed. If it called `subagent` in that time, the call waited for an `execute` call to supply the child host, and no `execute` call follows in a stopping process. The harness close waits for every running call, so it never finished. An aborted `subagent` call now stops waiting and logs `Abandoning the child spawn of an aborted tool call`. The next start resumes the attempt, and the call ends as interrupted.
- afbac5c: A salvage git command that doesn't finish within the 10-minute command timeout no longer crashes the release of a failed attempt's checkout. Before, the salvage read the message of the timeout's cause, which has none, and threw "Cannot read properties of undefined (reading 'trim')". The run then failed with "Step executor defect; operator intervention required" instead of the attempt's own failure, and the checkout and its provisioned machine stayed on the worker without a recorded salvage (#602). Now the run fails with the attempt's own failure, and the salvage records `Retained` with the worktree's path, so the checkout stays on the worker as it does after any other failed git command.
  
  A worker command that exceeds the timeout now fails with the message `<command> didn't finish within 10 minutes`, instead of `Can't run <command>`, which also named a command that couldn't start.
  
  `@usine/durable/testing` adds `StubChild.crash`, which ends a stub child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails with a `stream` `SessionOperationError`.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [2f78d3a]
- Updated dependencies [1514af9]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [113d150]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [d82c6cd]
- Updated dependencies [266986a]
- Updated dependencies [4c63872]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/agents@0.5.0
  - @usine/core@0.5.0

## 0.1.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 794a1cf: `usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, to `<name>.durable<ext>` next to the runtime database copy. Restore both files together; an attempt that was running at backup time then reattaches to its parent task.
  
  `@usine/durable/backup` exports `backup` and `DurableStorageBackupError`, and `@usine/durable/live` no longer exports `durableStoragePath`.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- 8292038: Adds `AttemptRuntime`, which runs an attempt's Pi parent in the orchestrator as a durable task on pi-durable storage, relays its activity as attempt channel envelopes, applies operator input, and cancels bottom-up. `/live` provides the Node runtime with Claude, Codex, and Pi child backends, and `/testing` runs whole attempts with a scripted parent model and stub children.
- 0799f4f: `AttemptRequest` contains the attempt's child host, which the `subagent` tool passes to every child, so the worker decides where children run. `@usine/durable/testing` adds `stubAttemptRuntime`, `StubStorage`, `StubParent`, `completes`, and `worksFor`, an in-memory `AttemptRuntime` for executor and engine tests.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- b601259: After an orchestrator restart, a reattached attempt's runaway guard resumes from its recorded totals instead of starting over, and sends each 80% warning at most once per attempt. If the guard can't read the transcript or unsupervised time, it cancels the parent task, records the salvage, and fails the attempt with an `InfraFailure`.
  
  Adds `AttemptChannel.Sink.transcript` to `@usine/core`, which the engine reads from the run tables, and `AttemptRuntime.recordUnsupervised`, `AttemptRuntime.unsupervised`, `AttemptRuntime.attached`, and `StubStorage.unsupervised` to `@usine/durable`. A wall-clock guard records its unsupervised time every 30 seconds, so a crash loses at most 30 seconds, and the wall clock starts once the launch registers the attempt's session.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- 761099a: Adds `StuckStepReports` to `@usine/durable/harness`: how many identical reports without a commit mark a step as stuck (default 1,000).
- 10ab5af: A durable conversation document that no longer reads back fails only its attempt, with an `InfraFailure` that states the reason, instead of stopping the harness. `DurableHarness.resume` takes a `BeforeResume` step that runs on every opened harness before its tasks resume, including after a reopen.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- 6672585: `AttemptRuntime.isLive` returns false for an attempt whose task was canceled, even if its relay failed before the terminal envelope, so orchestrator startup no longer cancels that task again. A task that finished without an attached relay stays live until `execute` relays its terminal envelope.
- 7a6d96f: Adds TSDoc to every field of the public schema classes and interfaces of `@usine/durable`, and to `DurableHarness.models` and `DurableHarness.defaultModel`.
- 14c2d3c: `DurableHarness` logs the first report of each pi-durable failure, then the repeat count at most every five seconds. After 1,000 reports of one failure with no commit, the harness reopens the storage; if it gets stuck again within a minute, it stops and running attempts fail with an `InfraFailure`. `HarnessListener` adds `onStop`.
- d3942c0: Fixes `AttemptRuntime.notify` dropping a worker notice sent before the attempt's relay or parent starts; it records the notice after `Started`.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- e518906: Pins `@earendil-works/pi-codemode` to 1.1.0, next to `@earendil-works/pi-coding-agent` 1.1.0. Fixes a `SyntaxError` in `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` when a plain install resolved pi-codemode 1.3.0, which doesn't export `MCP_TYPESCRIPT_PREAMBLE`.
- 7078fa8: Pins the `@earendil-works` packages `pi-agent-core`, `pi-mcp`, `pi-telemetry`, and `pi-tui` to 1.1.0, matching `pi-coding-agent`, so a plain install loads one copy each of `pi-ai` and `chord`.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- a999ca0: A released parent's reply to the release guidance doesn't count as answering the operator, so `AttemptReport.answeredOperator` stays false.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [425e240]
- Updated dependencies [8292038]
- Updated dependencies [acef6eb]
- Updated dependencies [a3a230c]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [caf041d]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5519ca3]
- Updated dependencies [9b78093]
- Updated dependencies [458033e]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [5870baf]
- Updated dependencies [71c8b48]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [07a4145]
- Updated dependencies [ebfb373]
- Updated dependencies [0799f4f]
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
  - @usine/agents@0.4.0
