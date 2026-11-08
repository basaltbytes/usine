# @usine/engine

## 0.7.0

### Minor Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 25728fa: Allow a boolean CEL condition to require approval per run. Save and display the
  approval decision, require approval when evaluation fails, and validate conditions
  in the loop editor and configuration API.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
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
- acbf702: Compress ended attempts' SQLite transcripts in background segments while preserving transcript reads, pagination, and late messages. Report sealing failures with attempt diagnostics and skip malformed rows until restart. Require the transcript codec explicitly in SQLite compositions. Create compact runtime backups that omit freed database pages and sync them to disk before reporting success.
- 69ba086: Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.
- 81330c9: Show whole pull request and recorded attempt changes on task pages with collapsed file diffs, change counts, and CI and review state. Add a project-scoped files API and commit-based caching, with explicit reporting for missing and truncated GitHub patches.
  
  Keep recorded attempt changes available after failed or canceled CI waits, including when a later retry succeeds.
  
  Backfill older comparisons only when their producing attempt is identifiable, and let each attempt's completion replace an existing backfilled result.
  
  Classify generated files by path to avoid marking hand-written files whose patches mention generated-file markers.
- 0e34ec1: Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.

### Patch Changes

- e0cedc8: Classify pending CI deadlines as infrastructure failures and report running jobs with elapsed times and previous successful durations when available. Bound diagnostic reads so a stalled request cannot prevent timeout settlement.
- b7ff637: Report Claude Code subscription allowance windows for the Claude plan pool. Five-hour and seven-day utilization reports update pool health and Needs attention warnings, preserving the latest observation of the other window across children and attempts. API-key sessions do not update Claude plan windows.
- 01467e3: Reduce overview responses with compact board run summaries and a bounded recent run list. Preserve all board cards, task totals, and Needs attention entries. Load complete board run history when its menu opens.
  
  Read polling metadata without prompts, results, or comments. Select current board runs with SQL windows and aggregate historical counts, timing, and loop states in storage.
- e007d09: Use explicit finite number schemas for numeric fields and update the operator API schema. Apply Effect's safe rewrites for schema construction, decoding, and layer composition.
- 2482038: Speed up run history, board reads, and CI wait reconciliation with runtime store indexes.
- 82b55aa: Show a dismissed cycle-budget entry again when a later event is blocked on the same item, and display the most recently blocked loop. Preserve dismissals during repeated polling of the same blocked events and keep the ask's reset identity unchanged.
  
  Add `CycleBudgetBlock`, `CycleBudgetAsk.blocks`, `recordBlock`, and `blockedLoop` to record the latest refused event per loop. Older asks decode with an empty block list.
- 9786f67: An attempt whose CI pull request can't be verified now fails with the reason in its message. A handed-off head that differs from the checkout, a pull request that origin doesn't have or that comes from another repository, and a branch that isn't at the pushed head are agent failures. A GitHub read that still fails is a retryable infrastructure failure.
  
  The pull request read during harvesting retries twice, on the same schedule as the GitHub polling reads, and logs the branch's commit on origin against the pull request's head on GitHub.
  
  A loop with a CI policy whose agent ends without a handoff now verifies the open pull request of the checkout's branch on origin and uses branches on origin at HEAD for detached checkouts. When only pull request refs match, it uses GitHub's commit-to-pull-request index. An unchanged detached checkout from a branch or tag revision fails as an agent failure instead of waiting on an unrelated pull request.
  
  For a detached fixed-commit checkout, indexed pull requests from a fork now fail with `RepositoryMismatch`. When an origin branch matches the detached HEAD but has no open pull request, verification fails with `PullRequestNotFound` even if a matching pull request ref is also on origin. The commit index is queried only when no origin branch matches.
  
  A plain success whose GitHub or git verification read fails now records an `InfraFailure` instead of an `AgentFailure`. This includes persistent authorization failures such as HTTP 403, so the attempt can run up to three times. A local branch pushed under a different remote name fails with `BranchNotAtHead`; an explicit handoff verifies the pull request's source branch independently of the local branch name.
