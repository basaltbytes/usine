# @usine/orchestrator

## 0.7.0

### Minor Changes

- f8f311c: boxd workers connect to any boxd cluster. `provisioner.endpoint` sets the cluster's account endpoint, such as `https://boxd.example.com:9443`, and defaults to the hosted service at `https://boxd.sh:9443`. The driver sends account calls and `ListRegions` there, and derives the token exchange URL from it as the boxd SDK does: `https://app.<host>/api/v1/auth/token`, without the port, or the endpoint itself for a `localhost`, IP address, or `app.` host.
  
  `provisioner.region` is optional and no longer defaults to `fra`. Without it, every call goes to the endpoint, and machines start where the endpoint runs them: Frankfurt on the hosted service, or the only location of a self-hosted cluster. A region that the endpoint serves itself needs no API endpoint in the region listing. Preflight compares the snapshot's region with the region that boxd serves, and fails with advice to remove `provisioner.region` when a cluster that runs in one place lists no regions.
  
  Over TLS or to a loopback address, the driver sends the API key as the bearer. It falls back to the token exchange when boxd refuses the key as a bearer, and keeps renewing the session and retrying a call once on `UNAUTHENTICATED`. `Exec` calls carry the session too once boxd refuses the key, so a cluster behind a load balancer that terminates TLS runs commands. `provisioner.endpoint` accepts `http://` only for `localhost`, `127.0.0.0/8`, or `[::1]`, and a port only from 1 to 65535. The driver refuses to connect to a region that boxd lists at an `http://` API endpoint on another host. When boxd doesn't answer or rate-limits, the error names the URL that usine called. The operator view and the worker form show the endpoint, and the view reports a missing region as null.
- 2b3ac6b: boxd workers accept `provisioner.egress`, the complete egress allowlist of each machine: host names, `*.` wildcards, public IPv4 addresses or CIDR ranges of at most `/8`, or `none`. Like boxd, the configuration refuses an address with host bits set or one in a private, CGNAT, loopback, link-local, multicast, or reserved range. The driver sends it in the machine spec of the restore request, so each machine is created with it, and waits one second before it connects to the machine: processes that the snapshot resumes can reach hosts outside the list for up to about a second. If boxd reports the new machine unrestricted, the driver deletes the machine and retries creation. A reused machine gets the list again. Without `egress`, machines keep unrestricted egress.
  
  Behind a gateway, the configuration is refused when the list omits `*.tailscale.com`, or admits `github.com`, `api.github.com`, or the API and login hosts of a provider in `gateway.llm_providers`. Address entries aren't checked against the gateway; preflight logs a warning that names them. The operator view and the worker form show the list. `infra/boxd/egress.mjs` prints the gateway's `egress-allowlist` as `provisioner.egress`, so both enforcement points use one list.
- 095438d: boxd `provisioner.region` accepts any lowercase region id, with `fra` as the default. The boxd driver finds the region's API endpoint with `ListRegions` on `boxd.sh`, so a worker can run on a boxd deployment in your own cloud account and region. Preflight fails with a `provider` capability error that names the listed region ids when boxd lists no region with the configured id. The worker form suggests `fra` and `nyc`.
  
  If boxd doesn't answer or rate-limits while the driver connects to the region, attempt launch waits and tries again instead of failing the Worker's check, and preflight names the hosts to reach: `app.boxd.sh`, `boxd.sh:9443`, and the region's API endpoint.
- 6aa5e72: boxd workers follow how boxd restores machines. `provisioner.size` is optional and takes any `<vcpu>x<GiB>` size, such as `1x32` on a self-hosted cluster, instead of the hosted sizes only. A restore keeps its snapshot's size, so the setting only asserts it: when it is set, preflight compares the snapshot's vCPU count and memory with it and names the snapshot's size on a mismatch. Without it, preflight accepts the snapshot's size. Preflight logs the snapshot's size in `boxd provisioner verified`. `BoxdSize` is a branded `<vcpu>x<GiB>` string, and the operator view reports a missing size as null. `infra/boxd/build-snapshot.mjs --size` takes the same pattern and puts it in the temporary machine's spec.
  
  Each boxd machine is created with SSH off, since usine runs every command through `Exec`. A boxd worker ignores `provisioner.reuse`: boxd restores a machine in under a second, so every attempt gets a new machine. A stored worker that sets it still loads, and preflight warns that it has no effect and names the worker. The executor's `BoxdProvisioner` has no reuse policy and reports the ignored setting as `ignoredReuse`, `MachineDriver.assign` is optional and absent from the boxd driver, and the boxd client no longer updates labels.
- 539349e: Add boxd as an SSH provisioner with snapshot size and region checks, machine reuse, and gateway tailnet support. Add worker configuration fields and a snapshot setup guide.
- e828b51: The new instance setting `settings.max_background_wait_minutes` limits how long a child that answers while its background tasks still run waits for that work to start a turn. The default is no limit: such a child waits for its background work and the turn it starts, however long they take. **Configuration > Settings** shows and edits the setting.
  
  Claude Code children apply the limit. When it passes and the child is still idle, the child returns its last answer as its report, and a warning names the limit and the background task IDs. Closing the child ends the Claude Code process, which stops its background tasks, and their results never reach the Attempt. The child's `SessionFinished` event sets `backgroundWaitLimitPassed`, and when the Attempt ends, even as a success, cleanup salvages its checkout as after a failure, so work that the child hasn't pushed is kept. Cleanup applies the limit that the Attempt started with. If that salvage doesn't push all the work, the checkout stays, and startup recovery salvages it again instead of removing it. A turn that starts within the limit runs to its own answer. If the operator holds or pauses the child when the limit passes, the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The limit runs in memory, so a child that was already waiting when usine restarted waits without one.
- aabb29f: A configuration save or reload logs `Configuration step finished` with the duration and outcome of each step, from waiting for a running save to applying the revision. The 10-second limit covers the whole coordinator brain check, and a check that doesn't finish in time refuses the save with `ValidationTimeoutError` (HTTP 503) and stores no revision. `usine config` commands that write a revision apply the same limit. `@usine/orchestrator/current-instance` exports `ValidationTimeoutError`, `coordinatorBrainTimeout`, and `checkCoordinatorBrains`, and `@usine/orchestrator/operator/http` exports `ValidationTimeoutRefusal`.
- d7e00bc: Configuration selects what coordinates an attempt. The `coordinator` setting in `usine.yaml` takes `session`, the default, where a Pi parent session coordinates the attempt, or `events`, where the event-driven coordinator applies rules to the attempt's lifecycle events with no parent session. An agent file's `coordinator` overrides the instance setting, and the scheduler resolves it when each attempt launches. Startup, reloads, and saved edits check the parent brain only of agents that resolve to `session`, so an instance whose agents all resolve to `events` starts without a Pi credential and quarantines no agent. Imports, reloads, and saved edits refuse `parent_model` or `parent_effort` in the same agent file or `settings` block as `coordinator: events`, with the field path in the problem. An agent file also accepts an optional `decision` with a `model` and an `effort` for its decision sessions, which run on the agent's own harness; no behavior reads it yet.
  
  `ParentKind` (`pi` or `none`) is now `CoordinatorKind` (`session` or `events`), and `RunSpec.parent` is now `RunSpec.coordinator`, which decodes as `session` for attempts stored without it. A fourth attempt journal migration rewrites a stored `RunSpec.parent` of `pi` or `none` as `session` or `events`. `Agent` adds the optional `coordinator` and `decision` (`DecisionBrain`), and `resolveCoordinator` returns the agent's kind, else the instance setting. `CheckoutRequest.coordinator` carries the resolved kind into the `RunSpec`. In the operator API, `SettingsView.coordinator`, `AgentFileView.coordinator`, and `AgentFileView.resolvedCoordinator` report the setting. The web configuration pages show the coordinator of the instance and of each agent and edit it in the settings and agent forms; an agent on `events` shows no parent model or effort.
- e8003db: Attempts can run without a Pi parent session. `RunSpec.parent` selects the coordinator: `pi`, the default and the value that stored attempts decode as, or `none`, which runs the attempt on the event-driven coordinator. `RunSpec.outcomeLabels` gives that coordinator the labels the engine verifies after a success: `RunSnapshot`, `StepExecution`, and `CheckoutRequest` carry the outcome labels saved with the Run's Event, and preparation copies them into the `RunSpec`. Configuration doesn't set `parent: none` yet, so every configured attempt still runs its Pi parent.
  
  The event-driven coordinator starts one child with the rendered task and turns the child's end into the attempt's outcome: a report completes it, a reserved marker fails it with its typed failure, a provider capacity refusal fails it with `ProviderCapacityFailure` and the time the usage limit resets, and a launch or transport failure fails it with `InfraFailure`. Each lifecycle event goes through the `WakeUp` seam, and `WakeUp.rules` applies the event's rule, so the coordinator needs no model credential. Its state lives in the attempt journal in the runtime database: an orchestrator restart resumes the open child, applies a decision recorded before its transition, reads a child's recorded outcome instead of starting another child, and replaces a child that couldn't resume once within the child-session budget. Its outbox sends envelopes that the transcript didn't acknowledge again. A cancel settles an attempt without an outcome before its child stops, so a restart doesn't resume it. It refuses operator input for now.
  
  `@usine/durable/live` routes each attempt to the runtime that started it and requires the runtime database's `SqlClient` for the attempt journal; the orchestrator's `runtimeLayer` and the exe.dev engine layer take the shared database layer. `AttemptJournal` adds `startDelegation`, `saveProgress`, `settleDelegation`, `settleOpen`, `recordResult`, and `recordUnsupervised`, and a second migration adds their columns. `@usine/durable/testing` exports `routedRuntimeLayer`, and its `layer` runs attempts through the router.
- c8241d7: SSH worker preflight with a container runtime now checks that the SSH user can read the host kernel journal or ring buffer. A missing permission appears under **Preflight findings** on the worker's page, with the fix, and doesn't block attempts. `PreflightReport` and `MachineCheck` have a `findings` field, and the worker configuration and preflight views return `findings`.
  
  A container started again for a reason other than a memory kill now still records the processes the kernel killed before the start. The `dmesg` fallback filters `oom-kill:` lines on the worker instead of sending the whole ring buffer over SSH, the executor reads `dmesg` when a readable journal has no `oom-kill:` line instead of stopping at the journal's `-- No entries --` placeholder, a readable journal with no `oom-kill:` line no longer fails the read when `dmesg` is restricted, the executor logs which kernel log it read, and Podman's cgroupfs container cgroups (`libpod-<id>`) match. Out-of-memory records keep at most `MAX_KILLED_PROCESSES` (20) processes, and their kill count includes the rest; older records keep their first 20 processes.
  
  Attempt outcomes now name the killed-process list with its visible label, so screen readers announce it once. The **First time right** statistics hide the memory-kill line when the window has none.
- 3247872: Compare models per agent by task outcome. `GET /api/statistics` returns `agents`: for each agent that ran an attempt on a task done in the window, the harness and model of the agent's first attempt on each task, with the tasks merged, mixed tasks, tasks right the first time, median review rounds, median time from first attempt to merge, and median tokens and price per task with all loops summed. The agent page and the Statistics section show the comparison.
- 2a76a52: Outcome label verification counts only the labels that an attempt's GitHub account added during that attempt, or that an earlier attempt of the same run added during that earlier attempt. Local, SSH, and Cloudflare workers write as the GitHub App's bot, which usine also uses for `on_green` labels, so a label added between two attempts no longer counts for the retry. A timeline of more than ten pages falls back to the current labels without a retry. Other responses that usine can't use, such as a body that fails partway through, are retried like transport failures. `GitHubItemHistory.appChanges` fails with the new `GitHubTimelineTooLongError` for a timeline of more than ten pages.
  
  `Attempt.workerKind` records the kind of the attempt's worker when it starts, and the check reads each attempt's GitHub account from it, so a later change to the worker's kind doesn't change the account. Older attempts have none and use their worker's configured kind. The SQLite store adds a nullable `worker_kind` column to `usine_attempts`. A `StepExecutor` lease (`WorkerLease`) has a required `kind`: the kind of the leased worker.
  
  `FailedAttemptView.report` is the final report that a failed attempt kept, set in run detail reads and null in run lists: the report that the completion check rejected, or the report that handed off to CI before CI failed, timed out, or ended incomplete. The run page and run drawer show it under **Final report**, after the failure.
