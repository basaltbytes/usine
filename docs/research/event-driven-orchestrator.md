# An event-driven orchestrator on Durable Objects or a durable-function runtime

Research on what in `usine up` needs a long-running process, and what each part would become on
Cloudflare Durable Objects or on a durable-function runtime such as Cloudflare Workflows or Inngest.
Snapshot date: 2026-10-27. The inventory comes from the code at commit
[`2f78d3a`](https://github.com/basaltbytes/usine/tree/2f78d3ab337635069e4de25bfd228b148b39e773), not
from the docs. Every vendor source was read on 2026-10-27: Cloudflare's Durable Objects, Workers,
Workflows, Queues, and D1 docs and changelog, Inngest's docs and pricing page, and Hetzner's price
pages. The environment that wrote this note can't open those pages directly, so it read them
through a search service's extract of each page: the note paraphrases them and links the page that
each fact came from. Facts not found are marked "not documented". Prices are in the vendor's
currency and exclude VAT.

This note complements [`hosted-sandboxes.md`](./hosted-sandboxes.md), which prices the compute
where children run, and [`pi-durable.md`](./pi-durable.md), which describes the Pi parent's runtime.
Neither is repeated here.

## 1. Long-running parts of `usine up`

`usine up` (`apps/server/src/up.ts`) takes the instance lock, loads the instance folder, and builds
`runtimeLayer` (`packages/orchestrator/src/runtime.ts`). It then races two effects that never
return: the HTTP server on `127.0.0.1:7331`, and `Orchestrator.run`, which races
`PollingTriggers.run` and `ScheduleTriggers.run`. Every other long-running part is a fiber that a
layer forks into its scope at startup. SIGHUP reloads the instance folder (`reload-signal.ts`).
SIGINT and SIGTERM close attempt admission and wait for admitted attempts, for at most
`max_attempt_minutes`, which has no limit by default (`shutdown.ts`).

### Orchestrator (`apps/server`, `packages/orchestrator`)

| Part | Kept in memory | Kept alive by | After a crash |
| --- | --- | --- | --- |
| Process shell: `up.ts`, `shutdown.ts`, `reload-signal.ts` | The instance lock and record, the shutdown latch | The HTTP server and `Orchestrator.run`, raced; listeners for SIGHUP, SIGINT, and SIGTERM | A restart takes the lock again; nothing else resumes |
| `CurrentInstance` (`current-instance/current-instance.ts`) | The loaded instance folder in a `SubscriptionRef`, and the registered worker reload | Nothing of its own: SIGHUP and `POST /api/instance/reload` call `reload` | Loads the folder from disk again |
| `PollingTriggers` (`polling/polling.ts`, `polling/hints.ts`) | The last cycle; each repository's last completed poll; the repositories whose failing items were retried in this process; each repository's last open-issue check; up to 128 self-write hints, coalesced, and dropped when the queue is full; GitHub's backoff deadline | An `Effect.forever` cycle over 4 repositories and 4 items at a time, then a race between a sleep until `poll_interval` (60 s by default) or the time GitHub asked for, the next hint, and a reload | Yes: the poll cursor, the open pull requests, their base heads, and the failing items are rows in the runtime store (`CursorStore`). The next poll repairs lost hints. The open-issue check, otherwise every 10 minutes, runs again at once |
| `ScheduleTriggers` (`schedule-triggers.ts`) | The last cycle and each loop's last fired tick | An `Effect.forever` cycle that sleeps until the earliest next tick, for at most 60 s, or until a reload | Yes: with an empty map, the latest missed tick fires, and the dedup ledger drops a repeat ([ADR 0007](../adr/0007-polling-triggers-content-hashed-events.md)) |
| Worker scheduler (`scheduler.ts`) | The slots of each worker (`TxRef`), reservations in lease order (`TxPriorityQueue`), worker preflights, provisioning pauses, the machine of each lease, and the machine creations (`FiberMap`) | A forked dispatch loop, and a forked sleep for each paused worker: 30 s, doubling to 10 minutes | Rebuilt: startup occupies the slots of open attempts, and each run's fiber reserves again. Pauses and preflight results start empty |
| Operator service and HTTP API (`operator/`, `apps/server/src/http.ts`) | The overview cache and each attempt's cache of GitHub changes | Nothing: JSON request and response. The web UI polls, every second for the transcript of a run it can cancel | The caches fill again on the next request |
| GitHub App credentials (`credentials.ts`, `@usine/github`) | The installation of each project | Nothing: tokens are minted on demand, with JWTs signed through WebCrypto (`packages/github/src/jwt.ts`) | Nothing to resume |

The `webhooks` block of `usine.yaml` parses, but no code path at this commit receives a GitHub
delivery. `ItemHints` contains only the hints of usine's own writes.

### Run engine (`packages/engine`)

| Part | Kept in memory | Kept alive by | After a crash |
| --- | --- | --- | --- |
| `RunDriver` (`engine/run-driver.ts`) | One fiber per open run (`FiberMap`), each fiber's slot, the parent-task stops not yet confirmed, and the checkouts kept for reattachment (`checkout-recovery.ts`) | Each run's fiber, which waits for a slot and then blocks in `StepExecutor.execute` for the attempt's whole life. A run waiting for approval has no fiber; `approve` starts one | Yes: at startup, `recoverWorkspaces` and `reconcile` start a fiber per open run. An open attempt is reattached if its parent task is live, finished with its stored result if the task finished, and otherwise closed as interrupted |
| Periodic reconcile (`engine/engine.ts`) | Nothing | A forked loop every `ReconcileInterval`, 3 minutes by default | It is the recovery: it restarts runs whose fiber stopped and retries unconfirmed stops |
| `AttemptAdmission` (`engine/admission.ts`) | The admitted runs and the drain latch | Nothing | Admission is open again after a restart ([ADR 0023](../adr/0023-graceful-attempt-drain.md)) |
| `RunStore` and its projections (`store/`, `database/`) | Nothing | Nothing | The source of truth: 20 Drizzle tables in `.usine/runtime.sqlite` through `@effect/sql-sqlite-node`, which uses `node:sqlite`. 30 migrations, multi-statement transactions, and `json_extract` in the transcript queries |

### Pi parent and children (`packages/durable`, `packages/agents`)

| Part | Kept in memory | Kept alive by | After a crash |
| --- | --- | --- | --- |
| `DurableHarness` (`harness.ts`, `live.ts`) | The open pi-durable 1.2.0 Harness and its generation; Pi's model runtime and the Pi user's global settings, read from the Pi agent directory | pi-durable's task scheduler, whose sleeps and idle-context expiry are `setTimeout` timers. After a storage failure, the harness reopens, unless the reopened one fails within 60 s | Yes: `resume()` continues every unfinished task in `.usine/durable.sqlite`, opened with `openNodeSqliteStorage` |
| `AttemptRuntime` and its hubs (`attempt/runtime.ts`, `attempt/hubs.ts`) | Per attempt: a relay queue, emission and routing semaphores, the live children by session, the queued operator inputs, and the attached channel | The engine's `execute` call, which relays the attempt for its whole life | Yes: the relay position is in the attempt's record, and a reattached `execute` resends from it. The engine keeps the first copy of a resent envelope ([ADR 0010](../adr/0010-single-sqlite-runtime-store.md), amendment of 2026-10-08) |
| `subagent` tool (`attempt/subagent.ts`) | Each child's running session and the fiber that forwards its events | The child's event stream, for the child's whole life: minutes to hours. Calls run in parallel (`executionMode: "parallel"`) | No: the tool is `replay: "unsafe"`, so a call that a restart cut off ends as interrupted. The parent's instructions tell it to delegate again (`attempt/extension.ts`) |
| Claude Code child (`agents/src/pi/claude/claude.ts`) | A Claude Agent SDK 0.3.308 session in the orchestrator process, and its saved session ID | `spawn` from `node:child_process`, of `claude` on a local worker or of `ssh … claude` on a remote one, with a PID file next to the worktree | While the orchestrator runs, yes: when a remote child's SSH client exits with 255, the backend stops what's left of the process through its PID file and launches Claude again with the SDK's `resume` option, after 5 s, 15 s, 30 s, 1, 2, and 5 minutes ([#606](https://github.com/basaltbytes/usine/pull/606)). After an orchestrator restart, no: the `subagent` call ends as interrupted |
| Codex child (`agents/src/pi/codex/app-server.ts`) | The JSON-RPC client of `codex app-server` | Effect's `ChildProcess` spawner, local or over `ssh` | No: a lost SSH connection fails the child. Cleanup stops the remote process through its PID file (`CHILD_KILL_SCRIPT` in `child-host/child-host.ts`) |
| Pi child (`agents/src/pi/pi.ts`) | The whole Pi coding agent session, tools included | In process; it refuses a remote host, because its tools run in the orchestrator | No |

### Executor (`packages/executor`, `packages/cloudflare`)

| Part | Kept in memory | Kept alive by | After a crash |
| --- | --- | --- | --- |
| SSH workers (`ssh/ssh.ts`, `ssh/workers.ts`, `remote/remote.ts`) | The machines of each worker, the gateway forwards and credentials, container isolations, the Codex homes in use, and per-key locks | One OpenSSH client process per command: checkout, git, Docker, preflight, salvage. Known hosts are files under `.usine/known-hosts` | Yes: `recover` stops leftover children through their PID files, harvests posted comments, and salvages or removes the checkout. Sweeps remove abandoned worktrees and containers |
| Worker liveness (`remote/liveness.ts`) | The liveness of each machine and the attempts that watch it | An SSH probe every minute, with a 20 s connect timeout and a 45 s probe timeout | Starts again as attempts launch or reattach |
| Attempt guard (`guard.ts`) | The unsupervised time and tokens used, and the warnings sent | Persists the unsupervised time every 30 s; warns at 80 % of `max_attempt_minutes` and `max_attempt_tokens` | Seeded again from the persisted time and the attempt's transcript |
| Credential renewal (`renewable-credential.ts`) | Every token issued, for scrubbing | A check every 30 s, which renews a token within 5 minutes of its expiry | A reattached attempt gets a new token |
| Gateway admin forward (`ssh/gateway/forward.ts`, `attachments.ts`, `admin.ts`) | The forward's state and generation, and the current attachment | An `ssh -L` client to the gateway's admin port, reopened after 1 s, doubling to 60 s; attachments restored every 2 minutes; 30 s per admin request | Opens with the first worker behind the gateway; the restore sends the attachments again |
| Provisioned machines (`ssh/provisioner/machines.ts`) | The machine of each lease, each worker's earlier machines, and the day of each worker's last machine check | The Hetzner and Boat REST APIs; after a create, a check every 3 s until SSH answers, for up to 10 minutes | Yes: an attempt's machine is found again by its provider label. A machine whose recovery failed is kept; orphans are deleted at reconcile |
| Durable session (`durable-session.ts`) | The active attempts, the unconfirmed stops, and the launch registrations | Nothing of its own | Reads each parent task's liveness from `AttemptRuntime` |
| Cloudflare sandboxes (`cloudflare/`, `packages/cloudflare`) | In the orchestrator: the time of each sandbox's last credential | In the orchestrator: a sandbox-shell Node process per command that relays standard streams over the Worker's exec WebSocket and attaches again after 0.5 to 8 s; a drain check every 30 s. In the Worker: one `AttemptSandbox` Durable Object per attempt, with a keepalive alarm every 4 minutes during a two-hour lease, and exec and attach WebSockets accepted with `accept()` | Yes: each command runs in its own session, with its output and exit code in files, so a later attach resumes from byte offsets |
| Local workers (`local/`) | Nothing beyond the durable session | Local processes, and worktrees under `.usine/workers/` | Same recovery as SSH workers, on the local disk |

### Kinds of long-running work

The long-running work is of three kinds:

- **Clocks.** Polls, schedule ticks, reconciles, credential renewals, liveness probes, provisioning
  pauses, and machine checks. Each one is short work on a timer, and its state is either in the
  runtime store or cheap to rebuild.
- **Waiting state machines.** A run's fiber waiting for approval, a slot, or its attempt's outcome,
  and the scheduler's reservations. The state is in the runtime store; only the waiting is in
  memory, and startup recovery rebuilds it.
- **Child streams.** Each child's standard streams, opened by the process that spawned it, for
  minutes to hours. A restart ends them: the `subagent` call ends as interrupted, and the parent
  delegates the work again. Only the Cloudflare sandboxes keep a command running after its stream
  drops; a remote Claude child whose SSH connection drops resumes its saved session, but only while
  the orchestrator process keeps running.

## 2. Parts with no equivalent on Cloudflare Workers

| Dependency | Used by | On Workers | Replacement |
| --- | --- | --- | --- |
| `node:child_process`, and Effect's `ChildProcess` on top of it | Claude Code and Codex children, every SSH command, the gateway forward, the sandbox shell, and local workers | A non-functional stub: it imports, but doesn't work ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)) | For compute, the Cloudflare Sandboxes adapter's exec and attach WebSockets (`@usine/cloudflare/stream`), opened by the object itself instead of a sandbox-shell process. For Hetzner workers, the gateway as an HTTP-to-SSH relay that serves the same exec and attach protocol; the gateway has no such endpoint at this commit |
| OpenSSH: the `ssh` binary, `-L` forwards, known-hosts and identity files | The SSH executor, liveness probes, machine readiness, and the gateway forward | None. `connect()` opens outbound TCP, with port 25 and Cloudflare's own addresses blocked ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)); an SSH client in JavaScript on Workers: not checked | The gateway relay above, over HTTPS. Workers VPC's `connect()` reaches private hosts through a Cloudflare Tunnel, as plaintext TCP only ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-16-tcp-connect-vpc-networks/)) |
| Claude Agent SDK 0.3.308 | Claude Code children | Its bundle imports `child_process`, `fs`, `readline`, `os`, and `path` (read from the installed package) | A client for `claude --print --output-format stream-json` over the exec stream, the way Cloudflare's Claude Code guide runs it (`hosted-sandboxes.md`, section 2) |
| Pi coding agent (`createAgentSession`) | Pi children | Its tools need the checkout's filesystem and a shell in the same process | None |
| SQLite files through `node:sqlite` | `.usine/runtime.sqlite`, `.usine/durable.sqlite`, and `usine backup` | A non-functional stub ([Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)) | The run store: Durable Object SQLite through Drizzle's `effect-sqlite-do` driver, which the pinned `1.0.0-rc.5-5935859` ships and which runs a transaction body with `Effect.runSyncExit` inside `ctx.storage.transactionSync`, so the body must be synchronous; not tested against the store. D1 through `effect-d1` is the other driver. The Pi parent: pi-durable's `openDurableObjectSqliteStorage`. Backups: Durable Object point-in-time recovery over 30 days ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| Other Node-only packages: `@effect/platform-node` (file system, HTTP server, child processes), `node:net` (a free local port for the forward), `node:os` (the home directory for keys) | The server, the executor, the durable harness | Not available as Node packages | Workers' `fetch` handler, Durable Object storage, and bindings |
| The instance folder on disk, process signals, the instance lock, `127.0.0.1:7331` | `usine up`, `CurrentInstance`, the Pi settings | None: the folder is the operator's checkout on the machine that runs `usine up` | The instance repository, read through GitHub's API ([ADR 0001](../adr/0001-loops-live-in-the-instance-repo.md)); one engine object per instance in place of the lock; a reload request or push in place of SIGHUP; a Worker route behind Cloudflare Access in place of the loopback port |

