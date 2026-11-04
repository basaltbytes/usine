---
title: Agents
description: Agent harnesses, models, reasoning effort, personas, and preflight requirements.
---

Manage agents in **Configuration > Agents**, or edit an existing agent with `usine config edit agent developer`. An agent combines a brain spec and a persona. Loops reference its name. Saved edits apply to new runs after preflight; use **Edit and retry** to update a failed run's agent definition.

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

Parent model selection uses the agent override, instance default, Pi's configured default, then the first Pi model with a credential. Parent effort uses the agent override, instance default, then child effort. Pi reads configuration from `~/.pi/agent` or `PI_CODING_AGENT_DIR` for the Unix user running the orchestrator. An `openai-codex` model requires a ChatGPT login there; other providers require API keys.

An unavailable model, unsupported effort, or missing parent credential fails the attempt with `AgentFailure`. Startup preflight checks child harnesses; parent model resolution happens when the attempt starts.

## Harness requirements

| Harness | Version requirement | Authentication | Workers |
| --- | --- | --- | --- |
| `claude` | Claude Code with `auth status --json` | Claude subscription login, gateway credential, or provisioned-worker API key | Local, SSH, Cloudflare |
| `codex` | Codex CLI 0.164.0 | ChatGPT login, gateway credential, or provisioned-worker API key | Local, SSH, Cloudflare |
| `pi` | Bundled Pi runtime | API key for the selected provider | Local |

For a worker using subscription logins, run these commands as the user running its children:

```sh
claude auth login
codex login --device-auth
claude auth status
codex login status
```

A gateway can inject either a provider API key or a subscription credential. Cloudflare workers require provider API keys. Provisioned SSH workers require credentials from their gateway or `api_keys` settings. Codex subscription preflight refuses an API-key login in its login file; API-key workers use a separate provider configuration.

Children run without approval prompts. Claude Code ignores project settings, Codex treats the checkout as untrusted, and Pi ignores project-local configuration. Repository agent instructions still apply.

## Preflight

Preflight checks tools and credentials; it does not install harnesses. Startup checks each rostered child brain on every worker. A changed roster is checked before the running configuration accepts it. Each attempt also checks its selected agent. Failures identify the worker, capability, and remediation.

For local and SSH subscription workers, Claude Code must report a first-party subscription login, and Codex must report a ChatGPT login. Gateway-injected providers need the harness binary and a configured gateway credential. Pi requires a local worker and a usable API-key credential. Use [Run worker preflight](/guides/run-worker-preflight/) after fixing the machine.

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

`type` is an opaque, non-empty string of at most 128 UTF-16 code units. `content` is any JSON value. An optional `commit` must equal the attempt's pinned base commit, which is the pull request head for a pull request run. Parent and child completion instructions include the pinned base commit, including when a retry resumes from salvage. The limit is ten output files per attempt. Both each file, including its envelope, and its compact JSON content must be at most 8 MiB. Invalid outputs fail the attempt with the file path and reason; unfinished repository work follows the usual salvage procedure.

Keep a child's output documents in place until the parent returns. Preparation excludes `.usine/` from commits and salvage. A missing output directory counts as zero outputs. Replacing the directory with a file or writing unreadable output files fails the attempt with `AgentFailure`. Other filesystem errors fail output collection. The checkout environment needs Node.js on its command path, including inside the attempt container. The orchestrator collects outputs on local, SSH, exe.dev, and Cloudflare workers, stores document bodies separately, and includes refs in the step result. Refs contain the name, type, optional commit, compact JSON content's UTF-8 byte count, and SHA-256. The orchestrator caps collection stdout and stderr, then independently checks the output count and content sizes. Collection redacts attempt credentials before calculating the stored content's byte count and SHA-256. Output reads return documents from succeeded attempts.
