---
title: Agent files
description: The frontmatter fields of an agent file, how its body becomes the agent's persona, and how usine builds the roster.
sidebar:
  order: 3
---

An agent is one Markdown file in `agents/`. The file name without `.md` is the agent name, which loops use in their `agent` field. The frontmatter is the brain spec: the harness, model, and reasoning effort of the child sessions, and optional settings for the attempt's Pi parent. The body is the persona, the standing instructions for every session of the agent.

The orchestrator reads every `.md` file directly in `agents/`, in name order, at startup and at each [reload](/reference/configuration/cli/#reload). The folder must exist, even if it's empty. A run keeps the agent that it opened with, so an edited agent applies to new runs.

The schema is [`AgentFrontmatter`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L44) in `packages/config/src/parser.ts`, which produces an [`AgentFile`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/agent.ts#L7).

## Example

```markdown title="agents/finisher.md"
---
harness: claude
model: claude-fable-5-1
effort: xhigh
parent_model: openai-codex/gpt-5.6-terra
parent_effort: medium
---
Finish one pull request at a time. Own the latest findings, direct fixes, final inspection, required checks, push, and outcome labels specified by the task. Keep changes within the pull request's scope and do not merge it.
```

An agent without parent settings uses the factory defaults from `usine.yaml`:

```markdown title="agents/developer.md"
---
harness: codex
model: gpt-6-astra
effort: medium
---
Complete one repository task at a time. Follow the repository instructions, keep the branch reviewable, run the required checks, and record any blocker on the issue or pull request.
```

## File format

The file has the same layout as a loop file: a `---` line, YAML frontmatter, a closing `---` line, and the body ([`splitMarkdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/frontmatter.ts#L24)). The file name must be kebab-case: lowercase letters and digits separated by single hyphens ([`AgentName`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/agent.ts#L5)).

## Frontmatter fields

Unknown keys and duplicate keys are errors.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `harness` | `claude`, `codex`, `pi` | required | The harness of the agent's child sessions: Claude Code, Codex CLI, or Pi. |
| `model` | string | required | The model that the harness runs, in the harness's model ID format. Pi takes `provider/model`. Must not be blank. The harness checks that the model exists when a session starts. |
| `effort` | effort | required | Reasoning effort of the child sessions. |
| `parent_model` | string | `settings.parent_model` | Model of the attempt's Pi parent, as `provider/model`. |
| `parent_effort` | effort | `settings.parent_effort`, then `effort` | Reasoning effort of the attempt's Pi parent. |

The effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` ([`EFFORTS`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/brain.ts#L16)). The levels that work depend on the harness and the model:

- Claude Code turns thinking off for `off` and runs `minimal` as `low`.
- Codex receives `off` as `none`. The effort must be one that Codex lists for the model, or the child fails to start.
- Pi uses the effort as the session's thinking level.

### Pi parent

Every attempt runs a Pi parent session in the orchestrator, whatever harness the agent uses. The parent receives the rendered task and delegates work to child sessions that run the agent's harness, model, and effort on the worker.

usine picks the parent model in this order: the agent's `parent_model`, `settings.parent_model` in `usine.yaml`, Pi's configured default model, and the first Pi model with a configured credential ([`resolveParent`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/durable/src/attempt/parent.ts#L101)). It picks the parent effort from the agent's `parent_effort`, then `settings.parent_effort`, then the agent's own `effort` ([`resolveParentEffort`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/agent.ts#L39)).

The parent reads Pi's configuration and credentials for the user who runs `usine up`, from `~/.pi/agent` or the folder in `PI_CODING_AGENT_DIR`. An `openai-codex` model needs a ChatGPT subscription login there and uses the ChatGPT plan. Any other provider needs an API key. usine doesn't check the parent model at startup. An attempt fails with `AgentFailure` before its conversation starts if Pi doesn't provide the parent model, the model doesn't support the parent effort, or no credential is available for the model's provider.

## Persona

Everything after the closing `---` line is the persona, and it must not be blank. usine inserts it unchanged, under an `# Agent persona` heading, in the instructions of the Pi parent and of every child that the parent starts ([`assemblePrompt` and `assembleChildPrompt`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/prompt.ts#L58)).

Use the persona for instructions that apply to every loop of the agent: how it works, what it never does, and how it reports. The loop body has the task for one item. After both, usine adds [fixed instructions](/reference/configuration/loop-files/#agent-prompt) that you can't change, including the signature `— usine agent: <name>` at the end of every GitHub comment, issue, pull request, and review.

Loops can rely on the signature, as the `act-on-findings` example in [More examples](/reference/configuration/loop-files/#more-examples) does. Agents write to GitHub as one bot login, so an attempt counts a comment or review on its item as its own only if the body ends with its agent's signature. Other comments aren't listed with the attempt on the task page, and don't count as its work when the parent's last turn answered the operator. Commits have the GitHub App's bot as author and committer on every worker, whatever git identity the worker's user has configured.

## Roster

Every valid agent file is in the roster. usine leaves out an invalid file, and quarantines every loop that references it with `Unknown agent "<name>": agents/<name>.md is missing or invalid. Fix the agent file, or set agent to an existing agent.` At startup and at each reload, it logs each invalid file with its stage and message, and lists it in **Needs attention** as **Agent file not loaded**.

| Stage | Checks |
| --- | --- |
| `schema` | The file name ends in `.md` and is kebab-case. |
| `read` | The file can be read. |
| `frontmatter` | Opening and closing `---` lines. |
| `yaml` | YAML syntax, no duplicate keys, no parser warnings. |
| `schema` | Frontmatter keys and values, and a non-blank body. |

### Preflight

usine checks harnesses without installing anything ([`verifyHarness`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/preflight/preflight.ts#L35)):

- At startup, it checks every harness, model, and effort in the roster on every worker. A failed check stops startup with an error that gives the worker, the harness, and what is missing.
- Before a reload replaces the roster, it checks each harness, model, and effort that no running agent uses, on every worker. A failed check refuses the reload with `ReloadPreflightError`. In setup mode, a reload checks nothing, and the next `usine up` checks the whole roster.
- When an attempt starts, it checks the attempt's agent on the chosen worker. A failed check fails the attempt with `AgentFailure`, and the run waits for you to fix the worker and retry.

| `harness` | Runs | Preflight checks |
| --- | --- | --- |
| `claude` | Claude Code | `claude --version` runs, and `claude auth status --json` reports a claude.ai login with the first-party API. If it reports another login or none, the error is `Claude Code needs a subscription login. Run claude auth login on the worker.`. If it exits 0 without a login status, it's `Claude returned an unrecognized login status`. If it fails otherwise, it's `claude auth status --json failed. Check the claude installation and login on the worker.`. Behind a gateway whose `llm_providers` lists `anthropic`, only the binary. |
| `codex` | Codex CLI | `codex --version` prints `codex-cli 0.153.4` or `codex-cli 0.159.0` through `codex-cli 0.159.3`, and the Codex app server reports a ChatGPT account. For an unsupported version, the error is `The worker has codex-cli <version>. Install a supported Codex CLI version: <versions>.`. Without a ChatGPT account, it's `Codex children need a ChatGPT login. Run codex login on the worker.`. |
| `pi` | Pi, the SDK in the orchestrator | The model is available with API-key authentication and supports `effort`. Pi children run only on local workers, so the check fails on an SSH worker. |

For `claude` and `codex`, if the worker can't start the binary, the error is `The worker can't run claude` or `The worker can't run codex`. If `--version` exits with an error, it's `claude --version failed. Check the claude installation and login on the worker.` or `codex --version failed. Check the codex installation and login on the worker.`. An SSH worker without the binary gives the second kind of error.

Each check times out after 60 seconds. usine doesn't check the model of a Claude Code or Codex child until the child starts. Worker preflight also checks Git, memory, and, for SSH workers, the connection and gateway ([Add a worker](/guides/add-a-worker/#preflight)).

All Claude processes on a worker share its Claude login, so usine runs one Claude check at a time on a worker, and none while a Claude child starts there. If a Claude child still fails with `Failed to refresh OAuth token: another Claude Code process ...`, usine starts it again after 15, 30, and then 60 seconds. The parent sees the error only if the last start also fails.