- 7e5bb5b: Record accepted CI fixes as neutral handoffs with links to the continuing run. Keep source runs out of failure statistics and Needs attention when a fix run continues the work. Task lists and board cards show the fix run's status. Unavailable fix loops, refused events, exhausted budgets, and CI timeouts still require attention.
  
  Preserve pending completion actions across CI fix runs and apply them with the final successful head’s actions.
- f632c1b: Verify a loop's outcome labels from the run's label events on GitHub. An outcome label added during the run counts across retries even if another loop removed it before the attempt settled, and a label left from an earlier run doesn't count. usine checks the item's current labels only when it can't read the label events.
  
  Retry outcome label reads after timeouts, transport failures, server errors, and other failures except definite refusals or a missing item. Verify each completion once, skip the check when the run doesn't record the success, and keep a rejected report's message and facts on the failed attempt.
  
  `CompletionCheck` moves to `@usine/engine/completion-check` and becomes a required service with a `verify` method. Hosts that don't verify outcome labels provide `CompletionCheck.unverified`.
- d740598: Forward parent steers to the single live child and record the receiving child in delivery receipts. Require a separate parent turn when a steer cannot be delivered, including after a restart. Withdraw unread guidance on interruption and keep the parent paused until new guidance or release. Show forwarding, parent delivery, and unread steers in the run transcript.
- 973b47b: Serve the version endpoint before startup recovery so instances with long attempt histories pass upgrade health checks. Cache SSH checkout listings per connection, avoid connection records for finished attempts without checkouts, and log reconciliation progress at Info.
- 5796627: Verify explicit CI handoffs against the pushed origin branch when GitHub's pull request head is stale. Keep CI pending until the PR head catches up, and classify unverified handoffs as retryable infrastructure failures.
- 4d60236: Record kernel task names and host PIDs for processes killed by attempt container memory limits. Show available process details and missing-detail counts below attempt outcomes, and report memory kills and repeated kills beside first-time-right statistics. Older records retain their kill counts with empty process lists.
  
  Serialize the repository check and build tasks to fit the worker memory limit, matching the existing test command. Document gate memory requirements and host kernel-log permissions.
- d0900a3: Log routine pool reset scheduling decisions at Debug to keep transcript appends quiet at the default log level. Keep reset deadline notifications at Info.
- 6e725ad: Centralize SQLite query expressions and add reusable persistence contract tests for adapter implementations. Existing storage behavior and migrations remain unchanged.
- 87aeb52: Log per-report session usage and pool rate-limit projection updates at Debug to reduce Info log volume.
- 45bb9cb: Keep worker slots free while an idle upgrade defers new attempts. Show the requested version on deferred runs and worker rows, and report prolonged waits in Needs attention. Cancel a pending upgrade from Settings or with `DELETE /api/upgrade` to resume attempts without restarting.
- d5fb58b: Replay blocked CI fix events after a cycle-budget reset without requiring a trigger label. Recheck the recorded PR head before admission and preserve failure diagnostics and completion actions across restarts. Keep paused fixes queued until their loop resumes.
- d0900a3: Restore pool reset notifications from persisted reports after restart. Refresh task details and history menus when any linked item changes.
- de42ea4: Run standalone SQLite reads on a read-only worker connection so long queries permit transcript appends and HTTP responses to continue. Preserve main-connection transactions and reserved operations, and report p99 and maximum event-loop delay every minute while the server runs.
  
  Recover from read worker failures by routing later reads to the main connection, restarting the worker with bounded backoff, and reporting its state through `/api/health`.
  
  Read run summaries, their attempts, evidence, and board history aggregates in scoped read-only worker snapshots. Preserve consistent lifecycle states during concurrent completion and retries while transcript appends and HTTP responses continue. Roll back interrupted snapshots; use the main connection during worker recovery and within write transactions.