- 360d371: `outcome_labels` entries use the GitHub label name rules and messages: a trimmed name of at most 50 characters. A loop file whose outcome labels differ only in letter case is rejected, because GitHub compares labels without case. A schedule loop that sets `outcome_labels` fails schema validation, because its runs have no item to label. An outcome label that `usine.yaml` doesn't declare under `labels` adds an `UndeclaredOutcomeLabelWarning` to `LoadedInstance.warnings` and logs `Loop outcome label is not a declared GitHub label` when the instance folder loads and each time `CurrentInstance` installs a configuration. The loop still loads. `logConfigWarnings` in `@usine/config/instance` logs these warnings.
  
  The SQLite configuration store rewrites stored loops that earlier versions accepted and these rules reject, so the stored configuration keeps loading. When it opens, it removes a schedule loop's outcome labels and each label that repeats an earlier one in a different letter case, records the change as one revision without an actor, and logs each loop. If the upgraded configuration is still invalid, the store leaves the stored loops unchanged and logs a warning with the problems. **Configuration > History** shows a stored agent or loop value that the current rules reject as YAML of its stored fields, through `formatRevisionEntity` in `@usine/config/folder-codec`, instead of failing to load the revision.
  
  `GitHubLabelName` and `canonicalLabelName` are exported from `@usine/core/label`; import them from there instead of `@usine/config/label`. `OutcomeLabels` in `@usine/core/loop`, and the `outcomeLabels` field of `Submission` in `@usine/engine`, now contain `GitHubLabelName` values.
  
  The loop detail page in **Configuration > Loops** lists a loop's outcome labels and warns about undeclared ones. `LoopFileView` in the operator API adds `outcomeLabels` and `undeclaredOutcomeLabels`. The loop form writes `outcome_labels` only when the loop sets at least one label.
- 2882f71: A CI wait no longer treats a partially created GitHub Actions run as green or as a failure for the fix loop. Before it applies completion labels or starts a fix, usine reads the latest run of each workflow on the recorded head. When a run concluded `failure` or `cancelled` with no failed job, such as a run whose jobs Actions never created, the wait ends in **Needs attention** as an infrastructure failure that names each run ID and link. usine applies no completion labels and starts no fix. A failed job or failed commit status on the head still starts the fix loop without waiting for other workflow runs, except a gate job that failed only because jobs it needs stayed queued. Before the CI deadline, CI that ran only in part keeps the wait pending while a check outside the concluded runs, such as a commit status, is still pending. If GitHub refuses the commit-status read, such as when the App lacks the optional **Commit statuses: read-only** permission, usine decides from the check runs alone. A job that fails while usine reads CI waits for the next poll. Otherwise, a workflow run that hasn't concluded keeps the wait pending, even after its last job finished and the checks read green, until the CI deadline. usine doesn't rerun workflows, so the App doesn't need **Actions: read and write**; rerun the named runs and apply the completion labels after the checks pass.
  
  `GitHubChecks.workflowRuns` from `@usine/github/checks` returns runs that concluded `failure` or `cancelled` as `FailedWorkflowRun` records and runs that haven't concluded as `RunningWorkflowRun` records. `GitHubChecks.unfinishedChecks` returns the check runs and commit statuses on a head that haven't completed as `UnfinishedCheck` records; when GitHub refuses the commit-status read, it returns the check runs alone, and `CiIncomplete` from `@usine/core/ci` is the CI resolution that settles the wait.
- 331a899: Workers accept `paused`. A paused worker takes no new attempts, and its running attempts finish; a run that reattaches an attempt already on the worker still takes a free slot there. The scheduler sends other runs to the next unpaused worker, so pausing the workers listed before a new worker sends attempts to it. Pausing or resuming applies on reload without a restart or a preflight. The worker page, the worker list, and the **Workers** line on **Overview** show a paused worker, and **Needs attention** lists it until it resumes. The worker form has a **Paused** option, and exports omit `paused: false`.
- 38a1f7e: A queued CI fix no longer opens when its recheck can't read the pull request because of a GitHub error or the five-second timeout. The fix stays queued, and the next reconcile rechecks it, so a GitHub outage right after a cycle reset can't admit a fix for a head that a newer push replaced. A queued trigger match still opens with its saved settings in that case.
  
  Unpausing a loop rechecks the queued CI fixes at once instead of at the next periodic reconcile, and the request doesn't wait for those rechecks. While a cycle-budget reset is pending, polling calls `RunEngine.admitCiFixes` instead of running a full engine reconcile, and a failure there logs a warning instead of failing the poll. That call admits every queue whose newest event is a CI fix, on every loop and repository, not only the fixes the reset replayed. When such a fix no longer matches, the item's next queued event is rechecked, and if it is a trigger match that still holds, its run opens. A reset whose repository is no longer configured is acknowledged on the next poll.
  
  Reconcile reads the admissible queues once per pass and admits each one, whatever the kind of its newest event. After a recheck mismatch, the next queued event is rechecked only while the item has no open run or suppression, so no GitHub read is spent on an event that can't be claimed. The reconcile summary logs at info only when it opened a run, started a fiber, or retried a stop.
  
  Breaking API changes:
  
  - `TriggerRecheck.Matches` carries `settings`, the Loop settings and task the run opens with, instead of a whole `submission`. The engine keeps only the setting keys from `settings`, so the event, item, revision, cycle generation, and CI evidence stay as recorded even when an adapter returns a whole submission. Adapters that keep the saved settings return `TriggerRecheck.Matches({ settings: savedSettings(submission) })`; `savedSettings`, which returns only the setting keys of its argument, and the `AdmissionSettings` type are exported from `@usine/engine/trigger-condition`.
  - `TriggerRecheck.Undetermined()` is a new result for a recheck that could not read the item. Adapters that matched on a failed read return it instead.
  - `RunStore` implementations must provide `admissibleQueue(loop, itemKey)`, which returns the item's queued events, newest first, or `None` while the item has an open run or a suppression. It replaces `RunStore.queuedOn`, which 0.7.0 added without listing it as a breaking change.
  - `RunEngine` implementations must provide `admitCiFixes`, which admits the queues whose newest event is a CI fix, as reconcile does, and returns the run IDs it opened. Those can include a trigger match opened after a CI fix mismatch.
- ec8e50b: A failed run in **Needs attention** says where its CI fix run stands: the fix run continues the work, finished it, handed it to another fix run, or failed too. A reopening or run-again of a fix event now counts as the source run's fix. When two fix runs opened at the same time, the one with the greater run ID is the newest.
  
  The fix run is no longer part of a failed run's attention revision, so a dismissed failure stays dismissed when its fix run opens or changes state. This changes the revision of every failed run once: failures dismissed before this upgrade appear in **Needs attention** again once, and dismissing them again keeps them dismissed.
  
  After a cycle budget reset that replays CI fixes, the web app shows a notice with the number of replayed fixes.
  
  A queued event stores its generated CI handoff instructions apart from its prompt, in a new `ci_instructions` column of `usine_trigger_events` that a migration adds. A recheck removes exactly the recorded instructions before it appends the current CI policy's, so a change to the instructions' wording no longer leaves two handoff instructions in the task. Events queued before this upgrade fall back to removing the instructions that their CI policy generates now.
  
  Breaking API changes:
  
  - `RunReader.ciFixRuns` returns a map from source run ID to `CiFixRun`, which holds the fix run's `runId` and `state`, instead of a map to the fix run ID.
  - `RunFailureNeed.fixRunId` is replaced by `fixRun`, a `CiFixRun` or null. Clients of `GET /api/overview` read `fixRun.runId` and `fixRun.state`.
  - `Submission` has a `ciInstructions` field, and `AdmissionSettings` includes it. A `TriggerCondition` that returns its own settings sets `ciInstructions` to the instructions that end its `task`, or `None`.
- c7bd772: SSH workers keep their disks from filling up with worker images. After each image pull, usine removes the other images of the attempt image's repository. It keeps the current image, the most recently built other image, and every image that a container uses. After a rollback, the retained image can be newer than the current image. Cleanup recognizes Docker Hub name aliases and tracks images replaced by mutable tags such as `latest`.
  
  Preflight and each new attempt, before its checkout starts, check the free disk space on the filesystem of the worker's `root` and on the container runtime's image storage. Below the threshold, the check fails with a `disk` capability error that states the free space and the threshold. **Needs attention** shows the error, and attempts wait until a preflight passes. The threshold defaults to 10 GiB; set `min_free_disk_gib` on the worker to change it, or to `0` to turn the check off. An attempt whose check fails before its checkout fails with an infrastructure failure, which usine retries.
  
  When one of usine's own commands on a worker, such as an image pull or a checkout, reports `ENOSPC` or `No space left on device` during preflight or preparation, usine reports the same `disk` error instead of the command's failure. A report from the attempt's agent keeps the outcome that the agent gave it.
- c7f39bc: A CI wait now tells a stalled or incomplete GitHub Actions run apart from red CI, and explains how to recover. At the CI deadline, usine reads the workflow runs on the recorded head even while the checks are pending. If GitHub Actions left a run `queued` or `in_progress`, the timeout message says that Actions didn't finish it and names the run with its ID and link. It tells you to push a commit or to rerun the run once GitHub allows it. A gate job that failed only because jobs it needs stayed queued is incomplete CI, not a failure: the wait ends in **Needs attention** as an infrastructure failure that names the run and the jobs that didn't finish, and it starts no fix. While that run is still going, the wait stays pending, because the queued jobs can still start. usine matches that job by its Actions job ID, so a failed job with the same name in another workflow run, or a failed commit status on the head, still starts the fix loop. A failed job from an earlier attempt of a rerun that is still going keeps the wait pending. When a run is still going or checks are still pending at the deadline, the message also lists the pending jobs with their running times. A run that ran only in part waits while another workflow run on the head is still going, so a later failure in that run still starts the fix loop. At the deadline, the message names every workflow run that didn't run or finish in full.
  
  A run whose CI wait ended this way offers **Apply CI labels** in **Needs attention**. After CI on the same head passes, with every workflow run concluded in full, the action applies the wait's completion labels and marks the failure resolved. While CI on the head hasn't passed, or after the pull request closed without a merge, it applies nothing and shows why. The operator API exposes it as `POST /api/runs/{runId}/apply-ci-labels`, which answers `409` with `CiNotPassedError` until CI passes. When GitHub refuses the workflow-run read, such as on a private repository without **Actions: read-only**, the check state decides alone, as it does during the wait.
  
  `RunState.Failed` from `@usine/core/run/state` keeps the wait's handoff as `unfinishedCi`, and `operatorActions` reports `canApplyCiLabels`. `GitHubChecks.workflowRuns` from `@usine/github/checks` reports the runs that concluded `failure` or `cancelled` as `FailedWorkflowRun` records in `failed`, and lists the jobs of each run's latest attempt as `WorkflowJob` records in `jobs`. `CheckFailureEvidence` now lists `checks` as `FailedCheck` records with their `ActionsJobRef`, and `GitHubChecks.failedStatuses` reads the failed commit statuses on a head. `CiMonitor.applyLabelsAfterGreen` applies the labels, and `RunView.canApplyCiLabels` and `RunFailureNeed.unfinishedCiAttemptId` from `@usine/orchestrator/operator` expose the action.
