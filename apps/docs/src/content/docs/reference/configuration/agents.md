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
| `pi` | Bundled Pi runtime | API key for the selected provider or ChatGPT login for `openai-codex` | Local |

For a worker using subscription logins, run these commands as the user running its children:

```sh
claude auth login
codex login --device-auth
claude auth status
codex login status
```

A gateway can inject either a provider API key or a subscription credential. Cloudflare workers require provider API keys. Provisioned SSH workers require credentials from their gateway or `api_keys` settings. Codex subscription preflight refuses an API-key login in its login file; API-key workers use a separate provider configuration.

For Pi children on a ChatGPT subscription, set `harness` to `pi` and `model` to an `openai-codex/...` model. Run Pi as the Unix user running the orchestrator, with the same `~/.pi/agent` or `PI_CODING_AGENT_DIR` configuration as the parent. Enter `/login` and choose **OpenAI (ChatGPT Plus/Pro)** for the `openai-codex` provider. Preflight accepts that login without an API key. Other OAuth providers have no supported usine pool and fail preflight.

Pi parents and children record ChatGPT usage under `chatgptPlan`, including tokens and Pi's cost estimate. Pi reports no plan rate windows, so usine cannot warn before Pi sessions reach the ChatGPT plan limit.

Children run without approval prompts. Claude Code ignores project settings, Codex treats the checkout as untrusted, and Pi ignores project-local configuration. Repository agent instructions still apply.

## Preflight

Preflight checks tools and credentials; it does not install harnesses. Startup checks each rostered child brain on every worker. A changed roster is checked before the running configuration accepts it. Each attempt also checks its selected agent. Failures identify the worker, capability, and remediation.

For local and SSH subscription workers, Claude Code must report a first-party subscription login, and Codex must report a ChatGPT login. Gateway-injected providers need the harness binary and a configured gateway credential. Pi requires a local worker and an API key for the selected provider or an `openai-codex` ChatGPT login. Use [Run worker preflight](/guides/run-worker-preflight/) after fixing the machine.

Every GitHub comment, issue, pull request, and review written by an agent ends with `— usine agent: <name>`. Agents share the App identity, so this signature attributes their work to an attempt. Commits use the App's bot identity.