- e3cddea: Release completed API response bodies retained by SQLite's prepared-statement cache. Preserve SQL trace relationships while preventing cached lookup fibers from retaining request spans.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- d0900a3: Refresh open task details and history when newly linked items change task membership or cycle-budget asks change attention state.
- fbd379a: Read transcript usage and pool limits from summaries updated atomically on append, and index worker and session-state reads. Backfill existing transcripts during startup without rebuilding the transcript table.
- d0900a3: Publish web change notices after committed writes. Idle connections send heartbeats without rebuilding overview, desk, or configuration projections. Filter live notices and bounded replay by project access.
  
  Refresh open statistics at UTC midnight as rolling windows advance.
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

- 9e14070: Store authored configuration in the runtime database with atomic revisions, validation, and live updates. Import the instance folder once, and add `usine config export`, `import`, `edit`, and `log` for running and stopped instances. Reject stale edits and invalid imports without saving a revision.
  
  Share the runtime database connection between the engine and configuration store.
- 6d7f66f: Require a member session or instance token for operator API requests, including requests from loopback. Add GitHub browser and device sign-in, one-time setup links, local admin tokens, member management, token revocation, and browser CSRF checks. Attribute operator actions and configuration revisions to the signed-in member. Convert stored GitHub ask approvals to the UI channel while preserving their approvers.
  
  Existing instances must configure GitHub App user authorization to use GitHub sign-in. Run `usine sign-in-link` on the instance machine for access before those settings are configured.
  
  Keep the version health endpoint public so existing upgrade helpers can verify the first release with member authentication.
- 7bf348a: Add projects with ordered repository membership, shared lanes, and project-owned loops. Scope trigger execution to each project and expose projects through configuration and operator APIs.
  
  Migrate existing configuration and runtime loop references together, preserving runs, pauses, suppression, cycle budgets, and attention acknowledgements. Export version 2 project folders, accept legacy imports, and keep unique short loop names and single-repository editors working.
- e13fcb6: Prune attention acknowledgements when overview entries disappear or change revision. Preserve current dismissals and Undo while removing obsolete records for repeated schedule failures and changing worker attempt counts.
- d903ac6: Add Dismiss and Undo to Needs attention. Dismissals persist with the operator and time, exclude matching entries from attention counts and badges, and show under Dismissed on the overview. Changed entries appear again. Dismissing preserves run actions and cycle budgets.
- f54b3bd: Show Needs attention warnings when a pool's latest reported rate window reaches 80% and has a future reset. Include the recorded login, percentage, and reset time, with Dismiss and Undo. Clear warnings when a newer report recovers or the window resets, independently of scheduling.
  
  Expose the latest stored snapshot per pool through `RunReader.latestPoolRateLimits()`, with a partial index on the existing transcript table.

### Patch Changes

- dd88a31: Document the engine public API, including stored records, service operations, and database layers.
- e3202dc: Rename the member approval migration and update existing SQLite migration ledgers without applying it again.
- 9ea42f2: Block new attempts across all loops on an item before requesting a parent stop. Keep the block until the stop succeeds, recheck it after a worker slot becomes available, and show stops from other loops in the overview and run detail.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 52c76fa: Show workers with three consecutive unanswered probes in Needs attention, with the last answer time and links to affected runs. Keep worker status visible beyond recent transcript pages, clear recovered workers even after an orchestrator restart, and recheck memory on slot reductions during reload.
  
  Distinguish a worker's first confirmed answer from outage recovery in the transcript and its checkpoints.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
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