- 4aebd77: The supervisor is a role of the harness contract. `@usine/agents/harness` exports `supervisor`, a role that runs on the orchestrator on a gateway credential route, lists only its usine tool set, keeps its conversation between turns, and takes interventions, and `admitSupervisor`, which requires `usine-tools`, `closed-tools`, `resume-session`, `steer`, `interrupt`, and `token-usage`. `@usine/agents/supervisor` exports `runSupervisorTurn`, which opens a supervisor session through `Harnesses` with a toolkit, or reopens the saved session for the conversation's next turn, and returns the answer, the saved session, and the session's cumulative usage across turns. A failed turn returns `SupervisorTurnError` with the usage that the session had spent. When a Claude Code process resumes a session, the first result's `modelUsage` minus its `model_usage_since_last_result` is the usage that Claude restored. usine counts that usage once and logs it at Info. This applies to a replacement process, to a process that the adapter resumes after its remote process stops, and to either one when the orchestrator reattaches it before its first result. `SessionTokensUpdated.processUsage` records `awaitsFirstResult` until then.
  
  `settings.supervisor: { harness, model, effort }` selects the supervisor's brain. Saving the configuration refuses a harness that can't serve the role and names what it lacks; Codex is refused, because it lists its own tools in every thread. An instance without the setting starts, and `SettingsView.supervisor` is null, which **Configuration > Settings** shows as not configured. The settings form edits the brain.
  
  The server builds the supervisor's operator toolkit from the operator tools that the MCP endpoint serves, filtered by the member's grants and operation ceiling, and answers each call through the operator API with the member's credential.