Everything else is portable: GitHub App tokens use WebCrypto and `fetch`, the Hetzner and Boat
drivers are REST clients, pi-ai calls model providers over `fetch`, and span export is OTLP over
HTTP.

## 3. Limits that bind an agent loop

### Durable Objects

| Limit | Value | Source |
| --- | --- | --- |
| Alarms per object | One. `setAlarm()` replaces the scheduled alarm, and an alarm doesn't repeat by itself | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| Maximum alarm delay | Not documented: "any time in the future", with a 30-day example | [Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| Alarm delivery | At least once, one `alarm()` at a time per object; on an uncaught exception, retried with exponential backoff from 2 s, up to 6 times; usually within milliseconds of the set time, up to a minute late during failover | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| Wall time of an alarm handler | 15 minutes | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Wall time of an HTTP or RPC request | No limit while the caller stays connected | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| CPU per invocation | 30 s by default, up to 5 minutes with `limits.cpu_ms`, per HTTP request, WebSocket message, or alarm; each incoming request or message resets it | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Idle eviction | A hibernatable object hibernates after 10 s idle; any other object is evicted after 70 to 140 s without requests or events | [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| Outbound connections | An outbound `fetch`, TCP socket, or WebSocket keeps the object in memory for at most 15 minutes from its start. The connection keeps working after that, but eviction rules apply again | [Changelog, 2026-06-19](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| Deploys and restarts | A new version restarts every object and disconnects its WebSockets; an in-flight request that accesses storage fails. Cloudflare's Agents docs put code updates and runtime restarts at 1 to 2 a day | [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Agents durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) |
| WebSocket hibernation | Only for WebSockets that the object accepts as a server with `ctx.acceptWebSocket()`. No hibernation with `accept()`, outbound WebSockets, a pending `setTimeout` or `setInterval`, an unfinished `waitUntil()` promise, or an open outbound connection. In-memory state is discarded; per-connection state goes in `serializeAttachment()`. 32,768 WebSockets per object; at most 10 tags of 256 characters each | [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| Threading | One thread per object. Requests interleave at each `await`; input gates delay new events during a storage operation, and output gates delay outgoing messages until writes commit. Soft limit of 1,000 requests per second per object | [Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| SQLite storage | 10 GB per object on Workers Paid; 2 MB per key and value. `sql.exec()` refuses `BEGIN TRANSACTION`; transactions go through `ctx.storage.transaction()` or `transactionSync()` | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |

### Workers

| Limit | Value | Source |
| --- | --- | --- |
| CPU per invocation | 30 s by default, up to 5 minutes with `limits.cpu_ms` on Workers Paid, for an HTTP request or a Queue consumer (see "Conflicts between vendor pages"). A Cron Trigger that runs every hour or less often gets 15 minutes; one that runs more often gets 30 s | [Limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Duration | No limit for an HTTP request while the client stays connected; `waitUntil()` runs at most 30 s after the response. 15 minutes for a Cron Trigger, a Queue consumer, or a Durable Object alarm | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Memory | 128 MB per isolate, heap and WebAssembly included | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Subrequests | 10,000 per request by default on Workers Paid, configurable up to 10 million | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Connections waiting for response headers | 6 per invocation, counting `fetch()`, `connect()`, and outbound WebSockets | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Node.js modules | `node:child_process` and `node:sqlite` are non-functional stubs | [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) |

### Workflows

| Limit | Value | Source |
| --- | --- | --- |
| `step.sleep` and `step.sleepUntil` | Up to 365 days; not counted as steps | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| `step.waitForEvent` | 24 hours by default, from 1 s to 365 days; a timeout fails the instance unless the call is caught | [Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/) |
| Wall time per step | Unlimited; the docs advise step timeouts of 30 minutes or less, and `waitForEvent` for longer waits | [Limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) |
| CPU per step | 30 s by default, up to 5 minutes | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Steps per instance | 10,000 by default on Workers Paid, up to 25,000 | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| State | 1 MiB per step result (a stream can be larger), 1 GB per instance on Workers Paid; completed state kept 30 days | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Concurrency | 50,000 running instances per account on Workers Paid (see "Conflicts between vendor pages"); sleeping and waiting instances don't count | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) |

### Queues

| Limit | Value | Source |
| --- | --- | --- |
| Message | 128 KB | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Consumer | 15 minutes of wall time per invocation; 30 s of CPU by default, up to 5 minutes with `limits.cpu_ms`; batches of up to 100 messages | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Delivery delay | Up to 24 hours | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Retention | 4 days by default, up to 14 days on Workers Paid | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |

### D1

| Limit | Value | Source |
| --- | --- | --- |
| Size | 10 GB per database, not raisable | [Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Query | 30 s, which also bounds a whole `batch()` call | [Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Atomicity | `batch()` runs its statements in sequence as one transaction and rolls the whole batch back if one fails. A transaction that reads, then decides what to write, as the run store's do: not documented | [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| Throughput | One query at a time per database | [Limits](https://developers.cloudflare.com/d1/platform/limits/) |

### Inngest

| Limit | Value | Source |
| --- | --- | --- |
| Step duration | Up to 2 hours, or less if the host's request timeout is shorter (see "Conflicts between vendor pages") | [Usage limits](https://www.inngest.com/docs/usage-limits/inngest) |
| Steps per function | 1,000 | [Usage limits](https://www.inngest.com/docs/usage-limits/inngest) |
| State | 4 MiB per step output, 32 MiB per run | [Usage limits](https://www.inngest.com/docs/usage-limits/inngest) |
| `step.sleep` | Up to 1 year, within the plan's run length: 30 days on Free, 90 on Pro, 366 on Business, sleeps and waits included | [Usage limits](https://www.inngest.com/docs/usage-limits/inngest), [sleeps](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/sleeps) |
| `step.waitForEvent` | Matches only events sent after the wait starts, on a shared field (`match`) or a CEL `if` expression; returns `null` at the timeout | [waitForEvent](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event) |
| Concurrency | Counts executing steps, not sleeping or waiting runs; keyed per function, environment, or account; 5 concurrent steps on Free, 100 included on Pro | [Concurrency](https://www.inngest.com/docs/guides/concurrency), [usage limits](https://www.inngest.com/docs/usage-limits/inngest) |
| Connect workers | Persistent outbound WebSockets from a long-running process; 3 connections on Free, 20 on paid plans | [Connect](https://www.inngest.com/docs/setup/connect) |

### Consequences for an Attempt

- **A child's stream lasts longer than a Durable Object stays in memory.** A child runs for minutes
  to hours. An outbound WebSocket keeps its object in memory for 15 minutes; after that, the object
  stays in memory only while requests or messages arrive. As the server end of a hibernatable
  WebSocket, the object can sleep between messages, but every deploy and runtime restart still
  closes the socket. The object follows a child through those drops only by attaching again from
  byte offsets, as the sandbox Worker allows, or by resuming the child's saved session, as the
  Claude backend does after a lost SSH connection. Either way, the `subagent` call has to outlive
  the object's restart, and at this commit it doesn't.
- **The Pi parent fits one object per attempt, awake for the whole attempt.** pi-durable 1.2.0
  stores a Harness in one object's SQLite and runs without Node APIs (README, "Storage"). Its
  sleeps are `setTimeout` timers and its generations are outbound `fetch` streams, so the object
  can't hibernate while the attempt runs, and it pays duration for it. After an eviction, only an
  alarm or a request wakes it to call `resume()`.
- **Clocks fit alarms.** A poll cycle, a reconcile, and a machine's 10-minute readiness wait each fit
  in a 15-minute alarm handler, and GitHub's requested wait becomes the next alarm's time.
- **One thread per object sets the split.** The scheduler's slot pool and queue need one ordered
  owner, which one object per instance gives. Ten Pi parents in one object would share one thread,
  the 30 s CPU budget per event, and the 1,000 requests per second, so each attempt needs its own
  object.
- **A durable-function step can't supervise a child either.** Inngest fails a step after 2 hours,
  and an attempt has no time limit unless `max_attempt_minutes` is set. A Workflows step has no
  wall-time limit, but the docs advise 30 minutes or less, and an evicted step starts again from the
  beginning. What fits both is a child supervised next to the child, which sends the step an event
  when the child reports.

## 4. Mapping of each part

| Part | On Durable Objects | On a durable-function runtime |
| --- | --- | --- |
| Process shell | A Worker `fetch` handler with the web assets, behind Cloudflare Access; one engine object per instance in place of the instance lock | Nothing: the process stays on the VM |
| `CurrentInstance` | The parsed instance in the engine object's storage, read from the instance repository through GitHub's API; a reload request or a push replaces SIGHUP | Stays |
| `PollingTriggers` | A poller object with an alarm at the later of `poll_interval` and GitHub's requested time; a hint calls `setAlarm()` for now, or for GitHub's requested time when that is later, because `refreshHint` waits for that deadline at this commit; the cursor stays in the store | Workflows: an instance per cycle, or one instance that loops with `step.sleep`. Inngest: a scheduled function. Or it stays |
| `ScheduleTriggers` | An alarm at the next tick, or a Cron Trigger each minute | A scheduled function in either runtime |
| Run fibers | A run's state in the engine object's SQLite. Approval, a slot grant, and an attempt's outcome arrive as RPC calls; no fiber waits through an attempt | Workflows: an instance per run, with `waitForEvent` for approval, the slot, and the outcome, each with a timeout set, since the 24-hour default fails the instance. Inngest: the same with `waitForEvent`, within the plan's run length |
| Periodic reconcile | An alarm every 3 minutes on the engine object | A `step.sleep` loop or a scheduled function |
| Worker scheduler | One scheduler object, with the slots and the queue in its SQLite; a pause becomes an alarm | Nothing: Inngest's concurrency counts executing steps, not attempts, and Workflows has no per-worker limit, so the slots stay in a process |
| Machine creation | An alarm chain in the scheduler object: create, check every 3 s, give up after 10 minutes; orphan sweeps in the reconcile alarm. SSH readiness goes through the relay | Workflows: an instance per machine, with `step.sleep("3 seconds")` between checks. Inngest: the same with `step.sleep` |
| Run store | The engine object's SQLite, up to 10 GB, with each attempt's transcript in its own attempt object, because v1 prunes nothing (ADR 0010). D1 has the same 10 GB per database and no documented read-then-write transaction | Stays on the VM |
| Operator API | Worker routes that call the engine object; the UI's polling stays, or each browser opens a hibernatable WebSocket | Stays |
| Credential renewal | An alarm in the attempt object | A `step.sleep` loop per attempt |
| Pi parent | One attempt object per attempt, on pi-durable's Durable Object storage, with a keepalive alarm so that `resume()` runs after an eviction | Workflows: a generation per `step.do`. Inngest: a generation per `step.run`, each under 2 hours. Both put a second durable store beside `durable.sqlite`, whose tasks already resume |
| Children | Nothing available. Compute: the sandbox exec and attach streams, opened by the attempt object, which reattaches by byte offset after every drop. Hetzner workers: the gateway relay. Claude Code: a `stream-json` client in place of the Agent SDK. Pi children: none | Stay on the VM; the parent's step waits for the child's report with `waitForEvent` |
| SSH executor, liveness, salvage | Through the gateway relay; liveness as an alarm per machine | Stay |
| Gateway admin forward | The admin API over HTTPS behind Access, or through a Cloudflare Tunnel | Stays |
| Cloudflare sandboxes | Already Durable Objects; the attempt object calls `AttemptSandbox` directly in place of the sandbox-shell process | Stay |
| Hints and webhook deliveries | A Queue: messages up to 128 KB, retried, delayed up to 24 hours. It is the only part that maps to a Queue; every other part needs ordered state per instance, run, or attempt, which an object gives | A send event, in either runtime |

## 5. Costs for one operator with up to ten concurrent Attempts

The ceiling is ten attempts running through a whole month of 730 hours: 7,300 attempt-hours. The
compute that runs children, SSH workers or Cloudflare sandboxes, costs the same in every option and
is left out; `hosted-sandboxes.md` prices it. Model usage is left out too.

### Option 1: one long-running orchestrator on a small VM

| Item | Price per month | Source |
| --- | --- | --- |
| Orchestrator on a CX33: 4 vCPU, 8 GB, 80 GB, IPv4 included | €8.99 | [Cost-Optimized](https://www.hetzner.com/cloud/cost-optimized/) |
| Or a CX23: 2 vCPU, 4 GB, 40 GB, IPv4 included | €5.99 | Same page |
| Or a CPX32 when no Cost-Optimized server is in stock: €35.49, plus €0.50 for IPv4 | €35.99 | [Price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4 pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/) |

The orchestrator runs the Pi parents, the Claude Agent SDK sessions, and the SSH clients; the
repositories' builds run on the workers. Its memory with ten attempts is not measured. The gateway
VM, a CX23 by default in `infra/hetzner/gateway/gateway.sh`, costs €5.99 in every option that has
workers behind a gateway. The prices took effect on 2026-06-15, and Hetzner bills the cheaper of
hourly and monthly.

### Option 2: the VM, with the Pi parent on a durable-function runtime

| Item | Price per month | Source |
| --- | --- | --- |
| The VM of option 1 | €8.99 | As above |
| Inngest Pro, because ten attempts, each with a running step, exceed Free's 5 concurrent steps. Its 1 million executions cover 50 steps per attempt for 20,000 attempts | from $99 | [Pricing](https://www.inngest.com/pricing), [usage limits](https://www.inngest.com/docs/usage-limits/inngest) |
| Or Cloudflare Workflows: the Workers Paid minimum, with 500,000 steps and 1 GB-month of storage included, then $0.80 per 100,000 steps and $0.20 per GB-month | from $5 | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |

### Option 3: the orchestrator rebuilt on Durable Objects

Each running attempt keeps one attempt object in memory, billed at 128 MB, and the engine object
is in memory all month.

| Item | Calculation | Price per month |
| --- | --- | --- |
| Workers Paid minimum | | $5.00 |
| Duration | Attempt objects: 7,300 h × 3,600 s × 0.128 GB = 3,363,840 GB-s. Engine object: 730 h × 3,600 s × 0.128 GB = 336,384 GB-s. Less the 400,000 GB-s included: 3,300,224 GB-s × $12.50 per million | $41.25 |
| Requests | A keepalive alarm every 30 s per attempt (876,000), the poll and schedule alarms every minute (87,600), and one incoming child message per second per attempt, billed at 20 to 1 (1,314,000): 2,277,600, less the 1 million included, × $0.15 per million | $0.19 |
| SQLite storage | 5 GB-month included, then $0.20 per GB-month; 50 million rows written included, then $1.00 per million | depends on transcript size |
| Gateway relay for Hetzner workers | The gateway VM | €5.99 |
| Total at the ceiling | | $46.44 and storage, plus €5.99 |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). The
child-message rate is an assumption of this note. At 1,760 attempt-hours, ten attempts for 8 hours
on 22 days, the duration line is $9.34.

## Conflicts between vendor pages

- **Workflows concurrency.** The limits table gives 50,000 concurrent instances on Workers Paid; the
  text below it still says 10,000
  ([limits](https://developers.cloudflare.com/workflows/reference/limits/)).
- **Queue consumer CPU time.** Workers pricing gives a Queue consumer invocation, like a Cron
  Trigger invocation, up to 15 minutes of CPU. The Queues limits page gives a consumer 30 s of CPU
  by default, up to 5 minutes, and 15 minutes of wall time; the Workers limits page gives 15 minutes
  of CPU only to a Cron Trigger that runs every hour or less often. This note uses the limits pages
  ([pricing](https://developers.cloudflare.com/workers/platform/pricing/),
  [Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **Inngest step duration on Connect workers.** The usage limits give 2 hours per step; the
  performance page says Connect has "no per-request duration limit on steps"
  ([usage limits](https://www.inngest.com/docs/usage-limits/inngest),
  [performance](https://www.inngest.com/docs/improve-performance)).
- **Inngest free plan.** An older features page says free plans sleep at most seven days; the usage
  limits page gives a 30-day run length
  ([features](https://inngest.com/features/step-functions)). A 2025 post names the plan Hobby, with
  100,000 executions and 25 concurrent steps; the pricing page names it Free, with 50,000 and 5
  ([post](https://www.inngest.com/blog/vercel-partner-marketplace),
  [pricing](https://www.inngest.com/pricing)).
- **Durable Object storage.** A footnote on "What are Durable Objects?" gives 1 GB per SQLite-backed
  object; the limits page gives 10 GB
  ([overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/),
  [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- **Hetzner stock.** The Cost-Optimized page lists the CX23 and CX33 as not available, and on
  2026-10-26 neither was in `fsn1`, `nbg1`, or `hel1` (`infra/hetzner/README.md`).

## Conclusion

Keep one long-running orchestrator on a small VM for the next year.

- **Only a process keeps a child's stream open for the child's whole run.** An outbound stream
  keeps a Durable Object in memory for 15 minutes, and every deploy and the runtime's restarts, once
  or twice a day, close it. Inngest fails a step after 2 hours, and Workflows advises steps of 30
  minutes or less. Each restart ends the running `subagent` calls as interrupted, and the parent
  delegates their work again. A VM restarts when the operator restarts it.
- **The rest already resumes after a crash.** The poll cursor, the dedup ledger, the run and attempt
  rows, the pi-durable tasks, the machine labels, and the sandboxes' process files survive a
  restart, and startup recovery rebuilds what's in memory. A durable-function runtime for the Pi
  parent duplicates pi-durable's task resume, adds a second durable store and a vendor, and leaves
  the children, OpenSSH, and the gateway forward on the VM.
- **A Durable Object rebuild still needs a VM.** Hetzner, the operator's first provider, is reached
  over OpenSSH, which Workers don't have, so the gateway VM would become an HTTP-to-SSH relay.
  Claude Code children would lose the Agent SDK, and Pi children would have no host.
- **The VM costs least.** €8.99 per month for the orchestrator on a CX33, against the VM plus $99
  per month for Inngest or $5 per month for Workflows, and $46.44 per month plus storage and the
  €5.99 relay for Durable Objects at ten attempts around the clock.
