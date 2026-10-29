---
title: Write an agent
description: Define an agent file with its harness, model, and persona, see how the Pi parent delegates to its children, and pass harness preflight.
sidebar:
  order: 2
---

Create an agent in **Configuration > Agents > New**, or import a Markdown file from `agents/`. The export-format frontmatter sets the harness, model, and effort. Its body is the persona, the agent's standing instructions. Each loop's `agent` is the agent that does its work, and **Edit and retry** can give a failed run to another agent.

## Agent file

To add an agent from the CLI, run `usine config export ./config-export`, write the agent file below under `config-export/agents/`, and run `usine config import ./config-export --message "Add developer agent"`. Retain the other exported entities. To edit an existing agent, run `EDITOR=vi usine config edit agent developer`. A saved revision applies to new runs after preflight; running attempts keep their definitions.

Two agents from the factory that runs usine on its own repository:

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

[Agent files](/reference/configuration/agent-files/) lists the frontmatter keys and validation rules. An invalid agent rejects the complete import or edit and saves no revision.

## Parent and child sessions

Each attempt runs two levels of sessions:

- The **Pi parent** runs in the orchestrator. Its first message is the run's [prompt](/reference/configuration/loop-files/#agent-prompt). Its only tool is `subagent`.
- Each `subagent` call starts one **child** with the agent's harness, model, and effort, in the attempt's checkout on the worker. The child receives the persona, the task text that the parent wrote, and usine's rules, and returns its final answer to the parent. The parent can run several children at once. A child can't start children.

Both levels receive the persona, so write it for both. The personas above tell a session that has the `subagent` tool to delegate the whole task once, and a session without it to do the work. So the parent delegates and the child works.

`settings.max_children` limits the children per attempt (default 4). One more child fails the attempt with `ChildSessionBudgetFailure`.

## Harnesses

| `harness` | Runs                                                                                                      | Requirements where children run                                                                               | Pool             |
| --------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `claude`  | the `claude` executable through the Claude Agent SDK, with permission prompts bypassed and only the user's own Claude settings | `claude` on the `PATH`, logged in with a Claude subscription                                                    | the Claude plan, or API keys if the worker's gateway injects an Anthropic API key |
| `codex`   | `codex app-server`, with approval policy `never` and the `danger-full-access` sandbox                     | Codex CLI 0.153.4 or 0.159.0 through 0.159.3, logged in with ChatGPT. usine refuses an API-key login.                          | the ChatGPT plan |
| `pi`      | the Pi coding agent in the orchestrator process                                                           | a local worker, and an API key for the model's provider in Pi's configuration                                    | API keys         |

Children ignore the repository's harness settings, because usine treats the checkout as untrusted: Claude Code loads no project settings, Codex marks the worktree untrusted, and Pi ignores a project `.pi/` folder. The repository's `AGENTS.md` still applies. [Effort values](/reference/configuration/agent-files/#frontmatter-fields) map to each harness's own setting.

## Pi parent

The parent needs a model credential in Pi's configuration for the user who runs `usine up`: a ChatGPT login for an `openai-codex` model, or an API key for another provider. The factory that runs usine on its own repository sets `parent_model: openai-codex/gpt-5.6-terra` and `parent_effort: medium` under `settings`, so every parent uses the ChatGPT plan. [Pi parent](/reference/configuration/agent-files/#pi-parent) describes how usine picks the parent model and effort.

## Log in to the harnesses

usine checks each harness login before it uses it ([Preflight](/reference/configuration/agent-files/#preflight)), but never logs in for you. Log in on the machine that runs the children, as the user that runs them: the user who runs `usine up` on a local worker, whose `HOME` children get, or the SSH user on an SSH worker.

```sh title="Worker, as the user that runs the children"
claude auth login          # Claude subscription: open the URL it prints, then paste the code back
codex login --device-auth  # ChatGPT plan: open the URL it prints and enter the code it prints
```

To check the result, run `claude auth status` and `codex login status`. A worker behind a gateway with `llm_providers: [anthropic]` needs no Claude Code login.

Select **Save** to apply the revision. The editor reports validation and worker preflight failures without discarding the text. Use **History** on the agent page to inspect or revert a change. See [Configuration editing](/guides/#change-the-configuration).