- c5be05b: The orchestrator can run supervisor turns in a read-only container on its host, with the instance's source to read, on Claude Code, Codex, and Pi. No interface opens a supervisor conversation yet.
  
  `RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host, and its grep runs as a Node.js script there, with Pi's glob, pattern, and output limits.
  
  `@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. The relay and the route drop every header in `CALLER_CREDENTIAL_HEADERS`, which `@usine/gateway/admin` now exports. The sandbox writes the harness's settings without following a symbolic link, and runs one turn of a conversation at a time. A container whose orchestrator stops ends itself, and the next start removes any that remain. `makeSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount, and holds each tree until the turn ends. It removes a tree once the tree is no longer the head and no turn holds it.
  
  `@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.
- 4a83af0: On the task page, **Retry** after a pull request's base or head changed refreshes the task first and then loads the PR's current changes, instead of repeating the stale selection. When every recorded attempt on a pull request pushed no new commits, the **Changes** panel says so instead of reporting that no attempt commits were recorded. Task detail's `attemptChanges` now includes those attempts with a `base` equal to their `head`.
  
  When GitHub answers 404 for a file read because the GitHub App installation doesn't cover the repository, `GET /api/projects/:project/pull-requests/:repository/:item/files` returns `503` with `ProjectNotInstalledError` and says that the App lost access, instead of reporting an unavailable comparison or force push. `GitHubFiles.read` fails with `ProjectNotInstalledError` in that case.
  
  The server cache for pull request files holds up to 64 MiB of file paths and patch text and evicts the least recently read responses first, so responses over 512 KiB are cached too. Concurrent reads of one selection share their GitHub requests.
  
  `@usine/github/files` exports only `GitHubFiles`. Import `ChangedFile`, `FileChanges`, `FileChangesQuery`, `PullRequestFilesQuery`, `CommitRangeFilesQuery`, and `PullRequestFilesChangedError` from `@usine/github/file-changes`.

### Patch Changes

- bfa02ef: A CI handoff that names a closed or merged pull request now fails as an agent failure with the new `PullRequestNotOpen` reason. A CI wait whose pull request is merged or closed before CI passes now ends at once, with no completion labels and no fix; before, a pending wait stayed pending until its timeout. A merged pull request ends the wait as passed. A pull request closed without a merge cancels the run with the new cancel reason `PullRequestClosed`, through the new `CiPullRequestClosed` resolution, so it isn't an agent failure. If CI on a merged pull request's head is already green, the wait passes and applies its completion labels. `CheckSnapshot` reports the pull request's state as `pullRequestState`, and reads a null branch target as the pull request's head instead of failing to decode.
  
  Harvesting compares the pull request's head repository with its base repository by ID, so a renamed repository verifies. A verified handoff also keeps the other pull requests that GitHub's commit-to-pull-request index lists at its head. A detached checkout whose head is only on `refs/pull/<n>/head` reads those pull requests by number instead of waiting on the index. A candidate branch or pull request whose read fails no longer hides another candidate's open pull request. GitHub reads now retry invalid output, like failed reads.
  
  Two new reasons separate failures that were all reported as `GitHubReadFailed`: `GitReadFailed` for a failed `git` read of the checkout or origin, and `VerificationTimedOut` for reads that take longer than 10 seconds. Both remain retryable infrastructure failures. `GitHubReadFailed` keeps the read's error as `cause`.
- 5c1ff0a: An `exe.dev` worker is refused with a message that names it and says that this version of usine doesn't run the kind. The configuration store refuses a commit that leaves an `exe.dev` worker in the configuration, and `usine up` refuses a stored one when it starts running attempts. Setup mode, which runs no attempts, still starts. Before, an instance whose workers were all `exe.dev` was told that the worker differed from the other workers. `@usine/config/factory` exports `exeDevWorkerRefusal`, the shared message. `@usine/config/configuration` exports `replay`, which applies stored revisions without this refusal. Replaying stored revisions, for a revert or when the running server applies a new revision, still accepts `exe.dev` workers.
- a38a607: The coordinator brain check of a configuration save, reload, or start checks the credential's login once per provider, however many agents, parent models, and efforts use that provider, and still names each refused agent. When Pi selects the parent model, it lists the available models once per check, not once per agent. The 10-second limit covers the whole check, and for `usine config` commands it also covers loading the parent models, so a slow load refuses the write with `ValidationTimeoutError` and stores no revision. `@usine/durable/parent` adds `sharedParentAnswers` and an optional `answers` argument to `resolveParent`.
- 589ad7b: `GitHubChecks.pendingDetails` takes a `historyDeadline` and returns a `PendingCheckReport` instead of an array of `PendingCheck` records. The report lists running jobs before queued ones and counts in `omitted` the pending checks after the first ten. When no check run is pending, it lists the head's pending legacy commit statuses. Duration history reads stop at the deadline or at the first rate limit and keep the durations already read, so a slow history read no longer discards the job list. The baseline for a job's previous duration now comes from the latest successful run of the same workflow and event.
  
  The CI timeout diagnostic now reads "has been running for 31 min; its last successful run took 6 min" instead of quoting GitHub's `in_progress` status, states when a running job has no recorded start time, and says how many pending checks it leaves out. When the diagnostic read fails, its warning log includes the failed GitHub operation and message.
- 20936ea: The startup check of coordinator brains logs `Configuration step finished` with step `coordinator-brains`, its duration, and its outcome, as saves and reloads do.
- 4faa2c7: A provisioned machine on a tailnet checks that it reaches the gateway up to three times, 13 seconds each, with 3 seconds between tries, before usine deletes the machine. A boxd machine reaches the gateway only through Tailscale's relays, so the first request after a join can time out while the relay path comes up.
  
  When a check fails during machine creation, the worker's preflight shows the failure until a machine creation succeeds. That success now restores the worker's earlier preflight result on **Workers** and in `/api/desk`, instead of leaving the worker `Failed` while attempts run on it.
- ab62a30: A configuration write whose coordinator brain check runs out of time answers HTTP 503 instead of 504, so the UI receives the `ValidationTimeoutError` refusal through Cloudflare Tunnel, which replaces an origin 504 with its own error page.
- Updated dependencies [6b7ec62]
- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [b580789]
- Updated dependencies [55c75fe]
- Updated dependencies [8a441c2]
- Updated dependencies [095438d]
- Updated dependencies [3719899]
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
- Updated dependencies [6e55876]
- Updated dependencies [8e2003f]
- Updated dependencies [fd52df7]
- Updated dependencies [ae523e4]
- Updated dependencies [e8003db]
- Updated dependencies [5c1ff0a]
- Updated dependencies [fa97db3]
- Updated dependencies [b9ec633]
- Updated dependencies [c8241d7]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [a38a607]
- Updated dependencies [2882f71]
- Updated dependencies [331a899]
- Updated dependencies [589ad7b]
- Updated dependencies [fa97db3]
- Updated dependencies [360d371]
- Updated dependencies [38a1f7e]
- Updated dependencies [ec8e50b]
- Updated dependencies [eb58cad]
- Updated dependencies [fa97db3]
- Updated dependencies [eb58cad]
- Updated dependencies [8fa25bb]
- Updated dependencies [5ae7631]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [eb60495]
- Updated dependencies [5ae7631]
- Updated dependencies [6a42cb3]
- Updated dependencies [1eddd3d]
- Updated dependencies [4aebd77]
- Updated dependencies [c5be05b]
- Updated dependencies [4faa2c7]
- Updated dependencies [4a83af0]
- Updated dependencies [039daa4]
  - @usine/durable@0.4.0
  - @usine/core@0.8.0
  - @usine/config@0.7.0
  - @usine/executor@0.7.0
  - @usine/agents@0.8.0
  - @usine/github@0.6.0
  - @usine/engine@0.8.0

## 0.6.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 153d3ea: Return run and attempt summaries from overview, board, and desk reads to reduce polling response sizes. Read run or task detail for prompts and result messages. Board and stalled-item Run again actions load the saved task on demand.
- 25728fa: Allow a boolean CEL condition to require approval per run. Save and display the
  approval decision, require approval when evaluation fails, and validate conditions
  in the loop editor and configuration API.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- d0900a3: Update web screens from server-sent change notices. Add conditional reads, scoped screen queries, optimistic board moves, and paginated, virtualized history.
- 13bdef9: Guide first-run setup through GitHub App creation, credential recovery, installation, and first-admin sign-in. Save App and OAuth secrets atomically with mode 0600, support existing credential files, and initialize empty instance configuration in the database.
- 9290433: Define harness metadata in one platform-free catalog. Configuration validates registered harness IDs, workers share credential and login requirements, and operator clients receive labels and resume commands through the capabilities API. Harness IDs are branded strings, and Codex pricing reads the descriptor’s bundled rates. Existing launch, authentication, and version policies are unchanged.
- 7e5bb5b: Record accepted CI fixes as neutral handoffs with links to the continuing run. Keep source runs out of failure statistics and Needs attention when a fix run continues the work. Task lists and board cards show the fix run's status. Unavailable fix loops, refused events, exhausted budgets, and CI timeouts still require attention.
  
  Preserve pending completion actions across CI fix runs and apply them with the final successful head’s actions.
- 4f87593: Add project roles and revisioned role bindings, enforce API permissions, and filter project data by access. Add token permission ceilings and controls for bindings and token scopes. Attribute local API writes and configuration CLI revisions to local admin. Existing members retain instance admin access through a one-time migration.
  
  Authorize run actions and cycle-budget resets against the repository’s current project, including after a repository moves. Refresh the configuration revision after writes and stale-revision failures so later writes use the current revision.
- 294ebdd: A queued CI fix takes approval, agent, models, permissions, CI policy, outcome labels, and `max_cycles` from its loop's current configuration when its run opens. Its prompt and failure evidence stay as recorded. Current settings also apply when a GitHub read error or recheck timeout permits admission. Approval expressions use the saved event payload. The generated CI handoff instructions follow the current CI policy.
  
  When a CI fix and a trigger match wait on the same loop and item, the newest event that passes its recheck opens the next run and supersedes older events. A CI fix that does not match is revoked on its own before the next candidate is rechecked. A trigger mismatch revokes the queued trigger matches together and preserves CI fixes for their own rechecks. A missing item revokes the whole queued group. Reconciliation no longer rechecks CI fixes queued behind a running attempt.
  
  The cycle budget reset response lists the CI fix events it replayed in `replayedCiFixEventIds`. A failed run in Needs attention links to the newest admitted CI fix run that has not been canceled or revoked.
  
  Breaking API changes:
  
  - `TriggerCondition.recheck` returns `TriggerRecheck.Matches({ submission })`, `TriggerRecheck.NoLongerMatches()`, or `TriggerRecheck.ItemGone()` instead of a string. Custom adapters must return the tagged result and include the submission for a match.
  - `RunReader` implementations must provide `ciFixRuns(sourceRunIds)`, which maps source run IDs to their newest admitted CI fix run IDs.
  - `CycleBudgets.reset` returns the replayed CI fix event IDs, or an empty list for a repeated answer.
  - `POST /api/cycle-budgets/reset` returns `{ replayedCiFixEventIds: string[] }` instead of `{ ok: true }`. Update clients to read the new response.
- 8cef39b: Apply SSH and Cloudflare connection changes without restarting. New attempts use the updated connection; open and retained attempts keep their original machine, container settings, gateway, and client through recovery and restart. Cancel provisioning retries when an SSH worker switches to a fixed destination. Persist per-attempt connection metadata using credential references in the Node orchestrator.
- 7c58461: Add opt-in machine reuse for Boat and Hetzner SSH workers with `provisioner.reuse: { attempts: 5, max_age: 2h }`. Reuse requires Docker, successful cleanup, gateway attachment revocation, and preflight before each assignment. Machines retire at the attempt or age limit and when their worker connection is removed.
  
  Show machine assignment counts and age on the overview and worker page, and persist daily machine-start counts for statistics.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.
- 81330c9: Show whole pull request and recorded attempt changes on task pages with collapsed file diffs, change counts, and CI and review state. Add a project-scoped files API and commit-based caching, with explicit reporting for missing and truncated GitHub patches.
  
  Keep recorded attempt changes available after failed or canceled CI waits, including when a later retry succeeds.
  
  Backfill older comparisons only when their producing attempt is identifiable, and let each attempt's completion replace an existing backfilled result.
  
  Classify generated files by path to avoid marking hand-written files whose patches mention generated-file markers.
- 0e34ec1: Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.
- 50ab3dd: Run preflight on an idle worker from Configuration > Workers or `POST /api/workers/:worker/preflight`. Checks refresh the worker's stored results, scheduling availability, and Needs attention without a restart. Busy workers return a typed refusal.

### Patch Changes

- 6a1cf79: Run SSH attempt containers with memory-backed `/dev/shm` and `/tmp` storage. Configure their capacities per worker with `container.shm_size_mib` and `container.tmpfs_size_mib`; each defaults to 2048 MiB and is capped at the container memory limit.
- d0900a3: Keep runs on paginated cards out of Runs without a card. Refresh run details after configuration changes so agent definition warnings stay current.
- e0cedc8: Classify pending CI deadlines as infrastructure failures and report running jobs with elapsed times and previous successful durations when available. Bound diagnostic reads so a stalled request cannot prevent timeout settlement.
- 7e39460: Retry transient GitHub polling responses, including CI check and log reads, up to twice with jittered backoff and warning logs. Report GitHub request failures in Needs attention after three consecutive failed repository poll cycles, including deferred snapshots and CI observations for repositories removed from configuration, and clear them after a successful cycle. Preserve failure counts and existing alerts while open-issue checks or label requests are rate-limited. Retry warnings include the operation and error tag, with the response status for HTTP failures.
- 01467e3: Reduce overview responses with compact board run summaries and a bounded recent run list. Preserve all board cards, task totals, and Needs attention entries. Load complete board run history when its menu opens.
  
  Read polling metadata without prompts, results, or comments. Select current board runs with SQL windows and aggregate historical counts, timing, and loop states in storage.
- 8c079aa: Route coordinator model requests through the instance's first configured gateway with a caller token. The orchestrator host needs no provider login when a gateway is configured. Check coordinator gateway credentials at startup and keep usage in the API-key or ChatGPT plan pool. Expose the gateway model route for orchestrator-hosted runtimes.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- dba9075: Support gateway credentials over Tailscale on long-lived SSH workers. Set `tailnet.gateway_address` with a gateway; preflight configures gateway access through passwordless sudo, and attempts use direct internet egress.
- 236290b: Report attempt image presence, image inspection and pull durations, and container startup timings on SSH workers. Warn when a provisioned machine's snapshot lacks the image. Show Preparing the attempt image while the machine runs preflight and prepares its shared caches.
- 12c3921: Check harness capabilities by role, credential route, and placement with one admission policy. Configuration and preflight refusals identify the missing requirement and adapter reason. Validate parent models, efforts, and credentials before accepting configuration imports, reloads, or saved edits. At startup, quarantine agents with refused parent brains and their loops in Needs attention while keeping the server available. Restore them after a corrected reload.
- 548e6b7: Register harness preflight and launch through `Harnesses` on `@usine/agents/harness/node`. Registration rejects incomplete descriptor/runtime pairs and duplicate IDs. Gateway, injected-key, and Cloudflare preflight use the registered runtime with their credential route. Refusal messages name the harness and its installation location, mention a login only for host-login probes, and retain sandbox-image guidance for Cloudflare. Successful binary probes log the installed version.
  
  Replace the three harness-specific backend tags with `ChildBackend`, and rename the single-harness layers to `claudeChildLayer`, `codexChildLayer`, and `piChildLayer`. Replace `ClaudeLoginLock` and `claudeLoginLockLayer` with `HostLoginLock` and `hostLoginLockLayer`; `withLock` takes the harness ID before the worker and machine. Share one lock layer between the executor and attempt runtime.
  
  `preflight` accepts a `ProbeTarget` and requires the injected `Harnesses` service. Build the registry once with the process spawner and shared `HostLoginLock`, then provide it to the executors and durable attempt runtime. Registration errors remain typed until the server reports a startup failure. It returns capability gaps as readiness reports and fails on transport errors or timeouts. Custom `HarnessProbe` wrappers forward the worker and machine context in their second argument.
- 82b55aa: Show a dismissed cycle-budget entry again when a later event is blocked on the same item, and display the most recently blocked loop. Preserve dismissals during repeated polling of the same blocked events and keep the ask's reset identity unchanged.
  
  Add `CycleBudgetBlock`, `CycleBudgetAsk.blocks`, `recordBlock`, and `blockedLoop` to record the latest refused event per loop. Older asks decode with an empty block list.
- d0900a3: Restore moves from paginated board lanes and automatic access after a role binding grant. Refresh task details when labels or merge conflicts change on any linked item.
- 1f12974: Apply webhook mode and URL changes and add Cloudflare workers without restarting the orchestrator. New Cloudflare workers resolve credentials and register a client before preflight; existing clients remain unchanged. A refused addition of a never-accepted worker releases its client, so a corrected revision can add the worker; an accepted worker keeps its client. Document why tracing and existing worker connection fields require a restart.
- 9786f67: An attempt whose CI pull request can't be verified now fails with the reason in its message. A handed-off head that differs from the checkout, a pull request that origin doesn't have or that comes from another repository, and a branch that isn't at the pushed head are agent failures. A GitHub read that still fails is a retryable infrastructure failure.
  
  The pull request read during harvesting retries twice, on the same schedule as the GitHub polling reads, and logs the branch's commit on origin against the pull request's head on GitHub.
  
  A loop with a CI policy whose agent ends without a handoff now verifies the open pull request of the checkout's branch on origin and uses branches on origin at HEAD for detached checkouts. When only pull request refs match, it uses GitHub's commit-to-pull-request index. An unchanged detached checkout from a branch or tag revision fails as an agent failure instead of waiting on an unrelated pull request.
  
  For a detached fixed-commit checkout, indexed pull requests from a fork now fail with `RepositoryMismatch`. When an origin branch matches the detached HEAD but has no open pull request, verification fails with `PullRequestNotFound` even if a matching pull request ref is also on origin. The commit index is queried only when no origin branch matches.
  
  A plain success whose GitHub or git verification read fails now records an `InfraFailure` instead of an `AgentFailure`. This includes persistent authorization failures such as HTTP 403, so the attempt can run up to three times. A local branch pushed under a different remote name fails with `BranchNotAtHead`; an explicit handoff verifies the pull request's source branch independently of the local branch name.
- f632c1b: Verify a loop's outcome labels from the run's label events on GitHub. An outcome label added during the run counts across retries even if another loop removed it before the attempt settled, and a label left from an earlier run doesn't count. usine checks the item's current labels only when it can't read the label events.
  
  Retry outcome label reads after timeouts, transport failures, server errors, and other failures except definite refusals or a missing item. Verify each completion once, skip the check when the run doesn't record the success, and keep a rejected report's message and facts on the failed attempt.
  
  `CompletionCheck` moves to `@usine/engine/completion-check` and becomes a required service with a `verify` method. Hosts that don't verify outcome labels provide `CompletionCheck.unverified`.
- 0abd5fa: Include the failed GitHub operation and up to 500 characters of decode detail in poll failure logs and Needs attention.
- f0f018d: Keep polling a repository when GitHub returns a server error for one item's snapshot: log a warning, commit the other items and the poll cursor, and fetch that item again in the next poll. A cycle budget reset now fetches only its item instead of polling the whole repository from scratch.
- 77ede43: Read harness credential environment variables and configuration files from descriptors, and manage SSH attempt homes per harness.
  
  Gateway credential slots and URL prefixes use `anthropic-messages` and `openai-responses`. Upgrade the gateway first, then the orchestrator, replacing `anthropic` and `openai` in `gateway.llm_providers`. For one release, the gateway accepts the previous URL prefixes as deprecated aliases so running attempts can finish. Preflight normalizes previous provider IDs and requires a gateway with credential reporting. Provisioner API-key names, Cloudflare provider records, and gateway credential environment-variable names stay the same.
- 1d5414f: Route a pull request with merge conflicts and no checks to the configured CI fix loop. The fix task includes conflict resolution instructions and inherits pending completion actions. Unknown mergeability keeps the CI wait pending.
- 4d60236: Record kernel task names and host PIDs for processes killed by attempt container memory limits. Show available process details and missing-detail counts below attempt outcomes, and report memory kills and repeated kills beside first-time-right statistics. Older records retain their kill counts with empty process lists.
  
  Serialize the repository check and build tasks to fit the worker memory limit, matching the existing test command. Document gate memory requirements and host kernel-log permissions.
- a7bd195: Add an exact browser origin allowlist with credentialed CORS and security headers on all server responses. Configure additional origins in `auth.origins` and restart; loopback browser origins now require an explicit entry unless they are the canonical server origin. Document public HTTPS deployment with Caddy, Cloudflare Tunnel, and Tailscale Serve.
- 45bb9cb: Keep worker slots free while an idle upgrade defers new attempts. Show the requested version on deferred runs and worker rows, and report prolonged waits in Needs attention. Cancel a pending upgrade from Settings or with `DELETE /api/upgrade` to resume attempts without restarting.
- d950835: Add a public `/api/ready` endpoint that returns HTTP 503 during startup recovery and HTTP 200 afterwards. Managed upgrades require both the expected version and readiness before recording success, so a startup failure restores the previous package and both databases. Rollback supports releases that predate the readiness endpoint.
- d5fb58b: Replay blocked CI fix events after a cycle-budget reset without requiring a trigger label. Recheck the recorded PR head before admission and preserve failure diagnostics and completion actions across restarts. Keep paused fixes queued until their loop resumes.
- d0900a3: Refresh open run views during machine preparation and quota backoff for project readers. Machine creation takes the run’s ID and loop so its notices use the project scope. Keep idle boards cached when GitHub polls return unchanged items.
- 1948b10: Record the resolved billing pool on parent and child sessions and preserve parent billing across restarts. API-key sessions record their endpoint's provider name when available. Usage reads the recorded pool, with compatibility for older transcripts.
- 6e9df5c: Keep dismissed pool usage warnings hidden within the 80%, 90%, 95%, and 100% usage bands while displaying the current percentage. Warnings appear again when usage enters another band or the reset time changes.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- 702692b: Refresh older open pull request payloads once to record comparison bases. Omit attempts without new commits, show checks and review decisions only for whole-PR comparisons, and keep file names readable on phones.
  
  Use `scope` for the file-selection query parameter. Return specific 404 errors for unavailable comparisons and 409 errors for stale PR selections. Bound cached file responses to 512 KiB per entry and 64 MiB of serialized payloads, document the conservative 300-file comparison limit, and export file-change models separately from the GitHub service.
- d0900a3: Publish web change notices after committed writes. Idle connections send heartbeats without rebuilding overview, desk, or configuration projections. Filter live notices and bounded replay by project access.
  
  Refresh open statistics at UTC midnight as rolling windows advance.
- Updated dependencies [6a1cf79]
- Updated dependencies [1ae89b1]
- Updated dependencies [edc1f40]
- Updated dependencies [e0cedc8]
- Updated dependencies [6e60662]
- Updated dependencies [7e39460]
- Updated dependencies [47c0f07]
- Updated dependencies [df0bd8f]
- Updated dependencies [b70b5fe]
- Updated dependencies [09417f7]
- Updated dependencies [b7ff637]
- Updated dependencies [853527d]
- Updated dependencies [10822d3]
- Updated dependencies [1674238]
- Updated dependencies [3e822f6]
- Updated dependencies [92f21ce]
- Updated dependencies [01467e3]
- Updated dependencies [25728fa]
- Updated dependencies [8c079aa]
- Updated dependencies [389f35e]
- Updated dependencies [a1c0d36]
- Updated dependencies [8d28709]
- Updated dependencies [e007d09]
- Updated dependencies [c396562]
- Updated dependencies [10154eb]
- Updated dependencies [dba9075]
- Updated dependencies [236290b]
- Updated dependencies [5d1254b]
- Updated dependencies [13bdef9]
- Updated dependencies [dbf14bb]
- Updated dependencies [9290433]
- Updated dependencies [12c3921]
- Updated dependencies [548e6b7]
- Updated dependencies [1c981c9]
- Updated dependencies [2482038]
- Updated dependencies [82b55aa]
- Updated dependencies [1f12974]
- Updated dependencies [9786f67]
- Updated dependencies [7e5bb5b]
- Updated dependencies [9d7dfb0]
- Updated dependencies [02860bd]
- Updated dependencies [35f68ef]
- Updated dependencies [f632c1b]
- Updated dependencies [9132a5b]
- Updated dependencies [d740598]
- Updated dependencies [fc15261]
- Updated dependencies [3229601]
- Updated dependencies [f0f018d]
- Updated dependencies [81330c9]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [973b47b]
- Updated dependencies [5796627]
- Updated dependencies [1d5414f]
- Updated dependencies [89ae7ee]
- Updated dependencies [4d60236]
- Updated dependencies [a7bd195]
- Updated dependencies [9476883]
- Updated dependencies [a1032fd]
- Updated dependencies [d0900a3]
- Updated dependencies [6e725ad]
- Updated dependencies [87aeb52]
- Updated dependencies [45bb9cb]
- Updated dependencies [b6a858e]
- Updated dependencies [0e34ec1]
- Updated dependencies [d5fb58b]
- Updated dependencies [294ebdd]
- Updated dependencies [10154eb]
- Updated dependencies [10154eb]
- Updated dependencies [d0900a3]
- Updated dependencies [10154eb]
- Updated dependencies [10154eb]
- Updated dependencies [ba8c2a5]
- Updated dependencies [8cef39b]
- Updated dependencies [4d5036a]
- Updated dependencies [a2c28c1]
- Updated dependencies [7c58461]
- Updated dependencies [03d2f48]
- Updated dependencies [d0900a3]
- Updated dependencies [acbf702]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [de42ea4]
- Updated dependencies [e3cddea]
- Updated dependencies [ef5aa4d]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [702692b]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [fbd379a]
- Updated dependencies [fc18d3f]
- Updated dependencies [0e34ec1]
- Updated dependencies [765be2e]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0
  - @usine/config@0.6.0
  - @usine/executor@0.6.0
  - @usine/github@0.5.0
  - @usine/engine@0.7.0
  - @usine/expression@0.6.0
  - @usine/agents@0.7.0
  - @usine/durable@0.3.0

## 0.5.0

### Minor Changes

- d1fd769: Run Boat workers with gateway-held Claude and ChatGPT subscriptions over Tailscale. Add saved snapshot validation, per-sandbox ephemeral auth keys, gateway name resolution, and tailnet cleanup. Configure a prepared snapshot and Tailscale OAuth environment variables to use a Boat gateway without LLM API keys.
- 21813b5: Add configuration editing, creation, deletion, revision history, export-format diffs, and reverts to the web UI. Preserve drafts on validation errors and revision conflicts. Include declared labels in the configuration view and remove the obsolete configuration reload endpoint.
- 8cb790a: Show cloud quota refusals in Needs attention with recovery steps and explain affected runs on board cards and run pages. Retain quota warnings through retries and clear them after machine creation succeeds.
- fdecd7e: Add schema validation for configuration form drafts and API endpoints for supported harnesses, efforts, installation repositories, and live repository labels.
- 88eac4f: Add operator API endpoints to read configuration revisions, edit and delete entities, and revert changes. Reject stale writes and report validation problems by entity and field. Check runtime compatibility before saving API changes, apply accepted revisions live, and start newly created loops paused.
- 9e14070: Store authored configuration in the runtime database with atomic revisions, validation, and live updates. Import the instance folder once, and add `usine config export`, `import`, `edit`, and `log` for running and stopped instances. Reject stale edits and invalid imports without saving a revision.
  
  Share the runtime database connection between the engine and configuration store.
- 59d6496: Add loop forms with live CEL diagnostics, payload completion, registry selectors, and prompt previews. Preview stored matches before saving or resuming a loop. Expose read-only check and preview endpoints, and preserve expression positions in validation errors.
- 6d7f66f: Require a member session or instance token for operator API requests, including requests from loopback. Add GitHub browser and device sign-in, one-time setup links, local admin tokens, member management, token revocation, and browser CSRF checks. Attribute operator actions and configuration revisions to the signed-in member. Convert stored GitHub ask approvals to the UI channel while preserving their approvers.
  
  Existing instances must configure GitHub App user authorization to use GitHub sign-in. Run `usine sign-in-link` on the instance machine for access before those settings are configured.
  
  Keep the version health endpoint public so existing upgrade helpers can verify the first release with member authentication.
- 79174da: Order waiting runs with integer CEL priority expressions over item labels and other stream fields. Priorities default to zero and sort highest first, followed by lane rank and event arrival. Failed evaluations log a warning and use zero. Overview and wait and lease logs show the evaluated value; loop checks and previews validate and evaluate expressions.
  
  Scheduler layers now require `ExpressionEngine`.
  
  Queue positions now include priority and lane together. Loop preview items and Overview’s queued-run responses include the evaluated priority.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- d903ac6: Add Dismiss and Undo to Needs attention. Dismissals persist with the operator and time, exclude matching entries from attention counts and badges, and show under Dismissed on the overview. Changed entries appear again. Dismissing preserves run actions and cycle budgets.
- f54b3bd: Show Needs attention warnings when a pool's latest reported rate window reaches 80% and has a future reset. Include the recorded login, percentage, and reset time, with Dismiss and Undo. Clear warnings when a newer report recovers or the window resets, independently of scheduling.
  
  Expose the latest stored snapshot per pool through `RunReader.latestPoolRateLimits()`, with a partial index on the existing transcript table.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 4f37e20: Add npm channel checks and browser upgrades for global server installations managed by systemd. Automatic upgrades wait for running attempts to finish; a separate helper restores the previous package version if the new operator API fails to start. Configure the channel and mode with `usine config edit settings instance` and install the helper service from the server guide.
- e59f7b8: Support endpoint webhook delivery with HMAC-SHA256 verification and startup configuration of the GitHub App hook URL. Refresh registered repositories through existing hints, show the running mode and last hint in Settings, and warn after ten minutes without a verified delivery. Endpoint mode requires an active App webhook and `USINE_GITHUB_WEBHOOK_SECRET` in the instance environment.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- 5e4644e: Add webhook deliveries mode to refresh managed repositories about every 10 seconds using GitHub App delivery summaries. Persist the delivery cursor across restarts, preserve the normal polling cadence, and show the last received hint in Settings.

### Patch Changes

- fd4123b: Fix Boat gateway preflight by using Node's HTTP client for SSH workers. Gateway probes now preserve the `Host` header when connecting to a tailnet address.
- 52d1734: Include the same diagnostic message in board move rejection logs and HTTP responses for missing projects, items, or lanes and read-only lanes.
- 4739c13: Document public exports, service operations, and operator view fields, including units, defaults, failure conditions, and configuration revision behavior.
- 4144c5f: Preserve GitHub's 64-bit webhook delivery IDs when decoding summaries, filtering newer deliveries, and saving cursors. `WebhookDeliveryId` now accepts decimal strings instead of numbers; compare IDs with `BigInt`. Existing numeric cursors reset once and subsequent polls store exact strings.
- 129d669: Start with healthy workers when another worker fails preflight. Exclude failed workers from scheduling, show their messages in Needs attention, and retry with backoff until they recover. Worker preflight includes address and credential initialization. Startup still fails if every worker fails, and live reload still refuses revisions whose preflight fails.
- 78b1a94: Keep items with open runs visible on the board beyond the 500-item history window. Task detail and board moves use the same expanded selection, preserving linked-task grouping and bounded historical reads.
- 9ea42f2: Block new attempts across all loops on an item before requesting a parent stop. Keep the block until the stop succeeds, recheck it after a worker slot becomes available, and show stops from other loops in the overview and run detail.
- a22dc8e: Create provisioned machines after persisting their attempt, with the attempt label present in the creation request. Retry provider failures within the same attempt and release its machine on cancellation. `WorkerMachines.create` now requires the attempt ID; the separate `assign` operation is removed.
  
  Resume worker reservations when creation backoff expires, even if the attempt that started the pause was canceled.
- a22dc8e: Configure provisioner SSH waits, creation backoff bounds, and machine check intervals through `provisioner.timings`, in seconds. Defaults preserve the existing wait and backoff durations, with machine checks every 24 hours.
- e13fcb6: Prune attention acknowledgements when overview entries disappear or change revision. Preserve current dismissals and Undo while removing obsolete records for repeated schedule failures and changing worker attempt counts.
- 794dd6e: Publish the operator HTTP API as an OpenAPI 3.1 document at the public `/api/openapi.json` endpoint. Add route descriptions, authentication requirements, and a generated HTTP reference to the documentation site.
- 56d4c04: Wait for all usine dependencies to resolve on npm before offering or starting a server upgrade. Retry registry propagation errors during installation, and record the rollback failure stage so automatic mode can retry install failures while continuing to skip health-check failures.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.
- f24b4a3: Preserve attention dismissals during startup until polling and schedule triggers each report a cycle. Overview refreshes then resume pruning obsolete dismissals.
- 34eae4d: Calculate worker utilization from slot counts in configuration revisions. Clarify that every second successful run of a loop on one item, including a rebase loop, counts against first time right.
- e57d084: Show item numbers, titles, and links on approval needs when their items are outside the board's item window.
- 8e49188: Show exe.dev attempts' GitHub label changes, comments, and reviews in the run reader. Match each attempt against its worker's bot identity and preserve operator board moves under the instance App.
  
  Recompute cached attribution when the configured worker identities change, including workers used by overlapping attempts.
  
  `GitHubItemHistory.appChanges` now requires the writer's `BotLogin` as its fourth argument, and `Operator.githubChanges` takes the current instance before the run ID. Removed workers have unknown writers, so the reader logs and omits their agent changes. exe.dev VMs share an integration bot; another VM's writes in the same attempt window can be attributed to the attempt.
- Updated dependencies [8cb790a]
- Updated dependencies [d1fd769]
- Updated dependencies [0536c26]
- Updated dependencies [a7692ae]
- Updated dependencies [fdecd7e]
- Updated dependencies [88eac4f]
- Updated dependencies [9e14070]
- Updated dependencies [9e14070]
- Updated dependencies [40a70c2]
- Updated dependencies [e59f7b8]
- Updated dependencies [6541e90]
- Updated dependencies [3fa96e0]
- Updated dependencies [dd88a31]
- Updated dependencies [4144c5f]
- Updated dependencies [d64b7c3]
- Updated dependencies [129d669]
- Updated dependencies [79174da]
- Updated dependencies [9ea42f2]
- Updated dependencies [1c1e516]
- Updated dependencies [59d6496]
- Updated dependencies [e3202dc]
- Updated dependencies [6d7f66f]
- Updated dependencies [9ea42f2]
- Updated dependencies [a22dc8e]
- Updated dependencies [93bbe77]
- Updated dependencies [79174da]
- Updated dependencies [24dc884]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [e13fcb6]
- Updated dependencies [d903ac6]
- Updated dependencies [06a10bf]
- Updated dependencies [56d4c04]
- Updated dependencies [9af38cb]
- Updated dependencies [f54b3bd]
- Updated dependencies [52c76fa]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [56e79a7]
- Updated dependencies [52c76fa]
- Updated dependencies [a22dc8e]
- Updated dependencies [98eb9cd]
- Updated dependencies [dfc713d]
- Updated dependencies [460d50b]
- Updated dependencies [7247fc9]
- Updated dependencies [1c1e516]
- Updated dependencies [4f37e20]
- Updated dependencies [5e4644e]
- Updated dependencies [8e49188]
- Updated dependencies [8e49188]
  - @usine/executor@0.5.0
  - @usine/core@0.6.0
  - @usine/config@0.5.0
  - @usine/agents@0.6.0
  - @usine/github@0.4.0
  - @usine/engine@0.6.0
  - @usine/expression@0.5.0
  - @usine/durable@0.2.1

## 0.4.0

### Minor Changes

- 8ea9f5b: The run page shows how many processes the kernel killed for memory in an attempt's containers on an SSH worker, and separately gives the memory limit of the last container with recorded kills, under the attempt's outcome (#600). Before, a command that needed more than `memory_mib`, such as Chromium or Vitest during `pnpm test`, was killed while the container kept running, and only the agent saw it.
  
  - Before the release removes an attempt's container, it reads the `oom_kill` count of the container's cgroup from `/sys/fs/cgroup/memory.events`, and counts one more for each start after the kernel killed the container's init, since a start gives the container a new cgroup. A count above zero is recorded through `Sink.outOfMemory` with the container's ID, and a warning logs it as `The kernel killed processes in the container for memory`. A reattachment runs the attempt in a new container, whose kills add to those of the earlier container. A count that can't be read or recorded is logged and doesn't stop the removal.
  - `@usine/core/attempt` exports `OutOfMemoryKills`, with `kills` and `memoryMib`, `ContainerOutOfMemoryKills`, which adds the `container` ID, `totalOutOfMemoryKills`, and `Attempt.outOfMemory`. `@usine/core/worker` exports `ContainerId`. `AttemptChannel.Sink` has `outOfMemory`, which takes one container's kills.
  - `RunStore.recordOutOfMemory` stores each container's kills in the new `out_of_memory_json` column of `usine_attempts`, and replaces the count of a container recorded before. `Attempt.outOfMemory` and `AttemptView.outOfMemory` add up the kills of the attempt's containers, with the memory limit of the last one, or return none and null.
- b3e696a: Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).
  
  - `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a stop that ends every process that a command started, including what it left running after it exited, a keepalive alarm that also keeps a held sandbox running, an image init that records the platform's SIGTERM, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex, only on the provider routes that the harnesses call. Each sandbox applies its credential changes one at a time and refuses credentials older than the ones it holds, so a delayed renewal can't undo a revocation. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
  - `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
  - `@usine/executor/cloudflare` creates a sandbox per attempt, checks the attempt's harness version in it before it grants credentials, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps and holds it until it reconciles or destroys it, drains an attempt within the platform's 15 minutes after SIGTERM by salvaging its checkout and failing it retryably, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions. Each child reports the outbound handler's API key as its credential, so a Codex child runs without a ChatGPT login check, and Claude Code and Codex children count in the API keys pool.
  - `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
  
  Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
