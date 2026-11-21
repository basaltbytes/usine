# OpenCode adapter: transport and behavior on OpenCode 2.3.2

Research for [issue #1381](https://github.com/basaltbytes/usine/issues/1381). It settles the design
of an OpenCode harness adapter before any adapter code, and replaces the 2.2.5 note on the parked
branch `feat/958-opencode-adapter` ([PR #1001](https://github.com/basaltbytes/usine/pull/1001)).
Snapshot date: 2026-11-21.

The adapter pins **`@opencode/cli` 2.3.2**, the newest release on npm on the snapshot date
(published 2026-11-18; `opencode --version` prints `opencode v2.3.2`).

## Summary

- **Transport.** Run `opencode serve --stdio` behind a small usine bridge program on the worker.
  The bridge speaks JSON lines over its standard streams, and the adapter runs it through
  `ChildHost` under the worker process owner, like any other child. Neither the `ChildHost`
  contract nor the process owner needs anything new. A prototype bridge passed steering, kill,
  and an orchestrator detach and resume through the real process owner.
- **`opencode acp`** still refuses a second `session/prompt` during a turn. It accepts mid-turn
  input through an OpenCode extension, `_session/steering`, but it drops signals that usine needs:
  which steer the model read, and any turn that background work starts after `end_turn`, with
  that turn's tokens. So ACP isn't the recommended transport, and a generic ACP client waits until
  OpenCode speaks ACP v2 and reports background work.
- **Capabilities on the bridge.** Supported: `resume-session`, `steer`, `interrupt`, `usine-tools`,
  `closed-tools`, `token-usage`, `cost-usd`, and `model-check`. Lacking: `durable-coordination`,
  `structured-output`, `ephemeral`, and `plan-windows`. The coding agent and the supervisor
  roles are admissible; structured completions are not.
- **Follow-up.** One adapter issue, scoped at the end of this note. The OpenCode Go gateway slot
  belongs to [#1380](https://github.com/basaltbytes/usine/issues/1380).

## Method

Every finding is tagged: **verified** means a run of the real 2.3.2 binary showed it; **source**
means it was read in the OpenCode source at tag `v2.3.2` and not run; **unverified** means
neither was possible here. Source references point to
[`anomalyco/opencode` at `v2.3.2`](https://github.com/anomalyco/opencode/tree/v2.3.2).

- **Machine.** A boxd worker with 2 vCPUs and 8 GB of memory, Linux 6.18, Node.js 22.23.5, no
  container runtime, and no SSH server.
- **Binary.** `npm install @opencode/cli@2.3.2` in a scratch directory; the probes ran the
  `@opencode/cli-linux-x64` binary directly. Each run had its own `HOME` and `XDG_*` directories.
- **Model calls.** A scripted OpenAI-compatible Chat Completions server on loopback, configured
  through `OPENCODE_CONFIG_CONTENT` as an `openai-compatible` provider. It records every request
  and its headers, and answers by markers in the prompt: call `shell` with `sleep N`, call
  `subagent`, start a background shell, call an MCP tool, or return HTTP 429 with `retry-after`
  or an `insufficient_quota` body. No paid account was used.
- **Network.** `HTTPS_PROXY` and `HTTP_PROXY` pointed at a logging proxy that refuses every
  connection, so the log lists each host that OpenCode tried to contact.
- **Process owner.** A throwaway test in `packages/agents`, not committed, called
  `startChildProcess` with an `ExecShell` whose transport runs `sh -c` locally. The real worker
  owner program ran each child, as on a boxd worker.

Not covered: `RemoteShell` and container hosts (no SSH server or container runtime here), real
provider accounts (OpenCode Go or Zen, ChatGPT), and macOS or Windows workers.

## 1. Transport

### Options compared

| | `opencode acp` | `serve` behind a stdio bridge | `serve` over a forward |
| --- | --- | --- | --- |
| Runs on every host kind through `ChildHost` | Yes: JSON-RPC over standard streams | Yes: JSON lines over standard streams | No: needs a new forward operation, and boxd's `ExecShell` has no port forward |
| Worker process owner, lease, reattach | Verified | Verified | The event stream bypasses the owner; events during a disconnect are lost |
| Replay fixtures at the `ChildHost` boundary | Yes | Yes | Needs an HTTP and SSE recording format |
| Prompt during a turn | Refused; `_session/steering` extension instead | `delivery: "steer"` | Same as the bridge |
| Which steer the model read | Not reported | `session.inbox.delivered` with the client's message ID | Same as the bridge |
| Work after the turn ends (background shells, subagents) | No boundary and no tokens for the turns it wakes | Execution events and a jobs list | Same as the bridge |
| Close OpenCode's own tools exactly | No: `skill` stays | Yes, per session | Yes |
| usine code on the worker | None | The bridge, shipped like the owner program | None |

### `opencode acp`

`opencode acp` starts a private `opencode serve --stdio` and translates between ACP over its
standard streams and that server's HTTP API
([`acp.ts:25`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/commands/handlers/acp.ts#L25)).
It speaks ACP protocol version 1 with `@agentclientprotocol/sdk` 1.6.0
([`service.ts:134`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/service.ts#L134),
[`package.json:29`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/package.json#L29)).
ACP v2's prompt during a turn isn't in 2.3.2.

- **A prompt during a turn is still refused (verified).** A second `session/prompt` during a
  running shell tool returned JSON-RPC error `-32603`, `Session already has an active ACP prompt`
  ([`turn.ts:420`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/turn.ts#L420)).
- **Steering is an extension (verified).** `initialize` advertises `_meta.steering.supported`, and
  `_session/steering` returns `{"outcome":"injected"}` during a turn and
  `{"outcome":"promptRequired","reason":"noRunningTurn"}` on an idle session. The source calls it
  an "interim extension until ACP has native mid-turn steering"
  ([`agent.ts:120`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/agent.ts#L120)).
  The model read the steer at its next request, after the running tool finished, and one
  `session/prompt` response covered both. A steer sent while the final answer streamed also
  joined the same turn, as one more step.
- **No read signal.** The steer reply has no message ID, and the translator consumes
  `session.inbox.delivered` without forwarding it
  ([`translate.ts:133`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/translate.ts#L133)).
  A client can only treat every injected steer as read when the turn ends. That fails in one
  window: the extension checks that the session is running, then enqueues with `resume: false`
  ([`turn.ts:435-447`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/turn.ts#L435-L447)),
  so a steer that arrives as the turn ends stays queued and unread, but was reported `injected`.
- **Work after `end_turn` (verified).** With a background shell or a subagent, `session/prompt`
  returns `end_turn` while the work runs. When the work ends, OpenCode wakes the session and the
  model answers again; ACP forwards only that turn's `agent_message_chunk` frames, with no start,
  no end, and no `usage_update`. With the `opencode/child-session-updates` client capability,
  subagents also report `opencode/session/child_update` notifications with a terminal status;
  background shells report nothing when they end. This matters because the `shell` tool moves
  any command still running after its two-minute default timeout to the background
  ([`shell.ts:28`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/tool/plugin/shell.ts#L28),
  [`shell.ts:51`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/tool/plugin/shell.ts#L51)).
  A test suite that runs for three minutes ends the coding agent's ACP turn early, and the
  adapter can't tell when the real answer arrives.
- **Tools.** OpenCode accepts stdio and HTTP MCP servers in `session/new` and refuses the ACP MCP
  transport, which sends MCP messages over the ACP connection
  ([`sessions.ts:13`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/sessions.ts#L13),
  [`service.ts:266-276`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/service.ts#L266-L276)).
  A worker-side MCP server would need its own relay back to the orchestrator. Permissions come
  only from configuration, where `skill` stays in the tool list (section 2).
- **Process owner (verified).** Through the real owner, `opencode acp` took a steer and answered,
  exited 0 on end of input with a 7 KB stderr tail, and exited 143 with no OpenCode process left
  when killed during a tool call. The tail needs `OPENCODE_PRINT_LOGS=1`; without it, the private
  server's output is discarded
  ([`standalone.ts:29`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/services/standalone.ts#L29)). After a detach in the middle of a tool call and a `resume`
  launch, the owner reported `retained: true` and replayed the rest of the turn, including the
  response to the prompt that the first connection had sent.

### HTTP server behind a bridge

`opencode serve --stdio` binds loopback TCP, prints `{"url": ...}`, and treats end of file on
its standard input as the end of its lease
([`server-process.ts:219`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/server-process.ts#L219)).
In that mode it deletes the password variables from its own environment, so tool commands don't
inherit them ([`server-process.ts:88`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/server-process.ts#L88)).

The prototype bridge is a Node.js program of 77 lines. It generates the server password,
which never leaves the worker, starts `serve --stdio`, subscribes to `GET /api/event` before it
reports ready, and then relays:

- each request line, such as `{"id":3,"method":"POST","path":"/api/session/<id>/prompt","body":{...}}`,
  as an authenticated HTTP request, and its answer as `{"id":3,"status":200,"body":{...}}`;
- each event as `{"event":{...}}`;
- OpenCode's warnings on standard error, into the owner's bounded stderr tail;
- end of input as end of input to `serve`, then `serve`'s exit code as its own.

Verified through the real process owner:

- Start: ready in 0.56 s, a session created 0.06 s later.
- Steer by ID: `session.inbox.delivered` had the client's message ID.
- Detach and resume: the owner detached during a tool call and a `resume` launch adopted the
  bridge with `retained: true`. Events continued without a gap in the per-session sequence numbers,
  because the bridge kept its event subscription on the worker while the orchestrator was away.
- Kill: during a tool call, exit 143; `serve`, its terminal daemon, and the `sleep` all stopped.
- End of input: exit 0, and the stderr tail contained the bridge's own two lines.
- Restart past the lease: a new bridge on the same data directory reopened the killed session,
  ran nothing until prompted, and answered a new prompt.

The event stream itself is volatile: frames have no `id`, and the per-session log at
`/api/experimental/session/:id/log` returns only its `log.synced` marker under `serve`, because
the CLI doesn't turn on event persistence (source,
[`bus.ts:214`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/bus.ts#L214); verified empty).
The bridge design doesn't depend on it: the owner journals the bridge's output, so only a process
that outlives its lease needs to rebuild state, from the session, its messages, its inbox, and the
jobs list.

### HTTP server over a forward

The orchestrator would open the HTTP connection and the event stream through a port forward. That
needs a new `ChildHost` operation on every host kind: an SSH `-L` forward with `ControlPath=none`,
a container that shares the host network, and, on boxd's `ExecShell`, a relay process, because
boxd's exec API forwards no ports. That relay is a bridge. The event stream would run outside the
owner's journal, so every orchestrator restart loses the events between disconnect and
reconnect, and serve's empty durable log can't replay them. Replay tests would need a second
fixture format for HTTP and SSE. This option costs the most and gives nothing that the bridge
lacks.

### Other modes

None in 2.3.2. `serve` binds TCP only
([`process.ts:151`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/server/src/process.ts#L151));
`--stdio` adds the lease and the JSON ready line, and `--service` runs a shared background server
for the desktop app and the terminal UI. No mode serves the API over a socket or over standard
streams, apart from ACP.

### Recommendation

Use the bridge. The coding agent's result is its final answer, so the adapter has to know when
background work ends and which operator message the model read; only the HTTP API reports both.
The bridge keeps everything else that ACP gets from `ChildHost`: one child process per session
on every host kind, the owner's lease and journal, and replay fixtures at the same boundary.

**`ChildHost` and the process owner gain nothing.** The bridge is an ordinary child command. Deploy
it the way `packages/agents` deploys the owner program, as a bundled script run with `node -e`;
Node.js is already a worker requirement. No contract issue precedes the adapter.

**A generic ACP client isn't the design for OpenCode 2.3.2.** OpenCode's ACP layer is v1 plus
OpenCode extensions, and it drops the read signal and the background boundaries. ACP v2's prompt
during a turn would replace `_session/steering`, not report background work. Reconsider when
OpenCode speaks ACP v2 and reports turns that background work starts; a generic client with
per-agent flavors, as in t3code ([t3code study](./t3code-harness-encapsulation.md)), would then
also serve other ACP agents.

## 2. Capabilities

On the recommended transport. `Capability` is defined in
[`capability.ts:3-16`](../../packages/agents/src/harness/capability.ts).

| Capability | On the bridge | Evidence |
| --- | --- | --- |
| `durable-coordination` | Lacking: OpenCode doesn't journal usine tool intents and results. After a process dies, the in-flight tool call is failed with `Tool execution interrupted` and no turn continues. | Verified |
| `resume-session` | Supported: a session is stored as rows in the data database, and a new `serve` on the same data directory reopens it by ID. Nothing runs until a prompt, so the continuation policy's one message starts the continuation. | Verified |
| `steer` | Supported: `POST /api/session/:id/prompt` with `delivery: "steer"` and a usine `msg_…` ID; `session.inbox.delivered` reports the read with that ID. | Verified |
| `interrupt` | Supported: `POST /api/session/:id/interrupt` answered in 11 ms and killed the shell command about 20 ms later. A steer queued before the interrupt stays pending, and `?resume=true` runs it at once. A steer accepted after the answer starts a new execution as soon as the old one settles (see "Steer after an interrupt"). | Verified |
| `usine-tools` | Supported through MCP: the API client hosts an MCP server over a WebSocket at `/api/experimental/client-mcp`, and the model sees its tools as `<server>_<tool>`. The bridge relays the socket's messages as lines. | Verified at the API; relay not prototyped |
| `closed-tools` | Supported: session `permissions` remove tools from the model's list exactly. | Verified |
| `structured-output` | Lacking: no session or prompt option constrains the answer to a JSON Schema. `/api/experimental/generate/decisions` returns only predicate, choice, and score answers. | Source; no recorded request had `response_format` |
| `ephemeral` | Lacking: every session is saved. Deleting it removes its rows but not its shell output files; `OPENCODE_DB=:memory:` keeps a whole server process in memory. | Verified |
| `token-usage` | Supported: `session.step.ended` per step, `session.usage.updated` cumulative, and totals on the session. | Verified |
| `cost-usd` | Supported where a price exists: the provider's reported cost, else the catalog price, else 0. Configuration can set prices per model. | Verified for 0; source for prices |
| `plan-windows` | Lacking: OpenCode reports no window for third-party plans. It reads OpenCode Go meters only for a signed-in OpenCode Console account (`/api/experimental/usage/limits`, `null` otherwise). | Verified `null`; Go unverified |
| `model-check` | Supported: `GET /api/model?location[directory]=…` lists models and their variants; a run with an unknown model or variant fails with `provider.no-route`. A malformed provider in the configuration is skipped with a warning, and the session falls back to the default model, so check the session's model before the first prompt. | Verified |

With that profile, `admitBrain` admits the coding agent (saved, interventions, all native tools,
no usine tools) and the supervisor (read tools, usine tools, saved, interventions). It refuses
the decision completion, which needs `structured-output` and `ephemeral`, and the coordinator,
which needs `durable-coordination`.

### Read signal for a queued message

A steer posted during a tool call is delivered at the next step boundary, after the tool
finishes: `session.tool.success`, `session.step.ended`, then `session.inbox.delivered` with
`inboxID` set to the client's ID, then the model request that contains it (verified). A message
posted with `delivery: "queue"` is delivered when the running execution goes idle. The adapter
acknowledges operator messages by ID with these events.

Message IDs must start with `msg_` and be unique in the data database, not only in the session:
reposting an ID in the same session returns the first record, and the same ID in another
session returns `409 ConflictError` (verified). Derive them from usine's operator message IDs
with a per-attempt prefix.

### Steer after an interrupt

`/interrupt` answers before the execution's cleanup settles
([`execution.ts:190-193`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/execution.ts#L190-L193)).
A steer posted after that answer starts a successor execution when the old one settles, without
`?resume=true`. In the probe, the steer's `POST` returned 200, `session.execution.interrupted`
arrived 44 ms after the interrupt's answer, `session.execution.started` 1 ms later, and then
`session.inbox.delivered` with the steer's ID and `session.execution.succeeded` (verified). A
steer posted 300 ms before the interrupt started no execution and stayed in
`GET /api/session/:id/inbox` (verified).

So `session.execution.interrupted` doesn't end the turn while a steer accepted after the interrupt
is still undelivered: the adapter waits for the successor execution and its result. PR #1001 had
the same race (section 7).

### usine tools

MCP is the only way to give a session tools that the client executes. Three sources exist, all
scoped to a directory rather than a session: `mcp` in configuration (local stdio or remote URL),
`PUT /api/experimental/mcp/:server`, and the client-hosted WebSocket. The WebSocket is the one
that fits usine: tool calls come back to the adapter over the bridge, and each `tools/call`
has `_meta["ai.opencode/sessionID"]` (verified). Scope a toolkit to its session with session
permissions that deny other sessions' servers.

OpenCode's Code Mode hides MCP tools behind its `execute` tool, which runs JavaScript that calls
them (verified: the model saw `execute` and a catalog naming `tools.usine.echo`). Denying
`execute`, or setting `codemode: false` on the server, exposes them as direct tools
([`tool.ts:281-290`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/tool.ts#L281-L290)).

### Native tools

A tool leaves the model's list when the last permission rule that matches it has resource `*`
and effect `deny`
([`tool.ts:409-412`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/tool.ts#L409-L412)).
The default `build` agent offers `edit`, `experimental_image_generate`, `glob`, `grep`,
`question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, and
`execute` (verified).

- `nativeTools: none`: session permissions `[{"action":"*","resource":"*","effect":"deny"}]`
  plus `{"action":"usine_*","resource":"*","effect":"allow"}`. The model's list was exactly
  `usine_echo`, the probe's MCP tool, and the MCP server received the call (verified).
- `nativeTools: read`: deny `*`, then allow `read`, `glob`, and `grep`; the list is exactly those
  three (verified). With `*` denied, `external_directory` is denied too, so the file tools stay in
  the session directory unless a rule allows it (source).
- The same rules in configuration, as top-level `permissions` or an agent's, leave `skill` in the
  list, because the browser plugin appends a `skill` rule to every agent after configuration loads
  (verified). Over ACP, which takes no session permissions, `skill` can't be removed.

Deny `question` for unattended roles: it opens a form and waits for an answer.

### Rate-limit and plan-limit errors

OpenCode retries rate limits itself: ten retries, exponential from 2 s with a 10 s cap per gap,
each gap at least the provider's `retry-after`, capped at 15 minutes
([`model-retry.ts:12-36`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/model-retry.ts#L12-L36)).
Each retry emits a durable event (verified):

```json
{"type":"session.retry.scheduled","data":{"sessionID":"ses_…","assistantMessageID":"msg_…","attempt":2,"at":1795298656562,
 "error":{"type":"provider.rate-limit","message":"Rate limit reached for requests","status":429,
 "response":{"body":"{\"error\":{…,\"code\":\"rate_limit_exceeded\"}}"},"retryAfterMs":7000}}}
```

With `retry-after: 7` the run failed after about 94 s with `session.execution.failed` and the
same error. A `retry-after` of 15 minutes or more would keep the session waiting for up to 2.5
hours, so the adapter should end the session with `AgentCapacityError` at the first retry whose
`retryAfterMs` exceeds usine's own threshold. The reset time is only `retryAfterMs`: OpenCode parses
`x-ratelimit-reset-*` internally but doesn't report it.

A quota error fails at once, without retries (verified):
`{"type":"provider.quota","message":"You exceeded your current quota, please check your plan and billing details.","status":429,…}`.
OpenCode's plan limits have their own types with no reset time: `provider.go-limit` (the body's
`limitName`, such as a rolling or weekly window), `provider.chatgpt-limit`, `provider.free-limit`,
and `provider.budget-limit`
([`to-session-error.ts:36-60`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/to-session-error.ts#L36-L60)).
Map all of them to `AgentCapacityError` with usine's default capacity delay. Over ACP the same
retries appear as `session_info_update` frames with `_meta["opencode/retry"]`, and a quota error
as JSON-RPC error `-32603` with `data.errorName: "provider.quota"` (verified).

## 3. Isolation

The checkout is untrusted, so OpenCode must read nothing from it except what usine names. The
recipe at the end of this section was verified end to end against a hostile fixture checkout.

### Project configuration

Discovery walks from the working directory up to `/`, not only to the git root, and in each
directory reads `opencode.json`, `opencode.jsonc`, `.opencode/`, `.claude/`, and `.agents/`
([`discovery.ts:77-82`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/config/discovery.ts#L77-L82)).
A `.opencode/plugins/*.js` file runs code in the server process. Without isolation, the fixture's
plugin ran, and its `opencode.json` switched the model to its own provider, whose request sent a
worker environment variable, pulled in with `{env:VAR}`, as its bearer token (verified).

`OPENCODE_CONFIG_PROJECT_DISABLE=1` (alias `OPENCODE_DISABLE_PROJECT_CONFIG`) turns all of it off
([`server-process.ts:124-126`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/server-process.ts#L124-L126)):
the plugin didn't run, the model stayed pinned, and no agent, command, skill, or instruction from
the checkout loaded, including git-tracked ones (verified). Two gaps remain:

- The flag also turns off the checkout's `AGENTS.md`. To keep it, name it with an absolute path
  in `OPENCODE_CONFIG_CONTENT`: `"instructions": ["{env:WORKTREE}/AGENTS.md"]` (verified).
- When the agent reads a file in a subdirectory, that directory's `AGENTS.md` and `CLAUDE.md`
  are still injected
  ([`read.ts:146-169`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/tool/plugin/read.ts#L146-L169)).
  `OPENCODE_DISABLE_CLAUDE_CODE=1` stops the `CLAUDE.md`; nothing stops a nested `AGENTS.md`
  (verified). Treat it like any other file in the checkout.

For settings, `OPENCODE_CONFIG_CONTENT` outranks the project, which outranks `OPENCODE_CONFIG`
and `OPENCODE_CONFIG_DIR` (verified). Permission rules follow the same order, and the last
matching rule wins. Policies go the other way, earliest wins, so a project's `provider.use` allow
beat a deny in `OPENCODE_CONFIG_CONTENT` (verified); policies bind only with the project flag on.
A worker image can pin policies above everything in `/etc/opencode` (source).

### `ask` in a headless run

Every agent starts with `* * allow`, and only reads of `.env` files ask
([`agent.ts:46-51`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/schema/src/agent.ts#L46-L51)).
Reads outside the project are allowed by default (verified). An `ask` never times out:

- Under `serve`, the request waits for `POST /api/session/:id/permission/:requestID/reply`. It was
  still pending after 45 s, and the command hadn't run (verified).
- Under ACP, the client gets `session/request_permission`: allow runs the command, reject ends the
  turn as `cancelled`, and no answer leaves `session/prompt` waiting (verified).

The `question` tool also waits for an answer with no timeout (source). So configure no reachable
`ask`: allow or deny `.env` reads explicitly, deny `question`, and deny `external_directory` for
roles that stay in the checkout. A denied tool leaves the model's list; a call to it returns `No
tool named "shell" is currently available`, and the turn continues (verified).

### Network contacts

OpenCode starts and finishes prompts with every outside host refused; the catalog fetch fails, is
logged, and the bundled snapshot is used (verified). The hosts it contacts, and the switch for
each:

| Host | When | Switch |
| --- | --- | --- |
| `models.opencode.ai` | Every start, then every 5 minutes | `OPENCODE_DISABLE_MODELS_FETCH=1` (verified) |
| `opencode.ai` (free models) | No model pinned, or the pinned provider is malformed: the default becomes a free hosted model | `OPENCODE_DISABLE_FREE_MODELS=1` (verified), and pin `model` |
| `opencode.ai` (Console) | A saved `opencode` credential, or `OPENCODE_API_KEY` in the environment | Keep both off the worker (verified) |
| `github.com` | First `grep` or `glob` without `rg` on `PATH`, to download ripgrep | Install `rg` in the image (verified) |
| Fetched pages, `mcp.exa.ai` | `webfetch`, and `websearch` once a search provider is chosen | Deny both, and set `"websearch": false` (verified) |
| `registry.npmjs.org` | Plugins and formatters named in the configuration | Project flag; formatters are off unless configured (source) |
| Loopback ports 1234, 11434, and 8000 | Every 30 s, looking for LM Studio, Ollama, and vLLM | `baseURL: ""` for `lmstudio`, `ollama`, and `vllm`; a policy deny doesn't stop it (verified) |
| The model endpoint | A second request per session to generate its title | A title at session creation, or `agents.title.disabled` (verified) |

The update check runs only in the terminal UI, 2.x has no session sharing, and telemetry needs
`OTEL_EXPORTER_OTLP_ENDPOINT` (source). With the recipe, the logging proxy recorded no connection
and no loopback discovery ran (verified).

### Recipe

Verified against the hostile fixture: no outbound connection, the plugin never ran, one model
request with the placeholder key, only the root `AGENTS.md` from the checkout, and no saved
credential. Session permissions per role (section 2) apply on top.

```sh
# Per attempt: no shared state and no saved credentials.
export HOME=… XDG_DATA_HOME=… XDG_CONFIG_HOME=… XDG_STATE_HOME=… XDG_CACHE_HOME=…
export OPENCODE_CONFIG_PROJECT_DISABLE=1 OPENCODE_DISABLE_CLAUDE_CODE=1
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_FREE_MODELS=1
unset OPENCODE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY  # and any other catalog provider variable
export GW_TOKEN=<caller token> GW_BASE_URL=<gateway slot URL> WORKTREE=<checkout>
export OPENCODE_CONFIG_CONTENT="$(cat opencode-usine.json)"
```

```json
{
  "model": "gw/<model>",
  "providers": {
    "gw": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "apiKey": "{env:GW_TOKEN}", "baseURL": "{env:GW_BASE_URL}" },
      "models": { "<model>": { "limit": { "context": 200000, "output": 8000 } } }
    },
    "lmstudio": { "settings": { "baseURL": "" } },
    "ollama": { "settings": { "baseURL": "" } },
    "vllm": { "settings": { "baseURL": "" } }
  },
  "policies": [
    { "action": "provider.use", "resource": "*", "effect": "deny" },
    { "action": "provider.use", "resource": "gw", "effect": "allow" },
    { "action": "plugin.use", "resource": "*", "effect": "deny" },
    { "action": "mcp.use", "resource": "*", "effect": "deny" },
    { "action": "websearch.use", "resource": "*", "effect": "deny" }
  ],
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "read", "resource": "*.env", "effect": "allow" },
    { "action": "read", "resource": "*.env.*", "effect": "allow" },
    { "action": "external_directory", "resource": "*", "effect": "deny" },
    { "action": "question", "resource": "*", "effect": "deny" },
    { "action": "webfetch", "resource": "*", "effect": "deny" },
    { "action": "websearch", "resource": "*", "effect": "deny" }
  ],
  "websearch": false,
  "formatter": false,
  "warming": false,
  "agents": { "title": { "disabled": true } },
  "instructions": ["{env:WORKTREE}/AGENTS.md"]
}
```

The `mcp.use` deny blocks configured MCP servers; a role with usine tools allows its own server
instead. The recipe doesn't sandbox shell commands, which run with the server's environment,
`GW_TOKEN` and `OPENCODE_CONFIG_CONTENT` included (verified). That is why the gateway, not the
worker, has the model key.

## 4. Credentials

- **Storage.** Saved credentials are plain JSON in the `credential` table of the data database,
  `$XDG_DATA_HOME/opencode/opencode.db`, file mode 0600. `OPENCODE_DB` moves the database, and a
  legacy `auth.json` is imported once (source; row contents verified).
- **Precedence.** A saved credential beats a provider's environment variable, which beats
  `settings.apiKey` in the configuration
  ([`integration.ts:387-401`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/integration.ts#L387-L401),
  [`model-resolver.ts:302-307`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/model-resolver.ts#L302-L307)).
  A stray `OPENAI_API_KEY` or `OPENCODE_API_KEY` on the worker, or a data directory where someone
  once ran `opencode auth login`, silently replaced the gateway placeholder (verified).
- **One process, a static key, and a base URL.** `"settings": {"apiKey": "{env:GW_TOKEN}",
  "baseURL": "{env:GW_BASE_URL}"}` in `OPENCODE_CONFIG_CONTENT` sent the key in `authorization`
  to that base URL and saved nothing (verified). The data directory still receives sessions,
  logs, shell output, and an undo snapshot store, so each attempt gets its own. Set
  `XDG_DATA_HOME` and `OPENCODE_DB` for the `serve` process only; the session's shell
  environment (`PUT /api/session/:id/environment`) can restore the worker's `XDG_DATA_HOME` for
  tool commands, so pnpm keeps its shared store (source).
- **Headers on every model request.** `x-opencode-session-id`, `x-opencode-session`,
  `x-session-affinity`, `X-Session-Id`, `x-opencode-project` (a hash that identifies the
  repository), `x-opencode-client`, and `User-Agent: opencode/latest/2.3.2/<client>`, plus parent
  session IDs for subagents
  ([`model-request.ts:321-334`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/model-request.ts#L321-L334)).
  Responses requests also send `prompt_cache_key` with the session ID (verified).
- **OpenCode's plan endpoints.** Zen is provider `opencode` and Go is `opencode-go`, each with one
  upstream base per protocol; for Go, `https://opencode.ai/inference/go/openai/v1`,
  `…/go/anthropic/v1`, and `…/go/google/v1beta`. The key goes in `authorization: Bearer` for
  OpenAI protocols, in `x-api-key` with `anthropic-version` and `anthropic-beta` for Anthropic,
  and in `x-goog-api-key` for Google (verified against the fake endpoint). OpenCode needs no
  header passed through; forwarding the session headers and `prompt_cache_key` keeps the
  provider's cache affinity. Whether Zen or Go require a header server-side is unverified without
  an account.
- **A gateway that holds the key.** A placeholder key and a `baseURL` override on `opencode-go`
  or `opencode` sent every request to the gateway with the placeholder, and OpenCode contacted no
  OpenCode host (verified). For the slot in #1380, the gateway must:
  1. map each path under the one base URL (`/chat/completions`, `/responses`, `/messages`,
     `/models/<id>:streamGenerateContent`) to that protocol's upstream base, unless the descriptor
     pins models of one protocol, the title model included;
  2. put the key in the header that the protocol uses, not only `authorization`;
  3. return error bodies unchanged, because OpenCode recognizes Go and Zen limit errors by body
     code ([`provider-error.ts:89-99`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/ai/src/provider-error.ts#L89-L99)).

## 5. Background work and subagents

Since 2.3.0, the `subagent` tool always runs its child in the background and returns at once with
the child's session ID. A `shell` call with `background: true`, and any command still running
after its timeout, also returns at once. The parent's execution ends while the work runs (verified).

When the work ends, OpenCode queues a synthetic inbox item on the parent, such as
`<subagent sessionID="ses_…" state="completed" description="probe child">…</subagent>` or
`<shell id="sh_…" state="completed" command="…">…</shell>`, which wakes the parent for another
execution. One task can therefore produce several `session.execution.succeeded` events.

What the HTTP API reports (verified):

- A subagent: `session.created` with `parentID`, then the child's own events under its session ID;
  the child appears in `GET /api/session/active` while it runs. `GET /api/session?parentID=…`
  lists children.
- A background shell: `shell.created`, `shell.exited`, and a job in
  `GET /api/experimental/job?sessionID=<root>&descendants=true` until it ends.
- Done means no active execution, no running job for the session tree, and an empty inbox.
  `opencode run` waits the same way, printing `waiting for N background job(s)`.

The adapter's session result is the last answer after that point, and tokens include every woken
execution. Over ACP, subagents report `opencode/session/child_update` status notifications with
the capability above, background shells report nothing when they end, and woken turns report
neither a boundary nor tokens (section 1).

Background work stops with the session's process: after end of input, and after SIGKILL of the
child, no `opencode-pty` daemon or command was left running (verified). The terminal daemon
stops with its terminals when its owner connection drops, unless the server first prepared a
handoff to a successor
([`process-daemon/README.md:27`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/process-daemon/README.md)).

## 6. Install and footprint

- **Packages.** `@opencode/cli` 2.3.2 is an 8.2 kB launcher with a `postinstall` script and
  twelve optional platform packages. The script picks one by OS, CPU, libc, and AVX2 support,
  hard-links its binary to `bin/opencode.exe`, and runs `--version` to check it. On Linux x64,
  npm installs all four x64 variants (`-linux-x64`, `-baseline`, `-musl`, `-baseline-musl`),
  because they declare no `libc`: 972 MB on disk for one 242 MB binary (252,848,304 bytes). The
  worker image should install the matching platform package only, which needs one step beyond
  the descriptor's `install` list.
- **First run.** The binary extracts `opencode-pty` 0.6.0 (3.5 MB) to `~/.cache/opencode/bin` on
  the first shell command, and creates a 1 MB data directory with 62 database migrations
  (59 ms). `HOME` and the `XDG_*` directories must be writable, and `rg` must be on `PATH`
  (section 3). Four processes that started together on one fresh data directory lost one to a
  migration race, `table already exists`, because the migration lock is per process (verified;
  [`database.ts:52-67`](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/database/database.ts#L52-L67)).
  A data directory per attempt avoids it.
- **Start time** on 2 vCPUs and 8 GB, cold cache excluded:
  - `opencode --version`: 0.18 s.
  - Bridge ready: 0.56 to 0.59 s; a session created 0.06 s later.
  - ACP: `initialize` in 0.6 to 1.2 s, `session/new` at 2.1 to 2.4 s (4.0 s on the first run).
  - A one-step prompt through ACP: 2.4 to 2.7 s from start.
- **Memory** during a tool call: `serve` 291 to 310 MB RSS, the Node.js bridge 65 to 71 MB, and
  `opencode-pty` 6 MB, so about 370 MB per session. ACP has a 116 MB `opencode acp` process
  instead of the bridge, about 425 MB in all. `serve` settled at 256 MB when idle, and used about
  half a vCPU on average over its first 6 seconds.

## 7. Review findings from PR #1001

| Finding | With the bridge |
| --- | --- |
| P0: the server password went into the SSH remote command, where process listings show it | Gone: the bridge generates the password on the worker and passes it to `serve` in its environment, so no command line or SSH connection carries it. |
| P1: the OpenCode wiring exported `XDG_DATA_HOME` to every child of the attempt | Gone for other harnesses: step 15 builds each child's environment from its own harness's wiring only ([`environment.ts:156-157`](../../packages/executor/src/ssh/gateway/environment.ts)). Kept as a requirement for OpenCode itself, whose tool commands inherit `serve`'s environment: isolate its state per attempt without moving `XDG_DATA_HOME` for those commands (section 4). Saved credentials beat the placeholder, so the per-attempt directory is required. |
| P2: server failures had no diagnostics | Gone: the bridge passes OpenCode's warnings to standard error, where the owner keeps a bounded tail and the exit code, as for every child. With `serve --print-logs --log-level warn`, a malformed provider in the configuration put its warning in that tail (verified). Kept: test an exit before readiness. |
| P2: the SSH forward lacked `ControlPath=none` and ignored its output | Gone: no forward. |
| P2: guidance accepted while an interrupt settled was lost, because the old execution's `interrupted` event ended the session | Kept as a requirement: 2.3.2 still answers `/interrupt` before cleanup settles, and a steer accepted after the answer starts a successor execution. `session.execution.interrupted` doesn't end the turn while that steer is undelivered (section 2, "Steer after an interrupt"). The `interrupt-guidance` scenario sends the guidance after the session goes idle, so it covers a steer after the old execution settles, not this race; the adapter adds a runtime test of the race (follow-up issues). |
| P2: CI tested neither the transport nor `interrupt` | Kept as a requirement: replay fixtures at the `ChildHost` boundary for the shared scenarios, including `interrupt-guidance`, `steer`, and `restart`, plus unit tests of the bridge against a scripted fake server (readiness, crash, garbage, slow start, end of input). |
| P2: preflight skipped the model check on gateway routes | Kept: preflight checks the model on every route through `GET /api/model`, which needs no provider request. |
| P3: an unexpected event shape failed the whole session | Kept: log and skip unknown event types and shapes; the pin limits drift. |
| P3: the readiness deferred failed before `PlatformError` was caught | Gone: the bridge reports readiness, and the owner reports an exit before it. |
| P3: both password variables were exported to tool commands | Gone: the bridge generates the password, passes `OPENCODE_PASSWORD` to `serve` only, and `serve --stdio` deletes it from its environment. |
| P3: Cloudflare wiring and image installed OpenCode while admission refused sandboxes | Kept: the sandbox placement needs its own check of the bridge on the sandbox shell. Until then, leave OpenCode out of the Cloudflare image and wiring. |
| P3: a duplicate of the executor's `freeLocalPort`, and delivery keyed by message text | Gone: `serve` picks its port, and delivery is keyed by message ID. |
| Open question: `instructions: ""` on the gateway Responses request | Gone with the setting: 2.3.2 sends the system prompt as a leading developer message on every Responses route ([CHANGELOG](https://github.com/anomalyco/opencode/blob/v2.3.2/CHANGELOG.md)); recheck the gateway request shape when the descriptor is written. |

## Follow-up issues

**OpenCode adapter on `@opencode/cli` 2.3.2.** The only follow-up; no `ChildHost` or process-owner
issue precedes it.

- A bridge program in `packages/agents`, bundled and run with `node -e` like the owner program:
  start `serve --stdio` with a generated password, relay requests, events, and the client-hosted
  MCP WebSocket as JSON lines, pass warnings to standard error, and exit with `serve`'s code on end
  of input. Unit tests against a scripted fake `serve`.
- A runtime in `packages/agents/src/harness/opencode/`: sessions created with a title (no
  title-generation calls), usine-derived `msg_` IDs, session permissions per role, steering and
  interrupt, reads acknowledged by `session.inbox.delivered`, the result after background work
  ends, tokens and cost per step, retries and plan limits mapped to `AgentCapacityError`, and
  resume from the data database. `session.execution.interrupted` doesn't end the turn while a
  steer accepted after the interrupt is still undelivered (section 2, "Steer after an interrupt").
  A runtime unit test feeds bridge events in the probe's order and asserts that the session
  doesn't finish at the old event: the interrupt's answer, the steer accepted, the old
  `session.execution.interrupted`, `session.execution.started`, `session.inbox.delivered` with
  the steer's ID, then `session.execution.succeeded`.
- A descriptor with the capability profile in section 2, the isolation and credential
  environment in sections 3 and 4, and an install entry that installs only the matching platform
  binary.
- Replay fixtures recorded against the pinned binary with a controlled model endpoint, for the
  shared scenarios that the profile declares, and `capabilityProofs` entries for `model-check`.
- Rewrite ADR 0005, whose decision names three harnesses, and the "Three harnesses" direction in
  `AGENTS.md`.

The OpenCode Go provider entry for the gateway belongs to #1380.
