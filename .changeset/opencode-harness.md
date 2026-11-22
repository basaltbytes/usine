---
"@usine/agents": minor
"@usine/executor": patch
"@usine/server": minor
---

Agents can run on OpenCode: set `harness` to `opencode` and `model` to an OpenAI model ID from OpenCode's catalog, such as `gpt-5.4-mini`. The harness pins `@opencode/cli` 2.3.2 and runs `opencode serve` behind the OpenCode bridge on local and SSH workers, on an OpenAI API key from the attempt or through the gateway's `openai-responses` slot. Its sessions run the coding agent: they take steering, operator messages, and interrupts, report each message that OpenCode reads, wait for background commands and subagents, report tokens and cost, end with a capacity refusal on a distant retry, a quota, or a plan limit, and reopen their saved session after a restart. Each session gets its own OpenCode data directory, and OpenCode reads no configuration from the checkout except its root `AGENTS.md`. Preflight checks the OpenCode version and the model on every credential route. OpenCode serves no usine tools and no structured completions yet, so it refuses the supervisor role and decision models.

- `@usine/agents/harness`: the catalog registers `opencode`. A `worker.install` entry takes `optionalDependencies: "omit"`, and `workerImageInputs(catalog, placement)` returns the packages and tag of the harnesses that run at `placement`, with such entries in `npmPackagesWithoutOptional`. The Cloudflare sandbox image installs only the harnesses with a `sandbox` placement, so it doesn't install OpenCode.
- `@usine/executor`: the attempt image is `ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.164.0-opencode-2.3.2`, which also installs `rg`. Hetzner workers install OpenCode and `rg` too.