- 9be864d: Two instance folders that share a GitHub App and an SSH worker machine no longer remove each other's attempt containers at startup.
  
  - `usine up` reads the instance ID from `.usine/instance-id`, and writes a new UUID there at its first start. A file that doesn't contain a UUID stops `usine up` with status 1 instead of being replaced, because with a new ID usine no longer removes the containers it left before.
  - Each attempt container gets the label `dev.usine.instance-id=<instance ID>` beside `dev.usine.instance=github-app-<App ID>`, and a process removes only the containers that have both its labels. A container that an earlier version left after a crash has no ID label, so no process removes it; remove such containers once with `docker rm`.
  - `@usine/core/instance` adds `InstanceId`. `SshExecutorOptions` requires `instanceId`, and `runtimeLayer` and `workerEngineLayer` in `@usine/orchestrator` take it after the instance directory.
- b2df567: An SSH worker's attempt containers get CPU, memory, and process limits derived from the machine for each limit that `workers[].container` leaves out of `usine.yaml`. Preflight reads the machine's CPUs (`nproc`), `MemTotal`, and the lower of `kernel.threads-max` and `kernel.pid_max`, subtracts a reserve for the machine's own processes (0.5 CPU, 1024 MiB, 1024 tasks), and divides by `max_concurrent_attempts`. A machine with 4 CPUs and 8 GiB gives each container 3.5 CPUs and 7168 MiB with one slot, and 1.16 CPUs and 2389 MiB with three. A value in `usine.yaml` still wins. A provisioned worker derives the limits for one attempt on its first machine each day, and its machines keep them until the next day's first machine.
  
  - `SSH Worker runs each Attempt in its own container` logs the limits each time the executor records them, including for a container started before any preflight on the worker, and `SSH Worker preflight verified` logs them at preflight, with `derivedLimits`, `slots`, `machineCpus`, `machineMemoryMib`, and `machineTasks`. The **Workers** page shows the limits that the last preflight applied and which ones it derived.
  - `WorkerContainer.cpus`, `memoryMib`, and `pids` in `@usine/config`, and the same fields of `SshWorkerAddress.container` in `@usine/executor/ssh`, are `Option`s; `None` derives the limit.
  - `PreflightReport` has `containerLimits`, and `MachineGrant.checked` is a `MachineCheck` with the checked brains and the limits. `@usine/core/worker` exports `ContainerLimits` and `CONTAINER_LIMITS`, the names of its fields.
  - `WorkerPreflight` keeps the last limits that a machine check applied, and `WorkerConfigurationView.containerLimits` returns them. `ContainerView` returns null for a limit that `usine.yaml` leaves out.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)). The operator API still answers a request body with an unknown key with 400 and `InvalidRequestError`, through `HttpApi.PayloadParseOptions` on its group. Effect 4.0 ignores the payload annotations that did this before.
