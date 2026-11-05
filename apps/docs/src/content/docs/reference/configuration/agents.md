---
title: Agents
description: Agent harnesses, models, reasoning effort, personas, and preflight requirements.
---

Manage agents in **Configuration > Agents**, or edit an existing agent with `usine config edit agent developer`. An agent combines a brain spec and a persona. Loops reference its name. Saved edits apply to new runs after preflight; use **Edit and retry** to update a failed run's agent definition.

Harness IDs use kebab case and must match an entry in the server’s harness catalog. The catalog contains `claude`, `codex`, and `pi`. An unregistered ID fails agent schema validation.

The server builds one harness runtime registry at startup and shares it between worker preflight and child sessions. An incomplete registration fails startup. Preflight errors identify the harness installation to check: host-login routes include login guidance, gateway and API-key routes refer to the worker installation, and Cloudflare routes refer to the sandbox image. Successful binary probes log the installed version.

## Agent

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| name | kebab-case string | required | Unique instance-level agent name used by loops. |
| `harness` | `claude`, `codex`, or `pi` | required | Coding-agent harness used by child sessions. |
| `model` | non-blank string | required | Model ID understood by the harness, with `provider/model` for Pi. |
| `effort` | effort | required | Reasoning effort of child sessions. |
| `parent_model` | string | instance setting, then Pi selection | Model for the Pi parent in `provider/model` form. |
| `parent_effort` | effort | instance setting, then child effort | Reasoning effort of the Pi parent. |
| persona | non-blank Markdown | required | Standing instructions included for the parent and every child. |

For example, create `developer` with harness `codex`, model `gpt-6-astra`, effort `medium`, and this persona:

```text
Complete one repository task at a time. Follow the repository instructions.
Run the required checks, push the branch, and record blockers on the item.
Do not merge pull requests.
```

Effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Claude Code disables thinking for `off` and treats `minimal` as `low`. Codex receives `off` as `none` and checks the selected model's supported efforts. Pi uses the value as its thinking level.

## Parent selection

Every attempt has a Pi parent in the orchestrator. Its `subagent` tool starts child sessions on the worker using the agent's harness, model, and effort. Children cannot create nested children. The [child-session budget](/reference/configuration/settings/#instance-settings) counts all child starts over the attempt's lifetime.

Parent model selection uses the agent override, instance default, Pi's configured default, then the first Pi model with a credential. Parent effort uses the agent override, instance default, then child effort. Pi reads model defaults from `~/.pi/agent` or `PI_CODING_AGENT_DIR` for the Unix user running the orchestrator. With a gateway, the parent uses the first gateway declared by the SSH workers and needs no local provider login. Use `openai-codex/<model>` for its ChatGPT login, or `openai/<model>` and `anthropic/<model>` for its API keys. Without a gateway, an `openai-codex` model requires a local ChatGPT login; other providers require local API keys.

An unavailable model, unsupported effort, or missing parent credential fails the attempt with `AgentFailure`. Startup preflight checks child harnesses and the gateway route and credentials for configured parent providers. Parent model and effort resolution happens when the attempt starts.

## Harness requirements

| Harness | Version requirement | Authentication | Workers |
| --- | --- | --- | --- |
| `claude` | Claude Code with `auth status --json` | Claude subscription login, setup token, or API key | Local, SSH, Cloudflare |
| `codex` | Codex CLI 0.164.0 | ChatGPT login or API key | Local, SSH, Cloudflare |
| `pi` | Bundled Pi runtime | API key for the selected provider or ChatGPT login for `openai-codex` | Local |

For a worker using subscription logins, run these commands as the user running its children:

```sh
claude auth login
codex login --device-auth
claude auth status
codex login status
```

A gateway can inject either a provider API key or a subscription credential. Cloudflare workers require provider API keys. Provisioned SSH workers require credentials from their gateway or `api_keys` settings. Local preflight and children accept managed Claude setup tokens and API keys, and Codex ChatGPT logins and API keys. Local Codex launches select file credential storage so they use the credentials managed by `usine login` and removed by `usine logout`, including when Codex configuration selects keyring storage.

For Pi children on a ChatGPT subscription, set `harness` to `pi` and `model` to an `openai-codex/...` model. Run Pi as the Unix user running the orchestrator, with the same `~/.pi/agent` or `PI_CODING_AGENT_DIR` configuration as the parent. Enter `/login` and choose **OpenAI (ChatGPT Plus/Pro)** for the `openai-codex` provider. Preflight accepts that login without an API key. Other OAuth providers have no supported usine pool and fail preflight.

Each parent and child session records the billing pool resolved at launch. Usage totals read that recorded pool, including after an orchestrator restart. Older transcripts without a recorded pool use the historical harness and model rule.

OpenAI-compatible endpoints and local models use `apiKeys`. API-key sessions record the endpoint's provider name when available, such as a Pi provider configured in `models.json`. The transcript includes the name without the endpoint URL or credential. An API-key credential uses `apiKeys` even when the model ID has an `openai-codex/` prefix.

Pi parents and children record ChatGPT usage under `chatgptPlan`, including tokens and Pi's cost estimate. Pi reports no plan rate windows, so usine cannot warn before Pi sessions reach the ChatGPT plan limit.

Claude Code subscription sessions report allowance usage under `claudePlan`, including usage outside usine. The five-hour allowance appears as the primary window, and the latest reported seven-day allowance appears as the secondary window, including model-specific allowances. **Needs attention** warns when a reported window reaches 80% usage and has a future reset time. Later reports update only the reported window and preserve the other window across children and attempts. Claude plan reports apply to worker subscription logins and gateway subscription credentials; API-key sessions do not update Claude plan windows. A report without utilization leaves the recorded windows unchanged, and an omitted reset time remains unknown.

Pi children save their conversations in `.usine/pi/sessions` under the attempt checkout. The transcript records the saved session ID and directory. Keep both the checkout and session files to continue a conversation after its process exits. The Pi runtime's `resume(request, savedId)` operation starts a continuation with the request's prompt in that checkout; a missing ID fails instead of starting a new conversation. An orchestrator restart still interrupts an active `subagent` call.

Children run without approval prompts. Claude Code ignores project settings, Codex treats the checkout as untrusted, and Pi ignores project-local configuration. Repository agent instructions still apply.

Codex disables the checkout's project-local configuration, hooks, and exec policies even if its saved configuration marks the checkout as trusted. Its app server starts in `/`, outside the checkout and home directory, to avoid loading repository configuration at startup or reporting disabled project configuration in the worker's `.codex` directory. Other Codex diagnostics log at Warning.

## Preflight

Preflight checks tools and credentials; it does not install harnesses. Startup checks each rostered child brain on every worker. A changed roster is checked before the running configuration accepts it. Each attempt also checks its selected agent. Failures identify the worker, capability, and remediation.

For workers using harness credentials, Claude Code must report a first-party subscription login, setup token, or API key, and Codex must report a ChatGPT login or API key. Gateway-injected and attempt API-key credentials use the same harness binary and version checks, with authentication supplied by their credential route. Claude Code accepts any installed version; Codex requires a supported version. Claude Code's host-login checks and child startup share a lock for the same worker login. Pi requires a local worker and an API key for the selected provider or an `openai-codex` ChatGPT login. Use [Run worker preflight](/guides/run-worker-preflight/) after fixing the machine.

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
