---
title: Agents
description: Agent harnesses, models, reasoning effort, personas, and preflight requirements.
---

Manage agents in **Configuration > Agents**, or edit an existing agent with `usine config edit agent developer`. An agent combines a brain spec and a persona. Loops reference its name. Saved edits apply to new runs after preflight; use **Edit and retry** to update a failed run's agent definition.

Harness IDs use kebab case and must match an entry in the server’s harness catalog. The catalog contains `claude`, `codex`, `opencode`, and `pi`. An unregistered ID fails agent schema validation.

The server builds one harness runtime registry at startup and shares it between worker preflight and child sessions. An incomplete registration fails startup. Preflight errors identify the harness installation to check: host-login routes include login guidance, gateway and API-key routes refer to the worker installation, and Cloudflare routes refer to the sandbox image. Successful binary probes log the installed version.

## Agent

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| name | kebab-case string | required | Unique instance-level agent name used by loops. |
| `harness` | `claude`, `codex`, `opencode`, or `pi` | required | Coding-agent harness used by child sessions. |
| `model` | non-blank string | required | Model ID understood by the harness, with `provider/model` for Pi. |
| `effort` | effort | required | Reasoning effort of child sessions. |
| `decision` | `model` and `effort` | none | Model and effort that decide a child's report, on the agent's own harness. See [Coordinator](#coordinator). |
| persona | non-blank Markdown | required | Standing instructions included with the task of every child. |

Earlier versions also read `coordinator`, `parent_model`, and `parent_effort`. usine ignores these keys in imported agent files and removes them from stored agents. See [Stored configuration](/reference/configuration/config/#stored-configuration).

For example, create `developer` with harness `codex`, model `gpt-6-astra`, effort `medium`, and this persona:

```text
Complete one repository task at a time. Follow the repository instructions.
Run the required checks, push the branch, and record blockers on the item.
Do not merge pull requests.
```

Effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude Code disables thinking for `off` and treats `minimal` as `low`. Codex receives `off` as `none` and checks the selected model's supported efforts. OpenCode selects the model variant with the effort's name, `none` for `off`, and refuses an effort that the model has no variant for. Pi uses the value as its thinking level.

## Coordinator

The coordinator decides what an attempt does next. Every attempt runs on the event-driven coordinator: rules applied to the attempt's lifecycle events coordinate it, with no parent session and no parent model credential. The coordinator starts one child with the task and turns the child's report into the attempt's outcome. The attempt details show **No parent session**, and input addressed to the parent goes to the child. See [Message an agent](/guides/message-an-agent/). The [child-session budget](/reference/configuration/settings/#instance-settings) counts all child starts over the attempt's lifetime.

An attempt that an earlier version started with a Pi parent session keeps that parent when an orchestrator restart reattaches it.

With `decision`, the coordinator asks the decision model what to do with a child's report that has no reserved marker and no CI handoff: complete the attempt, start another child to continue the work, fail it as blocked, as a question, or as a failure, or fail it for a retry after an infrastructure failure or a usage limit. The request runs once on the agent's harness, on the attempt's worker with the child's credential, with no usine tools and no saved conversation. A harness that can't turn its own tools off, such as Codex, runs them read-only in the checkout. It reads the event, the start of the task, the outcome labels and CI policy, the earlier children's reports, and the end of the child's output. Its tokens count toward the attempt's usage as a separate session. A replacement child must fit the child-session budget. If the model refuses, answers with something other than a decision, hits a usage limit, or doesn't answer within 10 minutes, the attempt completes with the report, as without `decision`, and the server logs the reason at Warning. A reserved marker and every other event keep their fixed outcome, and a report that starts with `[usine:awaiting-ci]` completes the attempt with the handoff unchanged.

A child that stops and can't resume, such as after an orchestrator restart when its saved session is missing or its worker or checkout is gone, is replaced once with a new child that continues from the checkout. Each replacement takes the next slot of the [child-session budget](/reference/configuration/settings/#instance-settings). When the budget has no slot left, the attempt fails with `InfraFailure`, which the engine retries from salvage. A child whose launch hadn't returned when the orchestrator stopped resumes its saved conversation if available. If no conversation was saved or the harness reports it unavailable, the child launches fresh in its own slot. An unreadable saved conversation or a changed worker, machine, checkout, harness, or harness home ends the child as interrupted and uses a budget slot. If an upgrade changes the shape of a stored coordinator record so that it can't be read, the attempt fails with `InfraFailure`, the server logs the attempt ID and the record, and other attempts keep running.

For example, this agent has a decision model:

```yaml
---
harness: codex
model: gpt-6-astra
effort: medium
decision:
  model: gpt-6-astra
  effort: low
---
Complete one repository task at a time.
```

## Harness requirements

| Harness | Version requirement | Authentication | Workers |
| --- | --- | --- | --- |
| `claude` | Claude Code with `auth status --json` | Claude subscription login, setup token, or API key | Local, SSH, Cloudflare |
| `codex` | Codex CLI 0.172.0; preflight also accepts 0.164.0 and 0.159.0 through 0.159.3 | ChatGPT login or API key | Local, SSH, Cloudflare |
| `opencode` | OpenCode 2.3.2 (`@opencode/cli`), Node.js | OpenAI API key, from the attempt or the gateway | SSH |
| `pi` | Bundled Pi runtime | API key for the selected provider or ChatGPT login for `openai-codex` | Local |

For a worker using subscription logins, run these commands as the user running its children:

```sh
claude auth login
codex login --device-auth
claude auth status
codex login status
```

A gateway can inject either a provider API key or a subscription credential. Cloudflare workers require provider API keys. Provisioned SSH workers require credentials from their gateway or `api_keys` settings. Local preflight and children accept managed Claude setup tokens and API keys, and Codex ChatGPT logins and API keys. Local Codex launches select file credential storage so they use the credentials managed by `usine login` and removed by `usine logout`, including when Codex configuration selects keyring storage.

For Pi children on a ChatGPT subscription, set `harness` to `pi` and `model` to an `openai-codex/...` model. Run Pi as the Unix user running the orchestrator, with the same `~/.pi/agent` or `PI_CODING_AGENT_DIR` configuration as the orchestrator. Enter `/login`, choose **Sign in with an account**, then **OpenAI Codex (legacy)** for the `openai-codex` provider. Preflight accepts that login without an API key. Other account logins, including Pi's **OpenAI** ChatGPT sign-in and its OpenRouter sign-in, have no supported usine pool and fail preflight.

Each parent and child session records the billing pool resolved at launch. Usage totals read that recorded pool, including after an orchestrator restart. Reattaching a retained Claude process preserves its cumulative token and cost totals without counting the same usage twice, including assistant messages that the process sends again after reattachment. When Claude recovers through a replacement process, it saves zero usage for that process alongside the unchanged session totals before it launches the replacement. A later orchestrator restart preserves the earlier usage even if it stopped during that launch or the replacement is still waiting for guidance. Older transcripts without a recorded pool use the historical harness and model rule.

OpenAI-compatible endpoints and local models use `apiKeys`. API-key sessions record the endpoint's provider name when available, such as a Pi provider configured in `models.json`. The transcript includes the name without the endpoint URL or credential. An API-key credential uses `apiKeys` even when the model ID has an `openai-codex/` prefix.

Pi children record ChatGPT usage under `chatgptPlan`, including tokens and Pi's cost estimate. Pi reports no plan rate windows, so usine cannot warn before Pi sessions reach the ChatGPT plan limit.

Claude Code subscription sessions report allowance usage under `claudePlan`, including usage outside usine. The five-hour allowance appears as the primary window, and the latest reported seven-day allowance appears as the secondary window, including model-specific allowances. **Needs attention** warns when a reported window reaches 80% usage and has a future reset time. Later reports update only the reported window and preserve the other window across children and attempts. Claude plan reports apply to worker subscription logins and gateway subscription credentials; API-key sessions do not update Claude plan windows. A report without utilization leaves the recorded windows unchanged, and an omitted reset time remains unknown.

Pi children save their conversations in `.usine/pi/sessions` under the attempt checkout. The transcript records the saved session ID and directory. Keep both the checkout and session files to continue a conversation after its process exits. The child continuation's `resume(request, savedReference)` operation reopens a native conversation without sending input and reports whether it is available. Launching with a saved reference applies the shared continuation policy.

After an orchestrator restart, an active `subagent` call continues its saved child conversation on the original worker, machine, and checkout. Claude Code, Codex, and Pi keep the same child ID and append events to the attempt transcript. Resuming a child uses its existing child-session budget slot. The harness must support `resume-session` for its placement and credential route. If no saved session exists, the original worker or checkout is unavailable, or resume fails, the parent receives an interrupted result with the committed output and decides what to do next.

Remote Claude Code and Codex children use one process owner per child on the worker. The worker requires Linux with `/proc` and Node.js on its command path. An SSH disconnect reattaches the same process and preserves its running turn. Orchestrator heartbeats renew a two-minute lease; if they stop, the owner terminates the harness process group, with forced termination after five seconds. An orderly orchestrator shutdown keeps the process available for reattachment within that lease and confirms the last handled output checkpoint after the worker acknowledges pending input, or after four seconds if it doesn't. Claude checkpoints SDK-only state messages as they arrive. Reattached Claude processes preserve token counts for interleaved assistant blocks from parallel tasks. Each active message ID remains in saved usage until a later message in the same parent-tool stream or the turn result supersedes it and the output checkpoint covers it. Answered tool hooks become checkpointed after the worker acknowledges the SDK response, and a hook that Claude cancels becomes checkpointed when the cancellation arrives. Each cancellation logs its request ID at Info, with a separate message when it releases no pending request. When the worker acknowledges the SDK's late response to a released request, an Info log records that request ID; the late response releases nothing. When a turn result is handled, an Info log lists earlier control requests that remain unanswered and that no earlier result listed. Pending application messages and unanswered hooks replay after restart, with the restored pause applied before hooks continue. Blank and non-JSON stdout lines are ignored and checkpointed, matching the Claude SDK, which also ends a line at a lone carriage return. Fresh launches replace any previous process for that child. A changed exported child environment stops the old process before resuming its saved conversation. SSH login variables can change between connections without replacing the process. Local children terminate when their dedicated orchestrator pipe closes, including after a crash.

If a remote Claude Code or Codex process exits after saving its conversation, including after lease expiry or a worker restart, the child reopens that conversation using its existing child-session budget slot. Live recovery and orchestrator restart share one policy across Claude Code, Codex, and Pi. A working child receives one continuation instruction to check interrupted work, followed by unread operator messages. Interrupted tool calls receive error results. A held, paused, or idle child with a recorded task waits for guidance. A child whose saved conversation has no task receives the original task even when it is held, paused, or idle. This replaces any saved idle report. For Claude Code, a missing prompt acknowledgment triggers this behavior; if saving the acknowledgment failed, recovery can repeat a task that already finished. A paused Codex child receives the task and then interrupts its turn until the operator sends guidance. Each child can start three continuation turns within ten minutes; a fourth fails, and restart preserves this limit. If reopening fails, the parent receives an interrupted result and can start a replacement within its child budget. A replacement clears that child's previous infrastructure failure. A failed reopen during live recovery records an infrastructure failure for automatic retry. A restored child receives its unread operator messages. If its call ends before it reads them, including when the call fails before it restores them, forwarded steers return to the parent and other messages are reported unread. Claude Code keeps guidance queued through an operator interruption. Codex resubmits guidance that an interrupted or completed turn did not consume before sending the next operator message. If Codex native history confirms that the saved thread is empty, the shared policy sends the original task as its first input. A Claude Code process whose owner never acknowledged the task prompt, retained or lost during live recovery, receives the original task the same way. After process loss without a task acknowledgment, Claude Code starts with its assigned session ID instead of resuming a potentially missing transcript. A thread with saved work receives the continuation instruction.

usine assigns Claude's native session UUID and saves it before sending the first prompt. Operator messages also carry UUIDs. Native receipts acknowledge each message separately, including identical messages. When a turn result has no `user_message_uuids` list, Claude Code uses the result's pending-send count to acknowledge submitted guidance folded into that turn. Codex preserves unacknowledged guidance across turn boundaries and restores receipt matching when reattaching to an active turn. Recovery resends that unread guidance before new operator corrections. Codex recovery first reports unread guidance that the saved thread's last turn records as read and doesn't resend it. usine saves the user-message items of the last turn that it already observed, including items that matched no unread message. After an orchestrator restart, those items cannot acknowledge unread guidance or a task with the same text. Without saved receipt history, Codex records a finished turn's existing items as observed and leaves unread guidance queued for delivery. For an active turn, the next receipt save includes its existing user-message IDs, while replayed notifications can still acknowledge unread guidance. This prevents repeated text from dropping a message after another restart. Restored reads do not mark an interrupted-turn placeholder as an answer to the operator. A Pi recovery steer that Pi handles at once is reported as read. Reattachment detects an owner that disappeared without an exit record. If the owner fails before it starts supervising the harness, for example because it cannot read a process identity, the child fails at once with the owner's reason as its exit diagnostic. Process identity checks prevent stop and cleanup from signaling a PID reused after a worker restart.

A Claude Code child reports each change to its background tasks, without the watchers that Claude Code marks as ambient, and the run page shows the latest list as a note. A child that answers while its background tasks still run waits for that work and the turn it starts, without an operator hold. If its tasks end and no turn starts within five minutes, usine returns the child's answer. By default, the wait has no limit. If [`settings.max_background_wait_minutes`](/reference/configuration/settings/#background-work) is set and the child stays idle for that many minutes after its answer, usine returns that answer. If background work still runs then, usine also logs a warning with the limit and the remaining task IDs. Closing the child ends the Claude Code process, which stops its background tasks. When the attempt then ends, it frees its worker slot, and cleanup salvages its checkout as after a failure, so work that the child hasn't pushed is kept. A turn that starts within the limit runs to its own answer. If the operator holds or pauses the child when the limit or the five minutes pass, usine logs that, and the child stays open without reporting idle. A Release of a held child then returns the answer, unless a turn started first; that turn runs to its own answer. A paused child stays open until the operator's next message. If the Claude process resumes in the meantime, the child reports the kept answer as idle, and a Release returns it. The child then reports its background work as not reported until the new process lists its tasks. usine keeps the limit in memory: a child that was already waiting when usine restarted waits for its background work and the turn it starts without a limit.

Children run without approval prompts. Claude Code ignores project settings, Codex treats the checkout as untrusted, OpenCode ignores the checkout's configuration, and Pi ignores project-local configuration. Repository agent instructions still apply.

### OpenCode children

An OpenCode child runs `opencode serve` behind a small usine bridge on the worker, one per child, under the same process owner as Claude Code and Codex children. Set `model` to an OpenAI model ID from OpenCode's catalog, such as `gpt-5.4-mini`; OpenCode calls the OpenAI Responses API with the attempt's `OPENAI_API_KEY`, or through the gateway's `openai-responses` slot with the caller token. It uses no login of its own, so a worker without an OpenAI key at the attempt or the gateway refuses OpenCode agents. A local worker gives its children only the host's login, so it refuses them too, and Cloudflare sandboxes don't install OpenCode. Sessions record their usage under `apiKeys`, with the cost that OpenCode reports from its catalog prices.

Each child gets its own OpenCode data directory and database in the attempt's OpenCode home, even on a worker that sets `OPENCODE_DB`. OpenCode reads only the checkout's root `AGENTS.md`: the checkout's `opencode.json`, `.opencode/`, plugins, skills, and `CLAUDE.md` files don't load. OpenCode's web fetch, web search, and question tools are off, as are its plugins and MCP servers, and it reads `.env` files without asking. The data directory and these settings apply to the OpenCode server only: its tool commands, and those of its subagents, run with the worker's environment, including the worker's `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `OPENCODE_DB`, so tools such as pnpm keep the worker's store and configuration. The worker needs `rg` on its command path, which the attempt image and the Hetzner worker install; without it, OpenCode downloads ripgrep from GitHub.

Steering and operator messages reach the running execution at its next step boundary, and OpenCode reports each read, which the run page shows. **Interrupt** stops the running execution and its command at once; an execution that starts after an Interrupt, such as one that a queued message starts, stops too. A message sent after an interrupt starts a new execution, which answers the message, even when the interrupted execution's end arrives after it. If OpenCode cancels that message instead, the interrupted execution's answer ends the turn. A message sent as an execution ends also starts a new execution, whose answer the child returns. A child whose answer leaves a background command or subagent running waits for that work and the execution that its end starts. If the work ends and no execution starts within five minutes, the child returns that answer; tokens and cost include every execution and every subagent. A provider rate limit that OpenCode would retry more than five minutes later, a quota, and a plan limit end the child with a capacity refusal, and the attempt waits for capacity. After an orchestrator restart, a child reopens its saved session from its data directory and receives the continuation instruction. Recovery checks unread operator messages against the saved message history and, when the worker kept OpenCode running, its queue. Messages that OpenCode already delivered are acknowledged as read, even if the delivery event was lost before the restart; queued messages remain queued until OpenCode delivers them, and messages that never reached OpenCode are sent again.

By default, Claude Code children add no attribution to commits or pull request descriptions. usine starts each one with `attribution` set to an empty `commit` and `pr` text in Claude Code's flag settings, which take precedence over the worker user's `settings.json`. Instructions about attribution in the repository's `CLAUDE.md` or in Claude Code memory take precedence over these settings. A child in a repository that asks for a `Co-Authored-By` trailer or a `Generated with` line still adds it. Agents have no field for other harness settings.

Codex adds a `Co-authored-by: Codex <noreply@openai.com>` trailer to commits and a `Generated with Codex` line to pull request descriptions only when it uses a ChatGPT login and that ChatGPT account has Codex commit attribution turned on. Codex reads this setting from the account and has no local configuration for it, so turn it off in the account's Codex settings. API-key credentials add no attribution.

Codex disables the checkout's project-local configuration, hooks, and exec policies even if its saved configuration marks the checkout as trusted. Its app server starts in `/`, outside the checkout and home directory, to avoid loading repository configuration at startup or reporting disabled project configuration in the worker's `.codex` directory. Other Codex diagnostics log at Warning.

## Preflight

Configuration import and saved edits check every coding-agent brain against each configured worker. A refusal identifies the agent, worker, role, missing capability, placement, or credential route, and the reason that the role or the harness gives. For example, a Pi agent on an SSH worker lacks the `container` placement because Pi runs its tools in the orchestrator process. Use a local worker for Pi children or select a harness that supports the configured workers.

Preflight and child launch check the catalog associated with the registered harness runtimes, including custom harness descriptors. Preflight checks the same role requirements before tools and credentials; it does not install harnesses. Startup checks each rostered child brain on every worker. A changed roster is checked before the running configuration accepts it. Each attempt also checks its selected agent. Failures identify the worker, capability, and remediation.

For workers using harness credentials, Claude Code must report a first-party subscription login, setup token, or API key, and Codex must report a ChatGPT login or API key. Gateway-injected and attempt API-key credentials use the same harness binary and version checks, with authentication supplied by their credential route. Claude Code accepts any installed version; Codex requires a supported version, and OpenCode requires 2.3.2. OpenCode preflight also starts OpenCode with a temporary data directory and checks the model and effort against the models that OpenCode lists, on every credential route, without a model request. Claude Code's host-login checks and child startup share a lock for the same worker login. Pi requires a local worker and an API key for the selected provider or an `openai-codex` ChatGPT login. Use [Run worker preflight](/guides/run-worker-preflight/) after fixing the machine.

Every GitHub comment, issue, pull request, and review written by an agent ends with `— usine agent: <name>`. Agents share the App identity, so this signature attributes their work to an attempt. Commits use the App's bot identity.

## Step outputs

An agent returns a JSON document by writing `.usine/outputs/<name>.json` in its checkout. Use a lowercase slug containing letters and digits separated by hyphens or underscores. For example, write `.usine/outputs/walkthrough.json`:

```json
{
  "type": "balade.walkthrough",
  "content": {
    "title": "Change walkthrough",
    "sections": []
  }
}
```

`type` is an opaque, non-empty string of at most 128 UTF-16 code units. `content` is any JSON value. An optional `commit` must equal the attempt's pinned base commit, which is the pull request head for a pull request run. Parent and child completion instructions include the pinned base commit, including when a retry resumes from salvage. The limit is ten output files per attempt. Both each file, including its envelope, and its compact JSON content must be at most 8 MiB. Invalid outputs fail the attempt with the file path and reason, including the invalid or unexpected envelope field; unfinished repository work follows the usual salvage procedure.

Keep a child's output documents in place until the parent returns. Preparation excludes `.usine/` from commits and salvage. A missing output directory counts as zero outputs. Replacing the directory with a file or writing unreadable output files fails the attempt with `AgentFailure`. Other filesystem errors fail output collection. The checkout environment needs Node.js on its command path, including inside the attempt container. The orchestrator collects outputs on local, SSH, exe.dev, and Cloudflare workers, stores document bodies separately, and includes refs in the step result. Refs contain the name, type, optional commit, compact JSON content's UTF-8 byte count, and SHA-256. The orchestrator caps collection stdout and stderr, then independently checks the output count and content sizes. Collection redacts attempt credentials before calculating the stored content's byte count and SHA-256. Output reads return documents from succeeded attempts.