- ac701f0: A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.
  
  The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.
  
  `@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.
  
  `StepExecutor.reserve` takes the run ID as its first argument.
  
  `WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
- 6388474: Record the time and configured operator of each failure resolution. Include resolutions in the failure-to-answer median, with separate retry and resolution figures, and refresh cached statistics after resolution. Preserve the first resolution across repeated requests and later retries.
- 7d338a2: `usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- d819599: Attempts commit as the GitHub App's bot account on every worker kind. Before, a local worker's commits took the identity in the operator's global git config, unless the agent passed one itself.
  
  `@usine/core/worker` adds `BotAccount`, a bot's `BotLogin` and `BotUserId`, with its ID-based noreply address in `noreplyEmail`. `GitHubApp.botAccount()` returns the App's bot account, read from `GET /users/<slug>[bot]` once per App slug; the bot's user ID differs from the App ID.
  
  `CheckoutRequest` requires `commitAuthor`. The local, SSH, and exe.dev executors set it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, which git prefers to `user.name` and `user.email` in any config. The values aren't secret, so remote workers export them in the command line and the machine's sshd needs no `AcceptEnv` change.
  
  The scheduler reads the bot account for each attempt and sets both `commitAuthor` and, on local and SSH workers, `botLogin` from it. If the account can't be read, the attempt fails before preparation: with an infrastructure failure, which is retried, or without a retry if GitHub refused, for example because the App has no installation.
- ceba675: Show the saved harness and model used by Retry and flag agent definition changes in run details. Edit and retry uses the current loaded definition, including when the task and agent name stay the same. Reject cancellation of failed and succeeded runs with a clear error while preserving repeated cancellation of canceled runs.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- 80f2eb6: **Discard leftovers** removes the Codex homes of the discarded attempts from an SSH worker that `usine.yaml` no longer declares. `StepExecutor` has a new required member, `discard(worker, attempts)`, which `RunEngine.discardLeftovers` runs after it stops tracking the attempts, and which never fails. The checkouts stay for the operator to remove.
  
  The SSH executor records how to reach each long-lived worker's machine when it adds the worker, in the new `SshExecutorOptions.workerRecordsDirectory`: its destination, port, identity file, and root, without secrets. `sshWorkerRecordsFor(directory)` from `@usine/executor/ssh` returns `discard`, which reads that record and removes `<root>/workers/<name>/codex/<attempt>` for each attempt over SSH. Without a record, or if the machine can't be reached, it logs that and removes nothing. The orchestrator records SSH workers in `.usine/ssh-workers/` in the instance directory and passes that `discard` to `StepExecutor` with every executor kind, so a discard still works after `usine.yaml` replaces the SSH workers with workers of another kind.
- 80f2eb6: An SSH worker no longer keeps the Codex home of an attempt that a crash ended. `Executor` has a new required member, `sweep`, which removes the files on the workers that no attempt holds or can use, and never fails. `StepExecutor.sweep` in the orchestrator's scheduler runs it before the sweep of provisioned machines, after startup recovery and at each reconcile.
  
  The SSH executor's sweep lists `<root>/workers/<name>/codex/` on each worker with its own machine and removes each Codex home whose attempt has no checkout there and that no attempt in this process holds. An attempt holds its Codex home from before the executor writes it until cleanup removes it, so a running attempt keeps its home, and so does a checkout that startup keeps for a reattachment. The local, exe.dev, and Cloudflare executors remove nothing.
- 3d54b01: Codex sessions now have a price. `SessionTokensUpdated` has an optional `breakdown` of input, cached input, cache write, and output tokens, which Codex children report. `@usine/agents/openai-prices` exports `openAiPrice`, which prices a breakdown at OpenAI's API rates for the models that the supported Codex CLI versions list.
  
  Run and task usage prices a Codex session that its harness didn't price from that table, marked as an estimate in the ChatGPT plan and not in the API keys pool. ChatGPT plan sessions that Pi prices keep Pi's figure, now shown as an estimate. A Codex model without rates stays unpriced and is logged once. The run page shows ChatGPT plan prices instead of `No dollar rate`.
- 4c63872: The orchestrator's requests to GitHub and to the gateways' admin APIs no longer send `traceparent` and `b3` headers. Neither service joins usine's traces, so the headers only exposed trace IDs. Each request still has a client span.
- b689685: Board items now include their GitHub state (`BoardItemLink.state`), so every view that lists an item can show whether it is open, closed, or merged.
  
  The web UI shows each issue and pull request the same way on every page: its GitHub icon and number in GitHub's state colour, linked to GitHub. A task is named after its earliest issue, or its pull request if it has no issue, with that item's number inline in the title. The run page, the run drawer, and the task page share one header. Run actions depend on the run's state: for a question from the agent, **Mark answered** is the primary action, and actions that apply less often are under **More actions**.
- 4c63872: `LoopFileView` adds `priority`, the loop file's queue priority, or null if it sets none. **Configuration** > **Loops** shows it on the loop's page.
- dfd0936: Polling fetches an open pull request again only when change detection reports it, its base branch head moved or can't be read, or its `mergeable` is `UNKNOWN`, instead of on every poll. Each poll reads each base branch head with one conditional request. `GitHubPolling` adds `baseRefHead`, `@usine/github/polling` exports `BaseRefName` and `BaseRefHead`, and `PullRequestPayload.baseRefName` is a `BaseRefName`.
- cd25ce0: The operator API adds `GET /api/statistics?window=7d|30d|all` (30 days by default), which computes from the stored runs, their usage, and the stored items how the factory ran in the window: closed runs by outcome, loop, agent, and harness, model, and effort; run and attempt time with median and 90th percentile beside the mean; tokens per pool and the cost of priced runs; runs closed per day; first-pass merges and lead time to merge; queue wait, attempts per run, and slot use per worker; and Needs attention entries with their waits. `RunReader.closedSince` reads the runs closed since a time.
  
  The overview ends with a Statistics section that shows these as figures and charts, with a switch between 7 days, 30 days, and all runs.
- b6f6afe: `GET /api/statistics` now returns the tasks done in the window, a task being done when its pull request merges: each task's time from its first run to the merge with the median, the split of task time between the loops' attempts and waiting, each loop's median run time, the share of tasks with no second round, the operator actions per task, and the tokens per task by loop, with a cost only when every session has a price. The run statistics move to `GET /api/statistics/runs`, which reports medians only.
  
  The Statistics section now leads the overview with four blocks: Tasks done, Time per task, First time right, and Tokens per task. The run statistics sit behind a collapsed Details disclosure and load when it opens.
- 962517f: Refresh open pull requests while check rollups are pending or expected, including absent rollups on blocked pull requests. Polling observes completed checks without waiting for a pull request update or base-branch movement.
- 4c63872: `Waiting for a free worker slot, behind N runs` counts the fewest runs that take a worker slot first, so the count doesn't overstate with several workers. A run that waits for a slot on its reattached attempt's worker counts only on the open worker with the fewest such runs: it no longer counts while another worker has none, and it still counts when every worker has one. `QueuedRun` adds `ahead`, which the desk now reads instead of the run's index in `WorkerStatus.queue`, and the `Run waits for a worker slot` log uses the same count.
- 5bc5cf5: The Board places a running card by its Item's current labels first. While a Task's newest open Run is `Running` and its current Item is open, the card goes to the first label lane that matches the Item's current labels, so a card moves to In progress as soon as `start-dev` swaps `ready-for-agent` for `agent-in-progress`. The card stays in the lane its Run's trigger matched, read from the Run's Event, only if the current labels match no label lane, for example after a Loop removes its trigger label and sets no other. The Task page names the same lane, and a Board move records the lane the card showed in.
- f01e5f2: Salvage commits and salvage rebases are authored and committed by the attempt's `commitAuthor`, the GitHub App's bot account, on every worker kind. Before, they used `usine <usine@basaltbytes.dev>`, which no GitHub account owns. The executor's git commands on a checkout now set the same `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables as the attempt's children.
  
  `Executor.recover` takes a third argument, `commitAuthor`: an effect that returns the salvage commit's author. It runs only before a salvage, so removing the checkout of a succeeded or `read` attempt doesn't read it, and its failure leaves the checkout for a later reconciliation. The orchestrator passes the App's bot account.
