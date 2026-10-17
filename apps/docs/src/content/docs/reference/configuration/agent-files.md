---
title: Agent files
description: The frontmatter fields of an Agent file, how its body becomes the Agent's persona, and how the roster is built.
sidebar:
  order: 3
---

An Agent is one Markdown file in the `agents/` folder of the instance folder. The filename without `.md` is the Agent's name, which Loop files use in their `agent` field. The frontmatter is the Agent's brain spec: the harness, model, and reasoning effort of the child sessions it runs, plus optional settings for the Attempt's Pi parent. The body is the persona: standing instructions given to every session the Agent runs.

The orchestrator reads every file ending in `.md` directly inside `agents/`, in name order, once at startup. The folder must exist, even when empty.

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

An Agent without parent settings uses the factory defaults from `usine.yaml`:

```markdown title="agents/developer.md"
---
harness: codex
model: gpt-6-astra
effort: medium
---
Complete one repository task at a time. Follow the repository instructions, keep the branch reviewable, run the required checks, and record any blocker on the issue or pull request.
```

## File format

The file has the same layout as a Loop file: a `---` line, YAML frontmatter, a closing `---` line, then the body ([`splitMarkdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/frontmatter.ts#L24)). The filename must be kebab-case: lowercase letters and digits separated by single hyphens ([`AgentName`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/agent.ts#L5)).

## Frontmatter fields

An unknown key is an error, as are duplicate keys.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `harness` | `claude`, `codex`, `pi` | required | The coding runtime of the Agent's child sessions: Claude Code, Codex CLI, or Pi. |
| `model` | string | required | The model the harness runs, in the harness's own model ID format. Non-blank; the harness checks that the model exists when a session starts. |
| `effort` | effort | required | Reasoning effort of the child sessions. |
| `parent_model` | string | `settings.parent_model` | Model of the Attempt's Pi parent, as `provider/model`. |
| `parent_effort` | effort | `settings.parent_effort`, then `effort` | Reasoning effort of the Attempt's Pi parent. |

The effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` ([`EFFORTS`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/brain.ts#L16)). Which levels work depends on the harness and the model.

### The Pi parent

Every Attempt runs a Pi parent session inside the orchestrator, whatever harness the Agent uses. The parent receives the rendered task and delegates work to child sessions that run the Agent's harness, model, and effort on the Worker.

usine picks the parent's model in this order: the Agent's `parent_model`, then `settings.parent_model` in `usine.yaml`, then Pi's configured default model, then the first Pi model with a configured credential ([`resolveParent`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/durable/src/attempt/parent.ts#L101)). It picks the parent's effort from the Agent's `parent_effort`, then `settings.parent_effort`, then the Agent's own `effort` ([`resolveParentEffort`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/agent/agent.ts#L39)).

An Attempt fails before its conversation starts when Pi doesn't provide the parent model, when the model doesn't support the parent effort, or when no credential is available for the model's provider.

## The body: persona

Everything after the closing `---` line is the persona. It must contain at least one non-whitespace character. usine inserts it, unchanged, under an `# Agent persona` heading in the instructions of the Attempt's Pi parent and of every child session the parent spawns ([`assemblePrompt` and `assembleChildPrompt`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/prompt.ts#L58)).

Use the persona for instructions that apply to every Loop that uses the Agent: how it works, what it never does, and how it reports. The Loop body contains the task for one Item.

usine adds its own instructions after the persona and the task. You can't change them:

- Run checks in the foreground, and push every commit to keep before returning.
- Start the final answer with a reserved blocked marker to report a blocker; that answer fails the Attempt.
- Submit pull request reviews as comments, never approvals.
- End every GitHub comment, issue, pull request, and review with `— usine agent: <name>`, where `<name>` is the Agent's name.

Loops can rely on the signature. The `act-on-findings` example in [Loop files](/reference/configuration/loop-files/#more-examples) counts reviews whose body contains `usine agent: reviewer`.

## The roster

Every valid Agent file is added to the roster. usine leaves out a file that fails validation and quarantines every Loop that references it, with the message `Unknown agent: <name>`. As with Loops, `usine up` doesn't log or display an invalid Agent file at this commit.

| Stage | Checks |
| --- | --- |
| `schema` | The filename ends in `.md` and is kebab-case. |
| `read` | The file can be read. |
| `frontmatter` | Opening and closing `---` lines. |
| `yaml` | YAML syntax, no duplicate keys, no parser warnings. |
| `schema` | Frontmatter keys and values; a non-blank body. |

### Preflight

When `usine up` starts, it checks every rostered harness, model, and effort on every Worker before it runs any Attempt. A failed check stops startup ([`verifyHarness`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/preflight/preflight.ts#L35)).

| `harness` | Runs | Preflight checks |
| --- | --- | --- |
| `claude` | Claude Code | The `claude` binary, and a Claude subscription login on the Worker. Behind a Gateway whose `llm_providers` lists `anthropic`, only the binary. |
| `codex` | Codex CLI | The `codex` binary at version 0.144.0 or 0.153.4, and an account that can use `model`. |
| `pi` | Pi, the SDK inside the orchestrator | The model is available with API-key authentication and supports `effort`. Pi children run only on local Workers: on an SSH Worker the check fails. |