- 8ea9f5b: The run page shows how many processes the kernel killed for memory in an attempt's containers on an SSH worker, and separately gives the memory limit of the last container with recorded kills, under the attempt's outcome (#600). Before, a command that needed more than `memory_mib`, such as Chromium or Vitest during `pnpm test`, was killed while the container kept running, and only the agent saw it.
  
  - Before the release removes an attempt's container, it reads the `oom_kill` count of the container's cgroup from `/sys/fs/cgroup/memory.events`, and counts one more for each start after the kernel killed the container's init, since a start gives the container a new cgroup. A count above zero is recorded through `Sink.outOfMemory` with the container's ID, and a warning logs it as `The kernel killed processes in the container for memory`. A reattachment runs the attempt in a new container, whose kills add to those of the earlier container. A count that can't be read or recorded is logged and doesn't stop the removal.
  - `@usine/core/attempt` exports `OutOfMemoryKills`, with `kills` and `memoryMib`, `ContainerOutOfMemoryKills`, which adds the `container` ID, `totalOutOfMemoryKills`, and `Attempt.outOfMemory`. `@usine/core/worker` exports `ContainerId`. `AttemptChannel.Sink` has `outOfMemory`, which takes one container's kills.
  - `RunStore.recordOutOfMemory` stores each container's kills in the new `out_of_memory_json` column of `usine_attempts`, and replaces the count of a container recorded before. `Attempt.outOfMemory` and `AttemptView.outOfMemory` add up the kills of the attempt's containers, with the memory limit of the last one, or return none and null.
- 80f2eb6: **Discard leftovers** removes the Codex homes of the discarded attempts from an SSH worker that `usine.yaml` no longer declares. `StepExecutor` has a new required member, `discard(worker, attempts)`, which `RunEngine.discardLeftovers` runs after it stops tracking the attempts, and which never fails. The checkouts stay for the operator to remove.
  
  The SSH executor records how to reach each long-lived worker's machine when it adds the worker, in the new `SshExecutorOptions.workerRecordsDirectory`: its destination, port, identity file, and root, without secrets. `sshWorkerRecordsFor(directory)` from `@usine/executor/ssh` returns `discard`, which reads that record and removes `<root>/workers/<name>/codex/<attempt>` for each attempt over SSH. Without a record, or if the machine can't be reached, it logs that and removes nothing. The orchestrator records SSH workers in `.usine/ssh-workers/` in the instance directory and passes that `discard` to `StepExecutor` with every executor kind, so a discard still works after `usine.yaml` replaces the SSH workers with workers of another kind.
- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/sql-sqlite-node` 4.0.6 and on `drizzle-orm` 1.0.0-rc.5, whose Effect integration imports `effect/sql` ([#494](https://github.com/basaltbytes/usine/issues/494)).
  
  When `.usine/runtime.sqlite` can't be opened, the layers of `@usine/engine/local-sqlite` fail with `EnginePersistenceError`, such as `open local database`, and `backup` fails with a `RuntimeStoreBackupError` whose `operation` is `open`. Before, they died with SQLite's error.
- ac701f0: A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.
  
  The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.
  
  `@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.
  
  `StepExecutor.reserve` takes the run ID as its first argument.
  
  `WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
- 6388474: Record the time and configured operator of each failure resolution. Include resolutions in the failure-to-answer median, with separate retry and resolution figures, and refresh cached statistics after resolution. Preserve the first resolution across repeated requests and later retries.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- ceba675: Show the saved harness and model used by Retry and flag agent definition changes in run details. Edit and retry uses the current loaded definition, including when the task and agent name stay the same. Reject cancellation of failed and succeeded runs with a clear error while preserving repeated cancellation of canceled runs.
- 392e165: Needs attention no longer lists entries about an issue that is closed or a pull request that is closed or merged. Each poll closes the item's cycle-budget ask with the reason `ItemClosed` and records it in the new `usine_cycle_ask_closures` table. The closure isn't a reset: the item keeps its generation and reservations, so a reopened item at its limit asks again. A failed run on such an item keeps `canResolveFailure` but isn't listed, and its drawer says `Issue closed`, `Pull request closed`, or `Pull request merged`.
  
  Adds `CycleBudgets.close` and `CycleBudgetAskCloseReason` to `@usine/engine/cycle-budget`, `ItemProjectionReader.get` to `@usine/engine/item-projection`, `RunDetailView.settledItemState` to `@usine/orchestrator/operator`, and `SettledItemState` to `@usine/config/board`.
- bf21f9c: Fixes a failed attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt, such as the run's automatic retry, could start in that slot beside the task. Before it closes a failed attempt, the engine now confirms the stop through `StepExecutor.interrupt`. If the stop isn't confirmed, the attempt keeps the slot and is listed in `UnconfirmedStops` and **Needs attention**, as after a cancel, until a reconcile confirms the stop.
- cd25ce0: The operator API adds `GET /api/statistics?window=7d|30d|all` (30 days by default), which computes from the stored runs, their usage, and the stored items how the factory ran in the window: closed runs by outcome, loop, agent, and harness, model, and effort; run and attempt time with median and 90th percentile beside the mean; tokens per pool and the cost of priced runs; runs closed per day; first-pass merges and lead time to merge; queue wait, attempts per run, and slot use per worker; and Needs attention entries with their waits. `RunReader.closedSince` reads the runs closed since a time.
  
  The overview ends with a Statistics section that shows these as figures and charts, with a switch between 7 days, 30 days, and all runs.
- 4c63872: When a run's fiber stops on an engine failure, `The Run's fiber stopped on an engine failure` is now logged inside the run's `RunDriver.drive` span, so it appears as a span event in the run's trace, and the span ends with the failure. Before, the line was logged under the `RunDriver.launch` span, which had already ended.
- fdbad56: The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, even if the agent staged them, as well as what Git ignores. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `PartlyPushed`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.
  
  `@usine/core/attempt/salvage` adds `SalvagePartlyPushed` to `AttemptSalvage`, with the salvage `ref`, the pushed `commit`, the worktree's `path`, and a `message` that names the files left out. The engine resumes the run's next attempt from its `ref` and `commit`, as it does from a `Pushed` salvage. The executors keep its worktree, provisioned machine, or Cloudflare sandbox, as they do for a `Retained` one. The run drawer shows the pushed ref and commit, the worktree's path, and the files left out.
- fdbad56: A salvage push that GitHub refuses for a file over its size limit (`GH001`) is now recorded as `Rejected`, and startup recovery doesn't push the same commit again. Before, the salvage recorded it as `Retained`, and every startup pushed the checkout again before the HTTP server listened, about a minute each time, and GitHub refused it each time (#581).
  
  `@usine/core/attempt/salvage` adds `SalvageRejected` to `AttemptSalvage`, with the worktree's `path`, the refused `commit`, and the remote's `message`. `AttemptRecovery` requires `rejected`, the attempt's recorded `SalvageRejected` or `None`, and the engine's salvage candidates fill it from the stored salvage. The executors keep the worktree, the provisioned machine, or the Cloudflare sandbox of a `Rejected` salvage as they do for a `Retained` one. Recovery records the same `Rejected` salvage while the checkout's head is the refused commit, and salvages and pushes again once the checkout changes. A recovery that can't inspect the checkout, or can't commit its changes on top of the refused commit, also records the same `Rejected` salvage instead of `Retained`, so that a later startup doesn't push the refused commit again. The run drawer shows the rejected work's path and GitHub's message.
- 9782e74: An SSH worker can set `provisioner` instead of `destination` in `usine.yaml` to create a machine for each attempt, a Hetzner Cloud server from a snapshot or a Boat sandbox, and delete it after the attempt. A failed creation isn't an attempt failure: the run keeps its place in the queue, and the worker pauses its creations with a backoff. Preflight checks the provider's token and resources without creating a machine, and refuses a harness without a credential outside the machine: the gateway's, or an API key from `provisioner.api_keys`: `anthropic` for Claude Code, `openai` for Codex. The executor connects to each machine only with a host key known before the first connection: one it generates and sets through a Hetzner server's user data, or the one that Boat's API returns. The other checks run on the worker's first machine each day. `infra/hetzner/snapshot.sh` builds the Hetzner snapshot.
- a55ab58: Each run is now a trace of its own: its root span, `RunDriver.drive`, links to the span that launched the run, such as a poll cycle or an approval request. The **Settings** configuration page shows the `tracing` block, and a reload refused for a changed `tracing` block links to it. A malformed `OTEL_RESOURCE_ATTRIBUTES` now stops `usine up` with a message that names the key, instead of crashing it. The web UI no longer sends trace headers.
- e5d9dcb: Fixes two cases where usine acted as if an attempt's parent task had stopped when it couldn't confirm the stop. The executor salvaged and removed the attempt's worktree under a parent task that could still run, and the run's retry, or the next run of the loop on the item, could start on another slot or worker beside it.
  
  While a stop is unconfirmed, the executor now keeps the worktree without salvage, and the next confirmed stop salvages and removes it. No run of the loop starts an attempt on the item until a reconcile confirms the stop. The run page and the item's stalled entry on **Overview** show **Waiting for attempt \<n\> to stop on \<worker\>**, and the **Needs attention** entry says that no new attempt starts on the item.
  
  `StepExecutor.interrupt` and `Executor.cancel` take a `StopReason` (`cancel`, `failed`, or `startup`, from `@usine/core/attempt`), which the executor logs. `UnconfirmedStop` records the run's loop and item and the reason, `RunDetailView.unconfirmedStop` names the attempt that an open run waits for, and the desk's stall reasons gain `WaitingForStopView`.
- a5ed825: Fixes a canceled attempt that gave up its worker slot when usine couldn't confirm that its parent task stopped, so another attempt could start on that worker beside the task. The attempt now keeps its run's slot, also after its execution acquired the checkout and without a restart. Each reconcile retries the stop and frees the slot once the stop succeeds. After a restart, startup still occupies a slot for each closed attempt whose stop it can't confirm.
  
  `RunEngine.cancel` moves the slot of the run's fiber to the attempt before it stops the parent task. `UnconfirmedStops` in `@usine/engine/engine` lists the attempts whose stop the engine retries, and `UnconfirmedStops.empty` lists none; `OperatorObservation` requires it. **Needs attention** shows each attempt as an `UnconfirmedStopNeed`, **\<loop\>: parent task not stopped**.
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

- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- d039c91: The engine drives runs instead of an Effect workflow: each open run has one fiber in the orchestrator, and usine's run tables are the only durable state. Approval, retry, cancel, supersede, and revoke behave as before.
  
  On the next start after the upgrade, the orchestrator drops `usine_workflow_commands`, `cluster_messages`, `cluster_replies`, and `cluster_migrations` from `.usine/runtime.sqlite`. A run that was running at shutdown goes through normal startup recovery, and run ids keep their values. `layerWithDatabase` takes a layer that provides only `RunDatabase`; the deployment still provides `Crypto`, which hashes dedup keys into run ids.
- 81c048b: `StepExecutor.execute` takes an `ExecutionSink`: the attempt's channel sink and `checkoutAcquired`, which the executor runs once preparation acquires the checkout. Until then, the engine reconciles a checkout that a restart kept for reattachment: canceling the run records the salvage and removes the checkout, and a failed reattachment reconciles it before the failure is recorded.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- ebfb373: A deleted or transferred issue that the queued-event recheck finds missing leaves the board's open lanes. `TriggerCondition.recheck` replaces `TriggerCondition.holds` and returns a `TriggerRecheck` from `@usine/engine/trigger-condition`: `matches`, `no-longer-matches`, or `item-gone`.
  
  For the last two, the engine revokes the item's queued events, and for `item-gone` it also calls `ItemProjectionWriter.markGone`. An adapter that can't tell returns `matches`, as it returned `true` before.
- af28e0e: `RunReader.closed({ limit })` returns the `limit` most recently closed runs, newest first, regardless of when they opened. The overview's **Last outcomes** uses it, so it lists a run that opened long ago and closed recently.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 01306e6: `harvestFacts` and `harvestPostedComments` leave out a comment or review that could belong to another attempt: one posted while another attempt of the same agent was open on the item, one posted after the attempt's window ended, or one created before the checkout was prepared and edited since. The harvest summary counts these as `ambiguous`, `outside`, and `edited`.
  
  `@usine/core/attempt` exports `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, and `AttemptWindows`. The harvest functions take `windows`, an `AttemptWindowsRead`, and `harvestFacts` fails with a `HarvestError` at the new `windows` stage if the read fails; `AttemptChannel.Sink` and `RecoverySink` add `windows`, which the engine reads with `RunStore.attemptWindows`.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- b601259: After an orchestrator restart, a reattached attempt's runaway guard resumes from its recorded totals instead of starting over, and sends each 80% warning at most once per attempt. If the guard can't read the transcript or unsupervised time, it cancels the parent task, records the salvage, and fails the attempt with an `InfraFailure`.
  
  Adds `AttemptChannel.Sink.transcript` to `@usine/core`, which the engine reads from the run tables, and `AttemptRuntime.recordUnsupervised`, `AttemptRuntime.unsupervised`, `AttemptRuntime.attached`, and `StubStorage.unsupervised` to `@usine/durable`. A wall-clock guard records its unsupervised time every 30 seconds, so a crash loses at most 30 seconds, and the wall clock starts once the launch registers the attempt's session.
- 3088f0e: Before a queued event opens a run, the engine rechecks whether the loop's trigger still matches the item through the new `TriggerCondition` port (`@usine/engine/trigger-condition`), which `layerWithDatabase` and the local SQLite layer require. An event that no longer matches is revoked, and a check that can't complete opens the run as before.
  
  The orchestrator rechecks against a fresh GitHub snapshot, so a run that pushes a commit and then swaps its trigger labels no longer starts a second run.
- 2fc760a: Renames the item-level hold to suppression, so hold means only the session hold. In `@usine/engine/engine`, the `Held` submission result becomes `Suppressed`, and in `@usine/engine/run-reader`, `LoopSighting.heldBy` becomes `suppressedBy`. In `@usine/orchestrator/operator`, `HeldForOperatorView` becomes `SuppressedForOperatorView`, whose tag is `SuppressedForOperator`. A migration renames the `usine_loop_items` columns `held_by_run_id` and `held_event_id` to `suppressed_by_run_id` and `suppressed_event_id` and keeps their values.
- 3f13b80: `StepExecutor.reserve` takes `worker: Option<WorkerName>`. With a worker, the lease comes only from that worker, and the scheduler serves the reservation before unnamed ones without blocking runs that another worker can take.
  
  `StepExecutor` adds `occupy(worker)`, which takes a slot at once for an attempt already running on the worker, even beyond `max_concurrent_attempts`, and logs a warning in that case.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- cba7d35: Operators can run a succeeded or canceled run again. `RunEngine.runAgain` takes a `RunAgainRequest` and records a new event for the run's item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`; it returns `Claimed` or `CycleBlocked`, and fails for a run in another state or while another run of the loop is open on the item.
  
  Adds `canRunAgain` to `RunState.operatorActions`, `RunAgain` to `@usine/core/run/again`, the `usine_run_again_events` table, `runAgain` to `RunSnapshot`, `RunSummary`, and `RunView`, `Operator.runAgain` with the new `LoopNotFoundError`, and `POST /api/runs/:runId/run-again`. The drawer and run page offer **Run again** and **Edit and run again** on succeeded and canceled runs.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- f060b57: The run store records when a run closes in `usine_runs.closed_at`, and clears it when a retry reopens the run. `RunSummary` and `RunSnapshot` in `@usine/engine/run-reader` add `closedAt`, and `RunReader.closed` orders runs by it; add the field to code that constructs `RunSummary` or `RunSnapshot`.
- 8f43ed7: A run whose fiber hits a store failure no longer waits for the next restart. The fiber retries a failed store operation four times with exponential backoff from 100 ms, and the engine reconciles every `ReconcileInterval` (three minutes by default, from `@usine/engine/engine`), starting a fiber for every open run that has none, except runs waiting for approval.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- ec5c4d4: Adds `BoardMoves` to `@usine/engine/board-moves`, which records the operator's board moves in the new `usine_board_moves` table. `Operator.moveBoardItem` records each move before it sends the label swap, and `Operator.githubChanges` lists a matching label change as a `BoardMovedView`, so the run page shows it as the operator's move.
  
  Moves made before this change still show as the agent's label changes.
- b99cdc8: Adds `RunReader.events(runIds)`, which reads the event each run was opened for as `RunEvent` records, in one batch. The event's payload is the item as the trigger saw it.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- ba8e26f: `StepExecutor.workers` is an effect that lists the executor's current workers, including a removed worker until its last attempt ends. `RunEngine.discardLeftovers` reads it on each call and discards the leftovers of a removed worker only after its last attempt ends.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- e518906: Upgrades `drizzle-orm` to 1.0.0-rc.5-5935859. Fixes `Schema.TaggedErrorClass is not a function` in `@usine/engine/local-sqlite`, `usine backup`, and `usine export-run` on a plain install.
- 3ed742f: An open pull request that GitHub no longer has leaves the board's open lanes. The poll calls the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the item's projection until a later poll sees the item again, and the board places a gone item by its closed state; a migration adds `gone_at` to `usine_item_projections`.
- 81c048b: The engine reconciles a checkout that a restart kept for reattachment as soon as the run closes the attempt without reattaching it, instead of at the next startup. The salvage is recorded before the next attempt starts from it; if `StepExecutor.interrupt` can't confirm that the parent task stopped, the checkout stays and the run waits for the next reconcile.
- 291d428: Adds `ItemProjectionReader.openIssues(repository)`: the numbers of open issue projections not marked gone.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- 3f13b80: After a restart, a reattached attempt occupies a slot of its worker, so the worker takes no new attempt beyond `max_concurrent_attempts`. At startup, the engine occupies a slot through `StepExecutor.occupy` for each attempt whose checkout it keeps for reattachment, and releases it only after `StepExecutor.interrupt` confirms that the parent task stopped. `RunStore.beginAttempt` logs `Reattached Attempt keeps its own Worker, not the reserved one` at error instead of warning.
- 6d70b40: Fixes startup reconciliation calling `StepExecutor.recover` once per service that the engine layer is provided to. `usine up` reconciles each attempt once instead of four times.
- 2729e91: Startup reconciles the leftover checkout of a succeeded attempt: both executors remove it without salvage or a credential. `RunStore.salvageCandidates` lists every attempt with a `succeeded` flag on `AttemptRecovery`, and the exe.dev executor lists each worker's leftover checkouts once per start.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- d799713: An event whose run was canceled, superseded, or revoked, or a queued event that a revoke ignored, opens a new run when the item leaves that state and comes back to it, for example when a label is removed and added again. The new run's event has the dedup key `["reopened", n, <original key>]`, and the engine records each loop's last sighting of an item in the new `usine_loop_items` table.
- c604a43: At startup, the engine records the comments that an open attempt posted on its run's item if its parent task failed before the orchestrator stopped. `@usine/core/attempt/salvage` exports `RecoverySink`, which `Executor.recover` and `StepExecutor.recover` take instead of the salvage callback, with a `comments` recorder.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- e5d9483: Rewords TSDoc for `claimRun` and `RunStore.parkForApproval`.
- 1877119: A runtime store migration drops the index `usine_item_projection_repository`, a duplicate of the unique index `usine_item_projection_number`, and adds a `json_valid` check on `usine_attempts.salvage_json`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
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

- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- 388e59d: Adds `usine export-run <runId>`, which saves a run's detail, attempts, and transcripts to a new JSON file (set the path with `--output <path>`). Adds `RunReader.evidence(runId)` and the read-only `runReaderLayer(instanceDirectory)`.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- 83edd04: Adds `usine backup <path>`, which copies the runtime database, including committed WAL data, while the orchestrator runs, and never overwrites an existing file.

### Patch Changes

- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- 5c47dc2: On SIGINT or SIGTERM, the orchestrator drains admitted attempts and defers queued work and retries until restart; a second signal forces a stop.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
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
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- a8d8df4: Adds the Drizzle-backed durable engine with approval, retry, supersede, revoke, and restart recovery; the Node adapter is `@usine/engine/local-sqlite`.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- fb24c80: Adds Codex app-server and API-key-only Pi children to the subagents extension (protocol v3).
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.

### Patch Changes

- 3041f9d: Moves `Instance.Directory` and `Loop.ApprovalRequirement` to `@usine/core`; `@usine/engine` still exports `InstanceDirectory` and `ApprovalRequirement`.
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