- 4c63872: A board card no longer shows the failure note, run line, or **Retry** of a failed run on an issue that is closed or a pull request that is closed or merged. `BoardTaskView.run` now prefers a run that needs the operator by the same check as `needsYou`, so such a run gives way to the task's open run. The run keeps **Retry** on the task page and the run page.
- 770b9a4: A failed run on an issue that is closed or a pull request that is closed or merged no longer sets the project's status to `needs-you` or marks its board card and task as needing attention. The project status, the card, the task, and Needs attention now use the same check, so a project no longer shows `needs-you` with an empty Needs attention list.
- 2183c07: An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.
  
  - The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus`, `memory_mib`, and `pids` limit each container.
  - It mounts only the attempt's checkout and the SSH user's harness login files read-write, and its cached clone and credential directory read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
  - Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
  - The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
  - Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. Only a machine without Docker, whose SSH user has no Docker access, runs attempts as the SSH user; preflight reports the worker as degraded in the log, on the Workers page, and on the desk. With Docker, a Docker that doesn't answer fails preflight.
  - A file outside every container's mounts records each checkout that a container had, so a reattachment or recovery never runs git in it as the SSH user, whatever the attempt changed in the checkout. A checkout from before Docker on a machine that now has it, or a container's checkout on a machine that no longer has Docker, is refused and left for the operator.
  
  `Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.
- 40be06c: A task's time in the overview statistics now ends at its last run's close instead of its merge, so the wait for the operator to merge a ready pull request is left out. A run still open at the merge counts until the merge. The time split per loop uses the same span.
  
  The median price of a task now covers the tasks whose sessions all have a price, instead of disappearing when one session lacks a price. `TaskCostView` has the count of priced tasks in `tasks`. The overview shows the median price beside the median time in usine, and the line under the blocks counts the tasks left out of it.
- 905bbc4: Cache task and run statistics per window for up to five minutes. Repeated requests reuse computed views while the instance and store revision remain unchanged. Run closure, retry, close-time changes, and item or budget updates invalidate the cache. Concurrent requests share computation, and debug logs report hits and misses.
- a55ab58: Each run is now a trace of its own: its root span, `RunDriver.drive`, links to the span that launched the run, such as a poll cycle or an approval request. The **Settings** configuration page shows the `tracing` block, and a reload refused for a changed `tracing` block links to it. A malformed `OTEL_RESOURCE_ATTRIBUTES` now stops `usine up` with a message that names the key, instead of crashing it. The web UI no longer sends trace headers.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.
- a5ed825: Fixes a canceled attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt could start on that worker beside the task. The attempt now keeps its run's slot, also after its execution acquired the checkout and without a restart. Each reconcile retries the stop and frees the slot once the stop succeeds. After a restart, startup still occupies a slot for each closed attempt whose stop it can't confirm.
  
  `RunEngine.cancel` moves the slot of the run's fiber to the attempt before it stops the parent task. `UnconfirmedStops` in `@usine/engine/engine` lists the attempts whose stop the engine retries, and `UnconfirmedStops.empty` lists none; `OperatorObservation` requires it. **Needs attention** shows each attempt as an `UnconfirmedStopNeed`, **\<loop\>: parent task not stopped**.
- 4c63872: **Needs attention** no longer lists the approval or failure of a run in a repository that `usine.yaml` no longer lists. Such a repository has no project, so the entry had no project status to match.
- Updated dependencies [1f7b315]
- Updated dependencies [9be864d]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [2f78d3a]
- Updated dependencies [1514af9]
- Updated dependencies [ceba675]
- Updated dependencies [392e165]
- Updated dependencies [b3e696a]
- Updated dependencies [80f2eb6]
- Updated dependencies [80f2eb6]
- Updated dependencies [4942c44]
- Updated dependencies [113d150]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [4ef6777]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [bf21f9c]
- Updated dependencies [dfd0936]
- Updated dependencies [cd25ce0]
- Updated dependencies [d82c6cd]
- Updated dependencies [266986a]
- Updated dependencies [4c63872]
- Updated dependencies [ac701f0]
- Updated dependencies [9077f43]
- Updated dependencies [6388474]
- Updated dependencies [4c63872]
- Updated dependencies [afbac5c]
- Updated dependencies [f01e5f2]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [9827419]
- Updated dependencies [7d338a2]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [a55ab58]
- Updated dependencies [e5d9dcb]
- Updated dependencies [a5ed825]
  - @usine/agents@0.5.0
  - @usine/config@0.4.0
  - @usine/core@0.5.0
  - @usine/durable@0.2.0
  - @usine/engine@0.5.0
  - @usine/executor@0.4.0
  - @usine/expression@0.4.0
  - @usine/github@0.3.0

## 0.3.0

### Minor Changes

- d866d8f: Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.
  
  Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- f060b57: Removes `updatedAt` from `BoardTaskView` in `@usine/orchestrator/operator`. Remove the field from code that constructs a `BoardTaskView`.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- a386108: Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.
  
  On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- 56ce81e: Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.
  
  `@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
- 0799f4f: The exe.dev worker runs its Pi parent in the orchestrator as a durable task and its Claude Code and Codex children on the VM over SSH, so an exe.dev attempt reattaches after an orchestrator restart instead of failing. A Pi brain is unavailable on exe.dev.
  
  `@usine/executor/exe-dev` requires an `AttemptRuntime` and no longer launches the run host: it removes `ExeDevExecutorOptions.runHost`, `RunHostCommand`, and the `run-host` worker capability, and `ExeDevExecutorOptions.ssh` takes an `SshCommand` from `@usine/agents/child-host`. Preflight runs the `@usine/agents/preflight` checks on the VM over SSH, and the `@usine/orchestrator/exe-dev` `layer` requires an `AttemptRuntime`.
- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- 3088f0e: Before a queued event opens a run, the engine rechecks whether the loop's trigger still matches the item through the new `TriggerCondition` port (`@usine/engine/trigger-condition`), which `layerWithDatabase` and the local SQLite layer require. An event that no longer matches is revoked, and a check that can't complete opens the run as before.
  
  The orchestrator rechecks against a fresh GitHub snapshot, so a run that pushes a commit and then swaps its trigger labels no longer starts a second run.
- 39f8d4b: Loops, agents, and the `labels`, `repos`, `settings`, and `operator` keys of `usine.yaml` reload without a restart; new runs use the new configuration, and an open run keeps its agent. An invalid `usine.yaml` fails the reload with `FactoryConfigError`, a changed `workers` or `webhooks` block fails it with `RestartRequiredError`, and both keep the running configuration.
  
  `@usine/orchestrator/current-instance` exports `CurrentInstance`, whose `reload` returns an `InstanceReload` of what changed, and the operator API adds `POST /api/instance/reload`. `Orchestrator.run`, `PollingTriggers.run(current)`, `ScheduleTriggers.run(current)`, `runtimeLayer(instanceDirectory)`, `triggerConditionLayer`, `gitHubCredentialLayer`, and the worker layers read the instance through `CurrentInstance` instead of taking a loaded instance.
- 419bbd7: An accepted reload starts the next poll cycle at once, but still waits for a time GitHub asked for, such as a rate-limit reset. If the reload adds a brain that no running agent has, it preflights that brain on every worker first, and a failure rejects the reload with the new `ReloadPreflightError`, which names the agents.
  
  `CurrentInstance` adds `changes`, a stream of snapshots, and `registerPreflight`, which `stepExecutorLayer` calls with its worker preflight. `PollingTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance.
