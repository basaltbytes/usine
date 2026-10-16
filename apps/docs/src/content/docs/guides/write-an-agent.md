---
title: Write an Agent
description: Define an Agent file with its harness, model, and persona, see how the Pi parent delegates to its children, and pass harness preflight.
sidebar:
  order: 2
---

An Agent is a named member of the factory's team: a Markdown file in `agents/` whose frontmatter says which harness and model do its work, and whose body is its standing instructions, the persona. Every Agent file that loads is part of the roster. Each Loop sets `agent` to the Agent that does its work, and **Edit and retry** can move a failed Run to another Agent of the roster.

## The Agent file

These are two Agents of the factory that runs usine on its own repository:

```markdown title="agents/developer.md"
---
harness: codex
model: gpt-6-astra
effort: medium
---

Complete one repository task at a time. If and only if a tool literally named `subagent` is available, delegate the full task to it once and return its result. Otherwise, do the work yourself. Never use `spawn_agent`, another delegation tool, or create a nested child. Follow the repository instructions, keep the branch reviewable, run the required checks, and record any blocker on the issue or pull request.
```

```markdown title="agents/finisher.md"
---
harness: claude
model: claude-fable-5-1
effort: xhigh
---

Finish one pull request at a time. Own the latest findings, direct fixes, final inspection, required checks, push, review record, and outcome labels specified by the task. Follow the repository's `finish-pr` skill. Keep changes within the PR's scope and do not merge it.

If and only if a tool literally named `subagent` is available, delegate this complete finishing task to it once, including the PR context and all completion requirements, then return its completion or blocker report. Otherwise, do the work yourself. Do not divide the task into review-only and fix-only children, use another delegation tool, or launch a nested reviewer.
```

| Key             | Values                                                        | Required |
| --------------- | ------------------------------------------------------------- | -------- |
| `harness`       | `claude`, `codex`, or `pi`                                    | yes      |
| `model`         | a model id of that harness; Pi takes `provider/model`         | yes      |
| `effort`        | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`  | yes      |
| `parent_model`  | the Pi parent's model as `provider/model`                     | no       |
| `parent_effort` | the Pi parent's effort, with the same values as `effort`      | no       |

The file name without `.md` is the Agent's name, and it must be kebab-case. The body must not be blank, and a file with a key outside this table does not load. An Agent file that does not load is left out of the roster, and so is every Loop whose `agent` is that Agent. [Agent files](/reference/configuration/agent-files/) has the full validation rules.

## How an Agent runs an Attempt

Each Attempt runs two levels of sessions.

The **Pi parent** runs inside the orchestrator process, whatever the Worker. Its first message is the Run's prompt: the repository, the Item payload, the persona, the task, and usine's rules for finishing and for GitHub. Its only tool is `subagent`.

Each `subagent` call starts one **child** with the Agent's harness, model, and effort, in the Attempt's checkout on the Worker. The child receives the persona, the task text the parent wrote for it, and the same rules, and its final answer goes back to the parent as the tool result. The parent can run several children at once. A child cannot start children of its own.

The persona goes to the parent and to every child, so write it for both. Only the parent has the `subagent` tool, and the personas above use that: they tell a session with the tool to delegate the whole task once and a session without it to do the work, so the parent delegates and the child works.

`settings.max_children` in `usine.yaml` caps how many children one Attempt may start, in sequence or in parallel; the default is 4. The next one fails the Attempt with `ChildSessionBudgetFailure`, and the Run waits for you.

## Harnesses

| `harness` | Runs                                                                                                      | Needs where children run                                                                                      | Billed to        |
| --------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `claude`  | the `claude` executable through the Claude Agent SDK, with permission prompts bypassed and only the user's own Claude settings | `claude` on the `PATH`, logged in with a Claude subscription                                                    | the Claude plan  |
| `codex`   | `codex app-server`, with approval policy `never` and the `danger-full-access` sandbox                     | Codex CLI 0.144.0 or 0.153.4, logged in with ChatGPT; an API-key login is refused                               | the ChatGPT plan |
| `pi`      | the Pi coding agent inside the orchestrator process                                                       | a local Worker, and an API key for the model's provider in Pi's configuration                                    | API keys         |

A child ignores the harness settings that the repository itself contains, because the checkout is input that the repository controls: Claude Code loads no project settings, Codex marks the worktree untrusted, and Pi ignores a project `.pi/` folder. The repository's `AGENTS.md` instructions still apply.

`effort` maps onto each harness. Claude Code turns thinking off for `off` and runs `minimal` as `low`. Codex receives `off` as `none`, and the effort must be one that Codex lists for the model, or the child fails to start. Pi uses the effort as the session's thinking level.

## The Pi parent

The parent's model is the first of these that is set:

1. `parent_model` in the Agent file;
2. `settings.parent_model` in `usine.yaml`;
3. the default model in Pi's own settings;
4. the first model for which Pi has a credential.

Its effort is `parent_effort`, then `settings.parent_effort`, then the Agent's `effort`. The factory that runs usine on its own repository sets `parent_model: openai-codex/gpt-5.6-terra` and `parent_effort: medium` under `settings`, so every Agent's parent uses the ChatGPT plan.

The parent reads Pi's configuration and credentials for the user who runs `usine up`: `~/.pi/agent`, or the folder set in `PI_CODING_AGENT_DIR`. A model of the `openai-codex` provider needs a ChatGPT subscription login there and is billed to the ChatGPT plan; a model of any other provider needs an API key. The parent model is not checked at startup. When an Attempt starts, an unknown model, an effort the model does not support, or a missing credential fails the Attempt with `AgentFailure`.

## Preflight

usine checks every harness before it relies on it, and installs nothing itself.

- At startup, it checks every Worker for every distinct harness, model, and effort in the roster. A failure stops `usine up` with the Worker, the harness, and the missing piece.
- Before each Attempt, it checks the Attempt's own Agent again on the chosen Worker. A failure ends the Attempt with `AgentFailure`, and the Run waits for you: fix the Worker, then **Retry**.

| Harness  | Check                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude --version` runs, and `claude auth status --json` reports a login through claude.ai with the first-party API. Otherwise the error says `Claude requires a subscription login; run claude auth login on the Worker`. |
| `codex`  | `codex --version` prints `codex-cli 0.144.0` or `codex-cli 0.153.4`, and the Codex app server reports a ChatGPT account. Otherwise the error says `Codex children require a ChatGPT login; run codex login on the Worker`. |
| `pi`     | The Worker is local, and a Pi session starts with the model and an API key.                                                                                                                                                  |

Each check gives up after 60 seconds. Preflight also checks Git on every Worker, and the connection and Gateway of an SSH Worker ([Add a Worker](/guides/add-a-worker/#preflight)). The model of a Claude Code or Codex child is checked only when the child starts.

## Log in to the harnesses

The harness logins are yours, and they stay on the machine where the children run, under the user that runs them. On a local Worker that is the user who runs `usine up`: children get that user's `HOME`. On an SSH Worker it is the SSH user.

```sh title="Worker, as the user that runs the children"
claude auth login          # Claude subscription: open the URL it prints, then paste the code back
codex login --device-auth  # ChatGPT plan: open the URL it prints and enter the code it prints
```

`claude auth status` and `codex login status` show the result. A Worker behind a Gateway that has an Anthropic key (`llm_providers: [anthropic]`) needs no Claude Code login: its children call the Gateway with the Attempt's caller token, and preflight checks only that the `claude` binary runs.

usine reads Agent files at startup only. Restart `usine up` after you add or change one.
