# Pi on workers: `pi --mode rpc` on Pi 1.4.0 and 1.6.0

Research for [issue #1399](https://github.com/basaltbytes/usine/issues/1399). It settles how Pi
children run on SSH, container, exec, and sandbox workers before any adapter code, as step 21 of
[harness-contract-and-roles.md](./harness-contract-and-roles.md#21-pi-sessions-on-workers) plans.
It builds on the shared conversation with receipts (#1282, #1388), billing pools declared by
descriptors (#1379), background work as a snapshot (#1378), and the line-protocol requests module
(#1385). Snapshot date: 2026-11-22.

The repository pins **`@earendil-works/pi-coding-agent` 1.4.0**. The newest release on npm is
**1.6.0** (published 2026-11-20). The main probes ran on both, and section 9 lists the
differences. The adapter should pin 1.6.0.

## Summary

- **Transport.** Run `pi --mode rpc` as an ordinary child through `ChildHost` and the worker
  process owner, as the Codex app server runs. Pi's own standard streams carry JSON lines with
  request IDs, so no bridge program is needed. Through the real owner, Pi took a steer and kept
  running through a detach, the owner replayed the events that Pi wrote while usine was away, and
  Pi stopped cleanly on kill.
- **One `ChildHost` addition.** Pi writes lines with no upper bound: `agent_end` carries every
  message of a run and reached 4.75 MiB after 100 tool results of 49 KB, and a `read` of a 3.4 MB
  image gave an 8.53 MiB `tool_execution_end`. usine's line reader fails the session above 4 MiB.
  The reader needs a mode that drops an oversized line and keeps reading. The per-attempt
  `models.json` caps images for every model, including text-only ones, so that every event the
  adapter needs stays under the limit. A `host-login` session on a local worker keeps the host's
  agent directory and has no such cap, so the client counts a dropped `tool_execution_end` instead.
  The process owner needs nothing.
- **Capabilities over RPC.** Supported: `resume-session`, `steer`, `interrupt`, `usine-tools`,
  `closed-tools`, `structured-output`, `ephemeral`, `token-usage`, `cost-usd`, and `model-check`.
  Lacking: `durable-coordination` and `plan-windows`. That is the profile of today's local
  in-process path.
- **Tools in band.** A usine extension, loaded with `-e`, registers the session's tools. Each call
  becomes an extension UI `input` dialog on Pi's standard output, and the adapter answers it on
  standard input. The same extension gives `bash` an exact environment and implements the pause
  gate.
- **One path.** RPC replaces the in-process path for Pi children on every placement, local workers
  included. The Pi parent in `packages/durable` stays in process.
- **Follow-ups.** Four issues, scoped at the end of this note: the `ChildHost` line reader, the
  extension and its client, the RPC runtime with its descriptor, and a gateway route for Pi's
  ChatGPT requests.

## Method

Every finding is tagged: **verified** means a run of the real CLI showed it, on both 1.4.0 and
1.6.0 unless the tag names one version; **source** means it was read in the installed package and
not run; **unverified** means neither was possible here. Source references are paths in the 1.4.0
package `@earendil-works/pi-coding-agent` (or `@earendil-works/pi-ai`, where named).

- **Machine.** A boxd worker with 2 vCPUs and 8 GB of memory, Linux 6.18, Debian 13, Node.js
  22.23.4, an egress allowlist, no container runtime, and no SSH server.
- **CLI.** 1.4.0 from the repository's `pnpm install`, started as
  `node dist/bundle/cli.js --mode rpc`. 1.6.0 from `npm install` in a scratch directory. Each run
  had a clean environment (`env -i`) and its own `HOME`, `PI_CODING_AGENT_DIR`, and checkout.
- **Model calls.** A scripted OpenAI-compatible Chat Completions server on loopback, configured as
  a custom provider in the agent directory's `models.json` with
  `"api": "openai-completions"`, `"apiKey": "$GW_TOKEN"`, and prices. It records each request and
  its headers, and answers by markers in the prompt: call `bash` with `sleep N`, chain calls, call
  a named tool, return a large answer, or return HTTP 429 (`retry-after` 2 or 3600),
  `insufficient_quota`, `usage_limit_reached`, or 500. Requests on the Responses, Messages, and
  ChatGPT paths were logged and answered with 404, to read their headers. No paid account was
  used.
- **Network.** A `--require` preload logged every `dns.lookup` and socket `connect` of the Pi
  process.
- **Process owner.** A throwaway test in `packages/agents`, not committed, called
  `startChildProcess` with an `ExecShell` whose transport runs `sh -c` locally, so the real worker
  owner program ran Pi, as in the [OpenCode study](./opencode-adapter.md).

Not covered: `RemoteShell` and container hosts (no SSH server or container runtime here), real
provider accounts, the ChatGPT backend, the Cloudflare sandbox shell, and macOS workers.

## 1. Transport

### The protocol

`docs/rpc.md`, `docs/rpc-commands.md`, and `docs/json.md` in the package describe it.

- **Framing.** One JSON object per line, split on LF only; a CR before the LF is dropped. Pi's
  reader (`dist/modes/rpc/jsonl.js:18`) has no line limit and doesn't split on U+2028 or U+2029.
  A prompt that contains U+2028 arrived whole, and Pi writes U+2028 unescaped inside strings
  (verified on 1.6.0). usine's `boundedLines` splits on byte 10 only, so it reads such lines
  correctly. An unterminated line waits for the next LF and joins it (verified).
- **Commands.** 33 command types in 1.4.0 (`dist/modes/rpc/rpc-types.d.ts`). The adapter needs
  `prompt` (with `streamingBehavior`), `abort`, `get_state`, `get_available_models`,
  `get_available_thinking_levels`, `get_session_stats`, and `extension_ui_response`; `get_entries`
  with `since` is a durable cursor into the saved session.
- **Responses.** `{"id","type":"response","command","success","data"}` or `"error"`. The `id` is
  echoed as sent, a number too (verified). Pi starts each line's handler without waiting for the
  previous one (`dist/modes/rpc/rpc-mode.js:645`), so answers can arrive out of order: `abort`
  answers after the run settles, and a later `get_state` answers first. `pendingRequests` in
  `packages/agents/src/child-host/requests.ts` already correlates by ID, including the process
  owner's `<generation>:<sequence>` string IDs.
- **Events.** `agent_start`, `turn_start`, `message_start`, `message_update` (deltas only),
  `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
  `turn_end`, `agent_end`, `agent_settled`, `queue_update`, `compaction_start`, `compaction_end`,
  `auto_retry_start`, `auto_retry_end`, `entry_appended`, `extension_ui_request`, and
  `extension_error`. Message roles are `system`, `user`, `assistant`, and `toolResult`. Events
  carry no sequence number or ID, and RPC writes no session header. `agent_settled` means Pi
  won't continue by itself (`docs/json.md`).
- **Errors** (verified):
  - Malformed JSON or an empty line: `{"type":"response","command":"parse","success":false,
    "error":"Failed to parse command: …"}`, with no `id`.
  - A JSON value that isn't an object, such as `[]` or a string:
    `{"type":"response","success":false,"error":"Unknown command: undefined"}`.
  - An unknown `type`, or a command without its fields: an error response with the `id`.
  - **A `null` line ends Pi** with exit code 1 and
    `TypeError: Cannot read properties of null (reading 'id')` on standard error: the error
    handler reads `command.id` again (`rpc-mode.js:635`). The adapter encodes every command from a
    schema and never sends one.
  - Provider failures after a prompt is accepted arrive in the message stream (section 3).
- **Closed stream** (verified). End of input shuts Pi down within 11 to 21 ms: it disposes the
  session, kills the running tool's process group, and exits 0 (`rpc-mode.js:642`). SIGTERM exits
  143 and SIGHUP 129, and both kill tool process groups (`rpc-mode.js:276-282`). SIGKILL leaves the
  running `bash -c` and its children behind, because the bash tool starts each command in its own
  session (`dist/core/tools/bash.js:65`). After end of input during a tool call, 1.4.0 saves
  nothing after the assistant's tool call; 1.6.0 saves an `aborted` assistant message.
- **Standard output.** Pi writes only protocol lines there: other writes to `process.stdout`, from
  extensions or libraries, go to standard error (`dist/core/output-guard.js:38`). Pi waits when
  standard output is full, so a reader that stops reading stalls it.

### The largest line

Measured on 1.4.0; the run with 100 tool results gave the same `agent_end` size on 1.6.0, and the
image rows are the same on both versions:

| Line | Largest seen | What bounds it |
| --- | --- | --- |
| `agent_end` after one run with 100 `bash` results of 49 KB | 4.75 MiB | Nothing: it carries every message of the run, the system prompt included |
| `message_update`, `message_end`, `turn_end`, `agent_end` for a 5 MB answer | 4.88 MiB each | The model's output limit |
| `get_messages` or `get_entries` after those runs | 14.6 MiB | Nothing: the whole session |
| `tool_execution_end` for `bash` or for a `read` of text | 0.09 to 0.15 MiB | Pi truncates text output to 50 KB or 2,000 lines |
| `tool_execution_end` for a `read` of a 1,657,003-byte PNG | 4.21 MiB | The image's base64, twice: in `content` and in `structuredContent` |
| `tool_execution_end` for a `read` of a 3,355,433-byte PNG | 8.53 MiB | The same |
| `message_start`, `message_end`, `turn_end`, `agent_end` for that `read` | 4.27 MiB each | The image's base64, once |
| `tool_execution_end` for a `read` of a 3,356,804-byte PNG on a model without image input | 8.54 MiB | The same: Pi keeps the image |
| `tool_execution_end` for the same `read` with images capped at 1 MiB | 1.84 MiB | The cap in `models.json`, twice |

Pi doesn't truncate an image. It sends an image as it is while its base64 is under 4.5 MiB and
its sides are at most 2,000 pixels, and resizes it otherwise
(`dist/utils/image-resize-core.js:9,54`). A model's `inputLimits.images.resize.maxBytes` in
`models.json` lowers that limit for new images, and a `modelOverrides` entry sets it for a
built-in model (`docs/models.md`). A 1.6 MB screenshot is an ordinary file in a web repository.

`read` takes the limit from the session model's own `inputLimits`, and it keeps the image when the
model takes no images: 1.4.0 adds a text note to the result (`dist/core/tools/read.js:83-107`),
and 1.6.0 sets `details.imageUnsupportedByModel` (`read.js:210-228` in 1.6.0). A text-only
custom model, a custom model with `input` omitted (the default for a `models.json` entry), and
the built-in text-only `zai/glm-4.7` each gave the 8.54 MiB line uncapped and 1.84 MiB with the
cap, and the other lines of that `read` went from 4.27 MiB to 0.92 MiB (verified).

`MAX_PROTOCOL_LINE_BYTES` is 4 MiB, and `boundedLines` fails the stream on a longer line
(`packages/agents/src/child-host/lines.ts:3,31`). A long coding run crosses that limit with
`agent_end` alone, and one image `read` crosses it with `tool_execution_end`. The adapter needs none
of the messages in `agent_end` or `turn_end`, because each one already arrived in its own
`message_end`. It needs every `tool_execution_end`: in process, each one becomes a `ToolFinished`
event (`packages/agents/src/harness/session.ts:277-285`), and `toolResults` and `toolCallsAtResult`
count those events for receipts. So the per-attempt `models.json` caps images at 1 MiB for every
model it defines or overrides, whatever the model's `input`, which kept the image `read`'s
`tool_execution_end` at 1.84 MiB (verified). A `host-login` session on a local worker has no
per-attempt `models.json` (section 8), so there a large image goes through the drop path below.

### Through `ChildHost` and the process owner

Verified through the real owner, with an `ExecShell` on a local `sh` transport, on both versions:

- **Start.** The first answer came 0.41 to 0.48 s after launch.
- **Steer.** A `prompt` with `streamingBehavior: "steer"` during a tool call was read at the next
  turn.
- **End of input.** Exit 0, and the owner's stderr tail held Pi's warning,
  `No project session found with id 'usine-owner-probe'; creating a new session with that id.`
- **Detach and resume.** The owner detached during a 2-second tool call. The tool finished and the
  run settled while usine was away for 4 seconds. The `resume` launch reported `retained: true`
  (generation 1) and replayed `tool_execution_end` through `agent_settled` with nothing missing.
- **Kill.** During a tool call, `kill` returned after 90 to 97 ms and Pi exited 143. The tool's
  `sleep` was gone, because the owner stops a child with SIGTERM first and Pi then kills its tool
  process groups.

The same command line runs on every host kind: a local process with the lifeline, an `ExecShell`
command, an SSH command, or `<runtime> exec -i` in a container. Only the first two ran here.
Replay fixtures record at the same boundary as Codex's: lines written to Pi's standard input and
lines read from its standard output. The `transport-loss`, `early-exit`, and `credential-changed`
scenarios, which only Claude Code and Codex record today, then apply to Pi too.

### What `ChildHost` and the process owner gain

- **A line reader that drops an oversized line.** `boundedLines` gains an option to discard the
  rest of a line past its limit, report the line's size and first bytes, and continue with the next
  line. Raising the limit doesn't help: `agent_end` has no bound, and `boundedLines` allocates its
  whole buffer up front. A dropped answer fails only its request, by the request's timeout. This is
  follow-up 1.
- **A dropped line that the adapter needs.** With the image cap, the probe's `tool_execution_end`
  stayed at 1.84 MiB, but a `host-login` session has no cap, and a dropped line must still count.
  Pi writes `type`, `toolCallId`, and `toolName` before `result` (`pi-agent-core`
  `dist/agent-loop.js:652-660`; source), so the RPC client decodes them from the reported first
  bytes and emits `ToolFinished` with a null output and `isError: false`. `isError` follows
  `result` on the line, and an error result is short text. The client logs and skips every other
  dropped event. This is follow-up 2.
- **Nothing else.** The lease, the journal, reattach, and the stop with SIGTERM first work
  unchanged.

Not specific to Pi, and not a blocker: a command that a `bash` call starts in the background
(`cmd &`) keeps running after the tool call and after Pi exits (verified on 1.4.0), so stopping Pi
doesn't stop it. Tool processes outlive a SIGKILL of Pi in the same way. A machine per attempt
discards them; on a long-lived SSH worker they run until they exit.

### Recommendation

Start `pi --mode rpc` with `startChildProcess`, as `packages/agents/src/harness/codex/app-server.ts`
starts Codex, and read its lines with the oversized-line option. No bridge program is needed.

## 2. Sessions

- **Where a session is saved.** With `--session-dir D --session-id X`, in `D/<ISO time>_X.jsonl`
  (verified). Without them, under `$PI_CODING_AGENT_DIR/sessions/`, in a directory named after the
  working directory. A checkout's `.pi/settings.json` can set `sessionDir`, and Pi follows it before
  it decides project trust, even with `--no-approve` (verified; `docs/security.md`). The adapter
  therefore always passes `--session-dir`, and keeps today's directory,
  `<checkout>/.usine/pi/sessions` (`packages/agents/src/harness/pi/pi.ts:421`).
- **Format.** JSON lines forming a tree: a header, model and thinking-level changes, then one
  entry per message, appended as each message ends (verified). Pi locks its settings and trust
  files but not session files (`dist/core/settings-manager.js:132`), so only one process may own
  a session. The owner's PID file per child already ensures that.
- **Resume in a new process.** The same `--session-dir` and `--session-id` reopen the session
  (verified). If the file is gone, Pi creates an empty session with that ID and only warns on
  standard error (`dist/main.js:349`; verified); `--session <path>` also creates one (verified on
  1.4.0).
  The adapter therefore checks that `get_state` reports a `messageCount` above 0 before it reports a
  resume, as `SessionManager.findById` does in process (`pi/sdk.ts:370`).
- **Session IDs.** `--session-id` accepts letters, digits, `.`, `_`, and `-`, and must start and
  end with a letter or digit (`docs/cli.md`). Deriving it from usine's child session ID makes the
  saved session's ID known before launch.
- **What a resumed process replays.** Nothing: it writes no line until it gets a command
  (verified). `get_messages` returns the history, and `get_entries` with `since` returns the
  entries after a known entry ID.
- **A cut tool call.** After a SIGKILL during a tool call, the file ends with the assistant's tool
  call and no result. On the next prompt, Pi sends the model a synthetic result,
  `No result provided` (verified; `pi-ai` `dist/api/transform-messages.js:155`).
- **Reattach after an orchestrator restart.** A second Pi process can't join a running turn. The
  process owner keeps the first one running and replays what it wrote (section 1). Past the owner's
  120-second lease, the owner stops Pi; the next launch resumes from the file and runs nothing until
  prompted, so the continuation policy's one message starts the continuation.

## 3. Capabilities

On the recommended transport. `Capability` is defined in
[`capability.ts:3-16`](../../packages/agents/src/harness/capability.ts).

| Capability | Over RPC | Evidence |
| --- | --- | --- |
| `durable-coordination` | Lacking: Pi saves the conversation but keeps no journal of usine tool intents and results. A tool call cut by a crash gets `No result provided`. | Verified |
| `resume-session` | Supported: `--session-dir` and `--session-id` reopen the saved session in a new process, which runs nothing until prompted. | Verified |
| `steer` | Supported: `prompt` with `streamingBehavior: "steer"`. Pi reads it at the next turn boundary and reports the read as a user `message_start`. | Verified |
| `interrupt` | Supported: `abort` stops the running tool, settles the run with `aborted: true`, and only then answers. | Verified |
| `usine-tools` | Supported through the usine extension: each call is an `input` dialog over Pi's standard streams (section 4). | Verified |
| `closed-tools` | Supported: `--no-tools` lists none, and `--tools` lists exactly the tools it names. | Verified |
| `structured-output` | Supported: an extension output tool with `constrainedSampling` and `terminate: true`, answered in one request. | Verified; strict mode depends on the provider's API |
| `ephemeral` | Supported: `--no-session` writes no session file. | Verified |
| `token-usage` | Supported: usage on each assistant `message_end`, and totals from `get_session_stats`. | Verified |
| `cost-usd` | Supported where a price exists, in `models.json` or Pi's catalog; otherwise 0. | Verified for `models.json` prices |
| `plan-windows` | Lacking: Pi reports no subscription windows. A ChatGPT usage-limit error states at most a reset time in its text. | Source (`pi/refusal.ts`) |
| `model-check` | Supported: `get_available_models`, `get_available_thinking_levels`, and `get_state`, with `pi auth check` for the credential's kind. Pi itself starts with an unknown model ID. | Verified |

With that profile, `admitBrain` admits the roles that follow the attempt agent onto its worker:
the coding agent, the decision session, and structured completion. It refuses the coordinator,
which needs `durable-coordination`. Today's local profile in `pi/descriptor.ts` supports and lacks
the same capabilities.

### Steer, interrupt, and the read signal

- **Send.** Each operator message goes out as `prompt` with `streamingBehavior: "steer"`. An idle
  session starts a run and answers `disposition: "started"`; a running one queues the message and
  answers `"queued"` (verified). Pi decides between the two itself, so no message lands between an
  idle check and the command. A plain `prompt` during a run fails with `Agent is already
  processing`, and `steer` on an idle session queues a message that waits for the next prompt
  (verified).
- **Read signal.** Pi reads a queued message after the running tool call returns and before the
  next model request. It emits `tool_execution_end`, `turn_end`, `turn_start`, a `queue_update`
  with the shorter queue, and then `message_start` for a user message with the steer's text
  (verified). Pi's queue holds text, not IDs, so the read names no message. That is the signal the
  in-process path already decodes into `Receipt.ByText` (`piReceipts`, `pi/turns.ts:50`), so the
  shared conversation's `decode` carries over with the tool-call count that the adapter has handled.
  Two identical steers are read in two turns in the default `one-at-a-time` mode (verified), and
  `ByText` acknowledges the oldest first.
- **A steer during the final answer** joins the same run as one more turn, with one
  `agent_settled` (verified).
- **Interrupt.** `abort` during a tool call gives the call a `Command aborted` error result, adds an
  assistant message whose stop reason is `error` (1.4.0) or `aborted` (1.6.0), emits
  `agent_settled` with `aborted: true`, and answers 4 to 8 ms after it was sent (verified). The
  adapter keys on `agent_settled`, not on the stop reason. A steer posted after the answer starts a
  new run (verified), so the race in the OpenCode study's
  ["Steer after an interrupt"](./opencode-adapter.md#steer-after-an-interrupt) doesn't occur.
- **A steer queued before an interrupt** is moved into the conversation as the aborted turn ends:
  Pi emits its `message_start` but makes no model request, and the model sees the text with the
  next prompt (verified). The in-process path behaves the same.

### Token usage and cost

- **Per turn.** Each assistant `message_end` has `usage`: `input`, `output`, `cacheRead`,
  `cacheWrite`, `reasoning`, `totalTokens`, and `cost` with the same parts and a `total`; 1.5.0
  and later add `cost.totalFromProvider`. The cost is the token count times the price per million
  in `models.json` (verified: 1,620 input tokens at $3 and 7 output tokens at $15 per million gave
  $0.004965).
- **Per session.** `get_session_stats` returns tokens and cost for the whole session, including
  compaction and branch summaries (`docs/rpc-commands.md`; tokens verified). Compaction usage also
  arrives in `compaction_end`.
- **Cache warming.** Pi can send extra requests that keep a provider's prompt cache warm: during
  runs by default in 1.4.0, and also for up to 30 minutes between runs by default from 1.5.1. Their
  usage arrives only as `entry_appended` with an entry of type `usage` and kind `cache_warm`
  (source). The probe model never triggered one (unverified). The per-attempt settings turn it off
  (section 5).

### Model check

- Pi doesn't refuse an unknown model on a known provider: it warns on standard error, `Model
  "nonexistent" not found for provider "gw". Using custom model id.`, and starts with it (verified;
  `dist/core/model-resolver.js:373`). An unknown provider ends Pi with exit 1 before its first
  answer (verified on 1.4.0). An effort that the model doesn't support is lowered to `off` without
  an error (verified on 1.4.0).
- So the check is the adapter's: the model must be in `get_available_models`, which lists only
  models with a usable credential (an empty list without a key, verified); the effort must be in
  `get_available_thinking_levels`; and `get_state` must report both.
- `pi auth check --provider <provider> --json` prints
  `{"status":"ready","provider":"gw","authType":"api_key"}`, or `not_ready` with exit code 1
  (verified on 1.4.0). It gives the credential kind that pool resolution needs on a host login,
  where the in-process path calls `ModelRuntime.checkAuth`. It refreshes an OAuth login unless given
  `--no-refresh` (`docs/cli.md`).
- Preflight runs one short `pi --mode rpc --no-session` with these commands; it answers in about
  0.3 s.

### Structured completion

A session started with `--no-session -nc -ne -e <usine extension> --tools structured_output` and
`--system-prompt <instructions>` ran one model request (verified). The extension's output tool
declares the schema with `constrainedSampling: { type: "json_schema", strict: "prefer" }` and
returns `terminate: true`, so Pi makes no follow-up request. The value arrives in
`tool_execution_start.args` and in the assistant message's tool call, and no session file is
written. Pi appends a `<cwd>` block to the system prompt. As in process, the tool can't be forced
(step 20), and strict mode depends on the provider's API: the Chat Completions probe received the
tool without `strict`.

### Rate-limit and plan-limit errors

- Pi retries transient failures itself: 3 retries at 2, 4, and 8 seconds (`retry.maxRetries` and
  `retry.baseDelayMs`, `docs/settings.md`). On the Chat Completions provider it retried HTTP 429
  rate limits, HTTP 500, and a ChatGPT-style `usage_limit_reached` body, with the same delays for
  `retry-after: 2` and `retry-after: 3600` (verified for 429 with `retry-after: 2`; the rest on
  1.4.0). Each retry emits
  `{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"429: …"}`,
  and the last failure emits `auto_retry_end` with `"success":false` and `finalError`.
- `insufficient_quota` fails at once, without a retry (verified).
- The failure reaches the client as an assistant `message_end` with `stopReason: "error"` and
  `errorMessage` set to the status and the response body, such as
  `429: {"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}`,
  followed by `agent_settled` (verified). No field gives the status, the retry delay, or a reset
  time. `piFailure` (`pi/refusal.ts:24`) classifies the same text in process, so it carries over
  unchanged.

### Background work and subagents

Neither version has a background tool or a subagent tool once `-ne` turns off extensions; subagents
exist only as an example extension (`examples/extensions/subagent`). The `bash` tool has no default
timeout (`dist/core/tools/bash.js:30`), so a long test suite stays in the foreground. A command
that backgrounds itself returns at once and keeps running, and Pi reports nothing about it
(verified on 1.4.0). `agent_settled` ends all of Pi's own follow-up work: retries, compaction, and
queued messages.

So the adapter emits no `BackgroundWorkUpdated`, which means that the harness doesn't report
background work, as the in-process path does today.

## 4. Tools

### usine tools

| | The usine extension | Pi's MCP client, stdio server on the worker | Pi's MCP client, HTTP server at the orchestrator |
| --- | --- | --- | --- |
| Calls reach the orchestrator | Over Pi's standard streams, as `extension_ui_request` lines | No: the server process on the worker needs its own relay | Over a network path from the worker to the orchestrator |
| New usine code on the worker | One extension file | The server and a relay | None |
| Tool names | The toolkit's names | `mcp__<server>__<tool>` | `mcp__<server>__<tool>` |
| Evidence | Verified | Verified, with a local server | Not run; it needs the session endpoint of step 22 |

The extension is the in-band choice. It registers each tool with `pi.registerTool`, and the tool's
`execute` calls `ctx.ui.input(title, callJson, { signal })`. Pi writes
`{"type":"extension_ui_request","id":"…","method":"input","title":"usine-tool-call","placeholder":"{…}"}`,
and the adapter answers `{"type":"extension_ui_response","id":"…","value":"{…}"}` after its
handler runs (verified; the result reached Pi within a few milliseconds on loopback). An `abort`
during a call cancels the dialog through the tool's signal, and the call fails as cancelled
(verified on 1.4.0). An extension outside any package imported `@earendil-works/pi-coding-agent`
and got the running CLI's module (verified).

The dialog channel is meant for user interaction, and two rules follow from that:

- **Answer every dialog.** A dialog without a timeout or a signal waits forever, and `abort` then
  never answers: an unanswered `confirm` in a `tool_call` handler kept `abort` waiting for 10
  seconds until the probe gave up (verified on 1.4.0). The adapter answers `{"cancelled": true}` to
  any dialog it doesn't own, and with `-ne` only usine's extension can open one.
- **Deliver the extension with the launch.** Pi loads an extension from a path, so the file must be
  on the host. The launch can write it with the same command that starts Pi, and pass the
  session's tool definitions in an environment variable. Not verified on a remote host.

With the MCP client, an agent-directory `mcp.json` entry with `"exposure": "direct"` listed
`mcp__usine__read_note`, and the call reached the server (verified on 1.4.0). The default exposure,
`codemode`, hides MCP tools behind Pi's `codemode` tool (`docs/mcp.md`).

### Pi's own tools

- `--no-tools` sends `"tools": []`. `--tools` with plain names lists exactly those built-in,
  extension, or MCP tools: `--tools read,grep,find,ls,read_note` gave those five, and
  `--no-tools --tools 'mcp__usine__*'` gave only the MCP tool. `--no-builtin-tools` keeps only
  extension tools. The default is `read`, `bash`, `edit`, and `write` (all verified on 1.4.0).
- `grep` and `find` need `rg` and `fd` on `PATH`. Without them, Pi downloads them from
  `github.com` on the first call (verified on 1.4.0; `dist/utils/tools-manager.js:101,244`); in
  offline mode, the call fails with `ripgrep (rg) is not available and could not be downloaded`
  (verified on 1.4.0).
- Tool commands inherit Pi's whole environment, including the gateway token variable,
  `PI_CODING_AGENT_DIR`, and `PI_SESSION_FILE` (verified on 1.6.0). The extension replaces `bash`
  with `createBashToolDefinition(cwd, { exposeSessionEnvironment: false, spawnHook })`, which
  gives each command exactly the environment usine chose, as `environmentBashTool` does in process
  (`pi/sdk.ts:175`). The tool commands' environment then held neither the token nor any `PI_`
  variable (verified). It keeps the token out of that environment only: a tool command still read
  the token from Pi's process with
  `grep -a -o 'USINE_GATEWAY_TOKEN=[a-z0-9-]*' /proc/$PPID/environ` (verified), because tool
  commands run as Pi's Unix user. Section 6 covers what limits the token.

### Flags of `pi --mode rpc`

From `docs/cli.md`; each flag that the recipe in section 5 uses was verified.

| Flag | Effect |
| --- | --- |
| `-e`, `--extension <path>` | Loads an extension file or directory, or a built-in one such as `builtin:mcp`. Repeatable. |
| `-ne`, `--no-extensions` | Turns off discovered, configured, and built-in extensions (`mcp`, `llama.cpp`, `codemode`, `tool-search`). `-e` paths still load. |
| `--no-mcp` | Turns off the built-in MCP client. |
| `--skill <path>`, `-ns`, `--no-skills` | Loads a skill; turns off discovered and configured skills. |
| `--prompt-template <path>`, `-np`, `--no-prompt-templates` | The same for prompt templates. |
| `--no-themes` | Turns off themes. |
| `-nc`, `--no-context-files` | Turns off `AGENTS.md` and `CLAUDE.md` discovery. |
| `-t`, `--tools <list>`; `-xt`, `--exclude-tools <list>`; `-nbt`, `--no-builtin-tools`; `-nt`, `--no-tools` | Select tools, as above. |
| `--system-prompt <text or file>`, `--append-system-prompt <text or file>` | Replace or extend the system prompt. |
| `-a`, `--approve`; `-na`, `--no-approve` | Trust or ignore the checkout's protected resources for this process. |
| `--offline` | The same as `PI_OFFLINE=1`. |
| `--session-dir`, `--session-id`, `--session`, `--no-session` | Session storage, section 2. |
| `--model <provider/id>`, `--thinking <level>` | Model and effort. |
| `--api-key <key>` | Not for usine: it puts the key on the command line. |

## 5. Isolation

The checkout is untrusted, so Pi must load nothing from it that usine doesn't name. A hostile
fixture checkout had `.pi/settings.json` (an extension, `sessionDir`, `defaultTools`, and
`httpProxy`), `.pi/mcp.json` with a server, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, skills in
`.pi/skills` and `.agents/skills`, a prompt template, `AGENTS.md` and `CLAUDE.md`, an `AGENTS.md`
in a subdirectory, and an `AGENTS.md` and `.agents/skills` in its parent directory.

| What the fixture tried | No flags | `--no-approve` | `--approve` (control) | Recipe below |
| --- | --- | --- | --- | --- |
| Extension, MCP server, skills, `SYSTEM.md`, `APPEND_SYSTEM.md`, `defaultTools` | Skipped | Skipped | Loaded | Skipped |
| `sessionDir` | Followed | Followed | Followed | Overridden by `--session-dir` |
| `httpProxy` | Ignored | Ignored | Ignored | Ignored |
| `AGENTS.md` in the checkout and in its parent | Loaded | Loaded | Loaded | Only the checkout's, by `--append-system-prompt` after the context-file check |
| `CLAUDE.md` beside the checkout's `AGENTS.md` | Not loaded | Not loaded | Not loaded | Not loaded |
| `AGENTS.md` in a subdirectory, after a `read` there | Not added | Not added | Not added | Not added |
| Built-in `llama.cpp` and `mcp` extensions | Loaded | Loaded | Loaded | Off |

The no-flags and recipe columns were verified on both versions, the other two on 1.4.0. In RPC
mode Pi can't show its trust prompt, so without a saved decision it skips the protected resources
(`docs/security.md`); `--no-approve` makes that hold even if the agent directory holds a saved
decision. The parent directory's `AGENTS.md` loaded even when the checkout was a Git repository
(verified on 1.6.0), and on a worker the checkout sits inside the worker's own directories.
`--append-system-prompt <checkout>/AGENTS.md` adds that file in an `<addendum>` block while `-nc`
keeps every other context file out (verified on 1.6.0).

The flag needs a file that exists. Pi reads its value as a path only when the path exists, and
otherwise sends the value as text (`resolvePromptInput`, `dist/core/resource-loader.js:100-113`).
In a checkout with only `CLAUDE.md`, the system prompt ended with
`<addendum>\n<checkout>/AGENTS.md\n</addendum>`, and the text of `CLAUDE.md` wasn't sent (verified).
In process, Pi loads the first regular file it finds in each directory, in the order
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`
(`dist/core/resource-loader.js:116-121`). It looks in the agent directory first, then in the
checkout and each of its parent directories (`:165-195`). It also appends the agent directory's
`APPEND_SYSTEM.md`, but only when no `--append-system-prompt` is given (`:480-484`). The launch
command therefore passes the agent directory's `APPEND_SYSTEM.md`, then the first context file in
the agent directory, then the first one in the checkout's root, each only when it exists:

```sh
set --
if [ -f "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md" ]; then
  set -- --append-system-prompt "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
fi
for dir in "$PI_CODING_AGENT_DIR" "<checkout>"; do
  for name in AGENTS.override.md AGENTS.md AGENTS.MD CLAUDE.md CLAUDE.MD; do
    if [ -f "$dir/$name" ]; then set -- "$@" --append-system-prompt "$dir/$name"; break; fi
  done
done
```

A per-attempt agent directory holds neither file, so there the check passes at most the checkout's
file. The host's agent directory, which a `host-login` session keeps (section 8), can hold both.
Run under `dash` against Pi's own loading, the check sent the same text in the same order in 32
runs: eight checkout layouts, with an empty agent directory and with one that held
`APPEND_SYSTEM.md` and `AGENTS.md`, on both versions (verified). The layouts were only `CLAUDE.md`;
`AGENTS.override.md` beside `AGENTS.md`; `AGENTS.md` as a directory beside `CLAUDE.md`; no context
file; `AGENTS.md` under a path with a space; only `AGENTS.MD`; `AGENTS.md` as a symlink to a file
outside the checkout; and a dangling `AGENTS.md` symlink beside `CLAUDE.md`. The text reaches the
model in one `<addendum>` block, not in the `<project_instructions path="…">` blocks that context
files get (`dist/core/system-prompt.js:25-28`).

### Permission prompts in a headless run

Pi asks for no approval before tool calls (`docs/security.md`). The trust prompt isn't shown in RPC
mode, as above. Extension dialogs (`select`, `confirm`, `input`, `editor`) wait for an answer, with
no timeout unless the extension sets one; notifications, status, widgets, and titles need no
answer (`docs/rpc-extension-ui.md`). With `-ne`, the only dialogs are usine's.

### Network contacts

With a custom provider, Pi contacted only the model endpoint during a prompt and 70 seconds idle,
with or without offline mode (verified). The hosts it can contact, and the switch for each:

| Host | When | Switch |
| --- | --- | --- |
| `pi.dev` | At start, with a model from a built-in provider, to refresh the model catalog (`dist/core/remote-catalog-provider.js:5`) | `PI_OFFLINE=1` or `--offline` (verified on 1.4.0) |
| `github.com` | First `grep` or `find` without `rg` or `fd` on `PATH` | Install both in the image (verified on 1.4.0) |
| `pi.dev` (latest version, install report) | Interactive mode only (`dist/modes/interactive/interactive-mode.js:839,1017`) | Not contacted in RPC (verified); `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` also turn them off (`docs/environment-variables.md`) |
| `radius.pi.dev`, `pi.dev/oauth` | The Radius provider, `/bug`, and MCP OAuth | Not used by the recipe (source) |
| MCP servers | Servers in `mcp.json` | `-ne` or `--no-mcp` |
| The model endpoint | Each model request | — |

### A home directory per attempt

Pi keeps its state in `PI_CODING_AGENT_DIR`. At start it creates `auth.json` and
`models-store.json` there, empty and with mode 0600, and it reads `models.json`, `settings.json`,
`mcp.json`, and `trust.json` from it (verified for the files it wrote). It wrote nothing to `HOME`
in any probe (verified). It reads `~/.agents/skills` unless `-ns` is set (`docs/skills.md`). Node.js
keeps a compile cache of about 3 MB in `NODE_COMPILE_CACHE` or the temporary directory. Three
settings take effect only in the agent directory: `defaultProjectTrust`, `httpProxy`, and
`cacheWarming` (`docs/settings.md`). A separate agent directory per attempt therefore isolates Pi
without moving the tool commands' `HOME`.

### Recipe

Verified against the hostile fixture: nothing from the checkout loaded except its root
`AGENTS.md`, no outbound connection, and the session where usine put it. In the fixture, the
context-file check picks that same `AGENTS.md`.

```sh
# Per attempt; on host-login, the host's agent directory instead (section 8). The per-attempt
# directory holds models.json and settings.json, neither with a secret.
export PI_CODING_AGENT_DIR=<attempt home>/pi
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
export USINE_GATEWAY_TOKEN=<caller token>   # read by models.json; not in tool commands' environment
# The context-file check above, which sets "$@".
pi --mode rpc --no-approve -ne -e <attempt home>/pi/usine.mjs \
  -ns -np --no-themes --no-mcp -nc "$@" \
  --session-dir <checkout>/.usine/pi/sessions --session-id <child session> \
  --model <provider>/<model> --thinking <effort>   # plus --tools or --no-tools per role
```

`settings.json`: `{"cacheWarming": "off", "transport": "sse"}`; `transport` matters only for the
ChatGPT route in section 6, which `models.json` follows.

`models.json` gives the session's model, and every other model that it defines or overrides,
`"inputLimits": {"images": {"resize": {"maxBytes": 1048576}}}`, in its `models` entry or in a
`modelOverrides` entry for a built-in model, so that an image `read` stays under the line limit
(section 1). The cap applies whatever the model's `input`, because Pi keeps the image for a model
that takes no images, and a gateway model whose `input` usine doesn't declare is text-only.

## 6. Credentials

- **Storage.** `auth.json` in the agent directory holds API keys and OAuth tokens, mode 0600
  (`docs/configuration.md`). A `models.json` provider can set `apiKey` and `headers`, each as a
  literal, `$NAME`, or a `!command` evaluated at request time (`docs/models.md`).
- **Precedence.** `--api-key`, then `auth.json`, then the `models.json` `apiKey`, then the
  provider's environment variables (`docs/models.md`). Verified on 1.4.0: an `auth.json` key
  replaced the `models.json` key, and a `models.json` key beat stray `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` values. So the agent directory of the
  `api-key` and gateway routes must not be one where someone ran `/login`. Only `host-login` uses
  the host's (section 8).
- **A key and a base URL for one process.** The per-attempt `models.json` names the gateway slot as
  the base URL and `$USINE_GATEWAY_TOKEN` as the key. Nothing secret is written, and the token stays
  in Pi's environment. The exact `bash` keeps it only out of the tool commands' environment: the
  agent can still read it from Pi's process (section 4), as it can read the token of Claude Code
  and Codex, which also hold it in their environment (`tokenVariable` in `claude/descriptor.ts`
  and `codex/descriptor.ts`). What limits the token is its scope: the gateway refuses a caller
  token once its attachment ends ([ADR 0027](../adr/0027-gateway-credential-proxy.md)). Verified
  on 1.4.0 against the fake endpoint:
  - For the `openai-responses` slot, a custom provider with `"api": "openai-responses"` and
    `baseUrl` `…/openai-responses/v1` sent `POST /openai-responses/v1/responses` with
    `Authorization: Bearer <token>`, the gateway's API-key route.
  - For the `anthropic-messages` slot, the built-in `anthropic` provider with only `baseUrl` and
    `apiKey` overridden sent `POST /v1/messages?beta=true` with `x-api-key: <token>`, which the
    gateway accepts as a caller token (`packages/gateway/src/caller/caller.ts:213-226`).
  - Every request carries `User-Agent: pi/<version> (linux; node/<version>; x64)`; Responses
    requests add `session_id`.
- **The `api-key` route without a gateway** works the same way, with the key in the variable that
  `models.json` names.
- **A ChatGPT login held by the gateway** (`openai-codex` in `piLoginPools`):
  - Pi's `openai-codex` provider calls `<baseUrl>/codex/responses`
    (`pi-ai` `dist/api/openai-codex-responses.js:465-472`), tries a WebSocket first unless
    `transport` is `sse`, and sends `Authorization: Bearer <key>` with a `chatgpt-account-id` that
    it decodes from the key as a JWT. A key that isn't a JWT fails with `Failed to extract
    accountId from token` (`:1273-1287`).
  - With a placeholder JWT that carries a dummy account as the key, the caller token in a
    `models.json` header `x-usine-gateway-token`, and `transport: "sse"`, Pi sent
    `POST /openai-responses/v1/codex/responses` with the placeholder bearer, the dummy account,
    the caller token, `originator: pi`, and `session-id` (verified on 1.4.0).
  - The gateway reads the caller token from `x-usine-gateway-token` first, and replaces
    `authorization` and `chatgpt-account-id` with the login's
    (`packages/gateway/src/llm/llm.ts:235-251`). Its ChatGPT slot accepts only `/v1/responses`
    (`llm.ts:159-167`), so it needs a route for `/v1/codex/responses` that maps to the backend's
    `/responses` (follow-up 4). Whether the ChatGPT backend accepts Pi's request body is
    unverified.
  - The session's pool then comes from the gateway's credential kind on the `gateway-subscription`
    route, as for Codex; `piLoginPools` keeps deciding the pool of a host login on a local worker.

## 7. Install and footprint

- **Install entry.** `{ name: "@earendil-works/pi-coding-agent", version: "1.6.0" }`. The `pi`
  command is `dist/bundle/cli.js`, and `pi --version` prints `1.6.0`. The package needs Node.js
  22.19.0 or later (`engines`); workers already need Node.js for the process owner. The 9 MB bundle
  imports only optional packages, but npm installs every dependency.
- **Image.** Also install `ripgrep` and `fd` for the `grep` and `find` tools (section 4).
- **Size.** 1.4.0 installs 121 packages, 150 MB on disk (108 MB apparent size); 1.6.0 installs 123
  packages, 162 MB (118 MB). `npm install` took 5 to 9 seconds here.
- **Start time** on 2 vCPUs and 8 GB, with the page cache warm:
  - `pi --version`: 0.20 to 0.26 s.
  - First RPC answer: 0.27 to 0.33 s with Node.js's compile cache, 0.38 to 0.40 s without.
  - Through the owner on an `ExecShell`: 0.41 to 0.48 s.
- **Memory and CPU.** 100 to 117 MB RSS after start, and 107 to 120 MB during a tool call, about
  7 MB more on 1.6.0. Start and a run with one tool call used 0.4 to 0.6 s of CPU. The memory is
  about a third of OpenCode's 370 MB per session.

## 8. One path or two

The durable coordinator's Pi parent stays in process in `packages/durable` with its own 1.4.0 pin,
and this note doesn't change it.

**Recommendation: one path.** RPC replaces the in-process path for Pi children on every placement,
local workers included. Every capability of today's local profile holds over RPC (section 3), and
the two in-process hooks that have no RPC command move into the usine extension, both verified:

- **The exact `bash` environment** (section 4).
- **The pause gate.** `piPauseGate` (`pi/turns.ts:18`) blocks tool calls and model requests while
  usine holds the session. In the extension, `tool_call` and `before_provider_request` handlers wait
  while a flag is set, and two extension commands set and clear it. The adapter sends them as
  `prompt` with `/usine-pause` and `/usine-resume`. Pi runs an extension command at once, even
  during a run, answers `disposition: "handled"`, and saves no user message. During a tool call,
  the next model request waited 2 seconds until `/usine-resume` (verified on 1.4.0).

One path costs 0.3 to 0.5 s and about 110 MB per session on the host, and a dialog round trip per
usine tool call. It gives one adapter and one fixture boundary, the same isolation on every worker
kind, a Pi crash that ends one child process instead of affecting the orchestrator, and a worker CLI
pin independent of the SDK pin.

| In `packages/agents/src/harness/pi/` | One path (recommended) | Both paths |
| --- | --- | --- |
| `authentication.ts` | Kept: `piLoginPools`, `splitPiModel`, and pool resolution, fed by `pi auth check` | Kept |
| `descriptor.ts` | Rewritten: worker placements, routes, install entry, credential wiring | Gains a worker profile beside the in-process ones |
| `host-files.ts` | Removed: Pi's own read tools run on the host | Kept for in-process sessions that read on an `ExecShell` |
| `pi.ts` | Rewritten as the RPC runtime | Kept, beside a second runtime |
| `preflight.ts` | Rewritten as an RPC probe | Kept, beside a second probe |
| `refusal.ts` | Kept unchanged | Kept |
| `sdk.ts` | Removed: `PiSdk`, `piSessionTools`, `environmentBashTool`, `usePiStart` | Kept |
| `turns.ts` | `piReceipts` kept; `piPauseGate` moves into the extension; `piTurns` reads RPC lines | Kept, and partly duplicated |
| New | The extension source and a typed client for the RPC lines | The same |

The "one path" column is the end state. Follow-up 3 moves the children. The supervisor and
structured completions at the `orchestrator` placement then run the same command as a local child
on the orchestrator host or in the supervisor's container (ADR 0035); until they move, `sdk.ts` and
`host-files.ts` stay for those two. In the end state, `packages/agents` needs
`@earendil-works/pi-coding-agent` only for types and tests.

### A session on a local worker

Local children use only the `host-login` route today. In process, such a session reads the host's
agent directory, the one that `getAgentDir` returns (`pi/sdk.ts:343-352,429`): its `auth.json`
and `models.json` through `ModelRuntime.create` (`:428`), its `settings.json` through
`SettingsManager.create` (`:346`), its context file, because context files stay on, and its
`APPEND_SYSTEM.md`. Over RPC, a `host-login` session keeps that directory: the launch sets
`PI_CODING_AGENT_DIR` to the directory that `getAgentDir` returns in the orchestrator, and usine
writes nothing in it. A per-attempt directory can't stand in for it. Pi has no variable for
`auth.json` alone, a copy of the file would leave the host with a refresh token that a refresh in
the copy has replaced, and the host's `models.json` can define the provider that the login serves.
So the session keeps the host's `auth.json`, where Pi refreshes an OAuth login under its file lock
as in process, and the host's `models.json` and `settings.json`, `cacheWarming` and `transport`
included. The `api-key` and gateway routes are new on local workers and use a per-attempt agent
directory, as on any worker.

Two things change for a `host-login` session:

- **Context.** The checkout's parent directories no longer give context files. The agent
  directory's `APPEND_SYSTEM.md` and context file, and the checkout's root file, still reach the
  model with the same text in the same order, but in one `<addendum>` block (section 5).
- **Images.** usine writes no `models.json` there, so it caps no image, and the host's
  `models.json` decides, as in process. An image `read` whose `tool_execution_end` crosses the line
  limit takes the drop path of section 1: the model still gets the image, and `ToolFinished` has a
  null output.

## 9. Versions 1.4.0 and 1.6.0

Every probe in this note gave the same answer on 1.6.0 except:

- An aborted assistant message has the stop reason `aborted` instead of `error`.
- End of input or SIGTERM during a tool call saves an `aborted` assistant message; 1.4.0 saves
  nothing after the tool call.
- `cacheWarming` defaults to `idle` from 1.5.1, which also warms caches between runs.
- The default system prompt is shorter: 1,348 prompt tokens instead of 1,620 in the probe.
- Usage cost has `totalFromProvider`.

The 1.5.0 to 1.6.0 changelog also fixes behavior that the adapter relies on: a failed session write
no longer leaves entries in memory that resumed sessions lose (1.5.0); disposal waits for aborted
tools to record their results (1.5.1); end of input and SIGTERM together no longer cut shutdown
short (1.5.1); a batch of tool calls interrupted by an abort gets results for the calls that
hadn't started (1.6.0); and `undici` 8.12.4 carries security fixes (1.6.0).

Pin the worker CLI at **1.6.0**. The SDK that `packages/agents` and `packages/durable` pin stays a
separate pin; `packages/durable` keeps 1.4.0 until its Pi parent is removed.

## Not verified

- `RemoteShell` and container hosts: the command line is the one that Codex uses on both.
- Writing the extension on a remote host with the command that starts Pi.
- The ChatGPT backend's acceptance of Pi's request body, and any header it requires; real provider
  accounts in general.
- What triggers cache warming, and its `entry_appended` usage on the wire.
- An OAuth refresh of a host login by an RPC session in the host's `auth.json`.
- Strict tool mode for structured completion on the gateway's Responses and Messages slots.
- The Cloudflare sandbox shell.

## Follow-up issues

**1. `ChildHost`: skip an oversized protocol line.** The only contract addition.

- `boundedLines` in `packages/agents/src/child-host/lines.ts` gains an option that discards the
  rest of a line longer than the limit, reports its size and first 1 KiB to the caller, and
  continues with the next line. The caller decides what a dropped line means; 1 KiB holds the
  fields that Pi writes before a large value, even with a long tool call ID. The default stays
  failing, so Codex and the OpenCode bridge don't change.
- Tests: a line across chunk boundaries above the limit, a line that ends exactly at the limit,
  a dropped line followed by a valid one, and the recorded 8.53 MiB `tool_execution_end` of an
  image `read` followed by the events after it.

**2. Pi adapter 1: the usine extension and the RPC client.** In
`packages/agents/src/harness/pi/rpc/`, built and shipped like the worker owner program.

- The extension: usine tools answered through `input` dialogs with the tool's signal; an
  exact-environment `bash`; the pause gate with `/usine-pause` and `/usine-resume`; and an output
  tool with `constrainedSampling` and `terminate: true` for structured completions. It reads the
  session's tool definitions from an environment variable.
- A typed client (Effect Schema) for Pi's command, response, event, and extension UI lines, on
  `pendingRequests` and the line reader of follow-up 1. Unknown events and shapes are logged and
  skipped; a dialog that usine doesn't own is answered `{"cancelled": true}`.
- Dropped lines: a dropped `tool_execution_end` still emits `ToolFinished`, with `callId` and
  `tool` decoded from the reported first bytes, a null output, and `isError: false` (section 1).
  Every other dropped line is logged with its size and first bytes and skipped, and a dropped
  answer fails its request by timeout. Tests cover a dropped `tool_execution_end` and the receipt
  count after it.
- The launch command that writes the extension, runs the context-file check, and starts Pi with
  the recipe in section 5. Tests cover a checkout with only `CLAUDE.md`, one with no context file,
  and an agent directory that holds `APPEND_SYSTEM.md` and `AGENTS.md`.
- Unit tests against a scripted fake `pi` (a Node.js script in test code, no Pi in CI), plus one
  test that loads the extension into the pinned CLI with a fake model endpoint.

**3. Pi adapter 2: RPC runtime, descriptor, and preflight.** Builds on 1 and 2, and replaces the
in-process child path (section 8).

- **Runtime:** operator messages as `prompt` with `streamingBehavior: "steer"`; reads decoded from
  user `message_start` with `Receipt.ByText`; `abort` for interrupt, with `agent_settled` as the end
  of a run; usage from each assistant `message_end` and from `cache_warm` entries; `piFailure` for
  failed turns; resume with `--session-id` and a check of `messageCount`; no
  `BackgroundWorkUpdated`.
- **Descriptor:** the profile in section 3 on the `local`, `ssh`, and `container` placements, with
  `sandbox` after its own check of the sandbox shell; the `api-key`, `gateway`, and
  `gateway-api-key` routes, and `host-login` on local workers; the pools it declares (#1379); an
  install entry for 1.6.0; and credential wiring that writes `models.json`, with the 1 MiB image
  cap on every model that it defines or overrides, and `settings.json` into the attempt home, or
  that sets the host's agent directory on `host-login` (section 8).
- **Preflight:** the model check in section 3 on every route.
- **Tests:** replay fixtures at the `ChildHost` boundary, recorded against the pinned CLI with a
  controlled model endpoint, for the shared scenarios that the profile declares plus
  `transport-loss` and `early-exit`; a `read` of a PNG above the cap on a model that takes images,
  on a text-only model, and on `host-login` without a cap; and `capabilityProofs` entries for
  `model-check`.
- **Docs:** the worker column for Pi in
  `apps/docs/src/content/docs/reference/configuration/agents.md`; the Pi sentence in ADR 0006 and
  "Pi on local workers only" in ADR 0005; the Pi child in `docs/architecture/index.mdx`.
- Out of scope: the supervisor and orchestrator-placement completions, which can follow in a third
  part that removes `sdk.ts` and `host-files.ts`.

**4. Gateway: Pi's ChatGPT requests on the ChatGPT slot.** `LLM_ROUTES` in
`packages/gateway/src/llm/llm.ts` accepts `/v1/codex/responses` on the `openai-responses` slot
when it holds a ChatGPT login, mapped to the backend's `/responses`, and the Pi descriptor wires the
`gateway-subscription` route with the placeholder JWT and the caller-token header of section 6.
Check the request against the real backend before merging.