- af28e0e: A refused `POST /api/instance/reload` returns the refusal's typed fields with `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). The Configuration section lists what the refusal names, each linked to its page.
  
  `@usine/orchestrator/operator/http` exports `RestartRequiredRefusal`, `ReloadPreflightRefusal`, `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, and the derived client decodes a refused reload into one of them.
- 425e240: An accepted reload evaluates new or changed schedule loops at once instead of up to a minute later. `ScheduleTriggers.run` takes the `get` and `changes` of a `CurrentInstance`, like `PollingTriggers.run`.
- ba8e26f: A reload applies `workers` changes without affecting running attempts. A higher `max_concurrent_attempts` preflights the new slots and lets them take waiting runs at once, a lower one retires extra slots as their attempts end, a new worker of the executor's kind takes attempts once preflight passes (the SSH composition re-adds only workers it started with), and a removed worker leaves the scheduler after its last attempt. A changed kind or setting, a renamed worker, or a new worker that the executor can't run still fails the reload with `RestartRequiredError`.
  
  `RestartRequiredError` adds `fields` (such as `workers.build-1.destination`), `ReloadPreflightError` adds `workers` and allows empty `agents`, and `InstanceReload` adds `workers`. `CurrentInstance.registerWorkers`, which takes a `WorkerReload`, replaces `registerPreflight`, and `stepExecutorLayer` takes `StepExecutorOptions` with `startupWorkersOnly`.
- 2fc760a: Renames the item-level hold to suppression, so hold means only the session hold. In `@usine/engine/engine`, the `Held` submission result becomes `Suppressed`, and in `@usine/engine/run-reader`, `LoopSighting.heldBy` becomes `suppressedBy`. In `@usine/orchestrator/operator`, `HeldForOperatorView` becomes `SuppressedForOperatorView`, whose tag is `SuppressedForOperator`. A migration renames the `usine_loop_items` columns `held_by_run_id` and `held_event_id` to `suppressed_by_run_id` and `suppressed_event_id` and keeps their values.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- cba7d35: Operators can run a succeeded or canceled run again. `RunEngine.runAgain` takes a `RunAgainRequest` and records a new event for the run's item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`; it returns `Claimed` or `CycleBlocked`, and fails for a run in another state or while another run of the loop is open on the item.
  
  Adds `canRunAgain` to `RunState.operatorActions`, `RunAgain` to `@usine/core/run/again`, the `usine_run_again_events` table, `runAgain` to `RunSnapshot`, `RunSummary`, and `RunView`, `Operator.runAgain` with the new `LoopNotFoundError`, and `POST /api/runs/:runId/run-again`. The drawer and run page offer **Run again** and **Edit and run again** on succeeded and canceled runs.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- ec5c4d4: Adds `BoardMoves` to `@usine/engine/board-moves`, which records the operator's board moves in the new `usine_board_moves` table. `Operator.moveBoardItem` records each move before it sends the label swap, and `Operator.githubChanges` lists a matching label change as a `BoardMovedView`, so the run page shows it as the operator's move.
  
  Moves made before this change still show as the agent's label changes.
- cef956c: Adds `GitHubItemHistory.appChanges(repository, item, since)` to `@usine/github/item-history`, which returns the App's label changes, comments, and reviews on an item as `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`; `Installation` adds `appSlug`. `Operator.githubChanges(runId)` returns each attempt's changes as `RunGitHubChangesView` at `GET /api/runs/:runId/github-changes`, which returns 404 `GitHubItemNotFoundError` for an item that GitHub no longer has.
  
  The run page shows each label change, comment, and review that an agent made on the item where it happened.
- b99cdc8: While a task's newest open run is `Running` and its item is open, the board keeps its card in the first label lane that matches the item's labels when the trigger matched. A loop that removes its trigger label first, such as `review-pr` removing `ready-for-review`, no longer moves its card to a state lane while it runs.
  
  `projectBoard` takes the running runs' events as an optional last argument, and the error type of `Operator.moveBoardItem` includes `RunStoreError`.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 40194a0: The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.
  
  `AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".
- 34dec09: Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.
  
  The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
- f060b57: Adds `closedAt` to `RunView` in `@usine/orchestrator/operator`, which the desk's last outcomes use, and `usage` to `BoardTaskView`: a `TaskUsageView` with the task's wall time, tokens, and dollars per billing pool (`TaskPoolUsageView`). A pool's `unpriced` flag marks its `cost` as a lower bound, and `RunUsageReader.read` accepts a run summary as well as a snapshot.
  
  Add the new fields to code that constructs `RunView` or `BoardTaskView`.
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- af28e0e: `Operator.detail` caches the token reports of ended attempts in memory until the orchestrator restarts. Each poll from the run page and drawer reads only the running attempt.
- 9464a41: Repository names in `usine.yaml` and loop selectors, and board lane labels, match case-insensitively, as on GitHub. `usine.yaml` rejects repos or selector entries that differ only in case, and lane `label` sources that differ only in case count as one.
- 81c048b: `StepExecutor.execute` takes an `ExecutionSink`: the attempt's channel sink and `checkoutAcquired`, which the executor runs once preparation acquires the checkout. Until then, the engine reconciles a checkout that a restart kept for reattachment: canceling the run records the salvage and removes the checkout, and a failed reattachment reconciles it before the failure is recorded.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- ebfb373: A deleted or transferred issue that the queued-event recheck finds missing leaves the board's open lanes. `TriggerCondition.recheck` replaces `TriggerCondition.holds` and returns a `TriggerRecheck` from `@usine/engine/trigger-condition`: `matches`, `no-longer-matches`, or `item-gone`.
  
  For the last two, the engine revokes the item's queued events, and for `item-gone` it also calls `ItemProjectionWriter.markGone`. An adapter that can't tell returns `matches`, as it returned `true` before.
- 291d428: At most every 10 minutes per repository, the poll marks deleted or transferred issues as gone, removing their cards from the board's open lanes and revoking their unstarted runs.
- 3ed742f: An open pull request that GitHub no longer has leaves the board's open lanes. The poll calls the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the item's projection until a later poll sees the item again, and the board places a gone item by its closed state; a migration adds `gone_at` to `usine_item_projections`.
- 8a0bcc1: An `if:` that fails to evaluate on an item no longer stops the repository's poll: the failure affects only that loop and item, and the cursor advances. **Needs you** lists `if:` and prompt failures with their loop and item while they last, and the first poll after a restart evaluates failing items again.
- af28e0e: `RunReader.closed({ limit })` returns the `limit` most recently closed runs, newest first, regardless of when they opened. The overview's **Last outcomes** uses it, so it lists a run that opened long ago and closed recently.
- 564449d: An open pull request or failing item that GitHub no longer has no longer stops its repository's poll. The poll logs a warning, drops the item from the cursor, and revokes its unstarted runs; `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the item is missing or GraphQL reports `NOT_FOUND`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d0944ca: Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- 72d0fae: A queued event's trigger recheck gives up after five seconds with a warning, and the event proceeds.
- 8c6a3aa: `/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.
  
  `ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.
- 3ed742f: The queued-event recheck no longer opens a run for an item that GitHub no longer has. On `GitHubItemNotFoundError`, `TriggerCondition.holds` returns `false` and the item's queued events are revoked; a failed request or a recheck over five seconds still opens the queued event.
- ca2e7a5: If GitHub refuses to mint an attempt's token, the attempt fails with GitHub's reason, without a retry; outages and rate limits are retried.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- 3f13b80: `StepExecutor.reserve` takes `worker: Option<WorkerName>`. With a worker, the lease comes only from that worker, and the scheduler serves the reservation before unnamed ones without blocking runs that another worker can take.
  
  `StepExecutor` adds `occupy(worker)`, which takes a slot at once for an attempt already running on the worker, even beyond `max_concurrent_attempts`, and logs a warning in that case.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- ff148e0: Retries a failed exe.dev credential grant renewal every minute until it succeeds, and sizes the grant window independently of `max_attempt_minutes`. The run drawer shows the last salvage failure of a retained worktree, which every startup retries; the recorded failure includes git's stderr and names a stalled push instead of a bare `TimeoutError`.
- 7853f53: A reload can add an SSH worker and reads its gateway's admin token before preflight; an unset token variable refuses the reload. A removed SSH worker leaves after its last attempt.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
- d98bef0: Worker preflight checks the machine's memory against `max_concurrent_attempts`, and `Executor.preflight` takes `maxConcurrentAttempts` as a third argument. Preflight fails with the new `memory` capability below 1.5 GiB per concurrent attempt, or with no swap and more than one concurrent attempt, and warns below 3 GiB per concurrent attempt.
- Updated dependencies [a3a230c]
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [efdcf43]
- Updated dependencies [b36ffc7]
- Updated dependencies [6672585]
- Updated dependencies [9464a41]
- Updated dependencies [9739f3a]
- Updated dependencies [425e240]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [ca2e7a5]
- Updated dependencies [7a6d96f]
- Updated dependencies [b928d0d]
- Updated dependencies [499dd2c]
- Updated dependencies [e518906]
- Updated dependencies [759db71]
- Updated dependencies [8292038]
- Updated dependencies [0799f4f]
- Updated dependencies [14c2d3c]
- Updated dependencies [d3942c0]
- Updated dependencies [d039c91]
- Updated dependencies [0799f4f]
- Updated dependencies [81c048b]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [7db1cae]
- Updated dependencies [425e240]
- Updated dependencies [66f6b0b]
- Updated dependencies [eedf20c]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [3ed742f]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [81c048b]
- Updated dependencies [af28e0e]
- Updated dependencies [23e8f15]
- Updated dependencies [91e2b70]
- Updated dependencies [291d428]
- Updated dependencies [564449d]
- Updated dependencies [32cf39b]
- Updated dependencies [291d428]
- Updated dependencies [75a4fcf]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [4d4c6bd]
- Updated dependencies [5870baf]
- Updated dependencies [562ba5f]
- Updated dependencies [0dac1bd]
- Updated dependencies [8c6a3aa]
- Updated dependencies [99164fa]
- Updated dependencies [3f13b80]
- Updated dependencies [b601259]
- Updated dependencies [3088f0e]
- Updated dependencies [6d70b40]
- Updated dependencies [2729e91]
- Updated dependencies [81c048b]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [7a5249f]
- Updated dependencies [2fc760a]
- Updated dependencies [d799713]
- Updated dependencies [3f13b80]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [f966404]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [f060b57]
- Updated dependencies [8f43ed7]
- Updated dependencies [6764fa7]
- Updated dependencies [ec5c4d4]
- Updated dependencies [b99cdc8]
- Updated dependencies [cef956c]
- Updated dependencies [466e711]
- Updated dependencies [1877119]
- Updated dependencies [ff148e0]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [7853f53]
- Updated dependencies [ba8e26f]
- Updated dependencies [761099a]
- Updated dependencies [dda5892]
- Updated dependencies [6714868]
- Updated dependencies [d933ab6]
- Updated dependencies [32651fd]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
- Updated dependencies [d3942c0]
- Updated dependencies [fcd3671]
- Updated dependencies [425e240]
- Updated dependencies [d98bef0]
- Updated dependencies [8665053]
  - @usine/config@0.3.0
  - @usine/core@0.4.0
  - @usine/durable@0.1.0
  - @usine/executor@0.3.0
  - @usine/engine@0.4.0
  - @usine/expression@0.3.0
  - @usine/github@0.2.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/executor@0.2.1
  - @usine/run-host@0.3.0
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 485f244: Starts PR-triggered attempts at the event's exact head commit.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- e7adbd8: Derives operator actions from the run lifecycle rules.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [3db806c]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [410607d]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [7dc019e]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/executor@0.2.0
  - @usine/run-host@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.
- 05937b8: Adds schedule triggers with IANA time zones, one tick per repository, and catch-up of the latest missed tick.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [24eef02]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [7bd5cdb]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/engine@0.1.0
  - @usine/executor@0.1.0
  - @usine/run-host@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
