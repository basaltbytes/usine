---
"@usine/executor": minor
"@usine/config": patch
---

Behind a Gateway, Claude Code without the Gateway's Anthropic credential, and Codex, use the operator's login on the Worker's machine and reach their provider through the Gateway's forward proxy (ADR 0027, amendment of 2026-10-15).

`@usine/executor/ssh`: preflight on a Worker behind a Gateway accepts a Claude brain when the Gateway holds the Anthropic credential (only the `claude` binary is checked) or when the login is on the machine, and a Codex brain when its login is on the machine; it no longer refuses them. A login on the machine is checked as on a Worker without a Gateway, then the machine must get an HTTP answer from each of the login's hosts through the forward proxy: `api.anthropic.com` and `platform.claude.com` for Claude Code, `chatgpt.com` and `auth.openai.com` for Codex. A host the proxy refuses fails preflight with a `gateway` capability error that names the host to add to the Gateway's egress allowlist. `SshExecutorOptions.harnessReadiness` now replaces only the login and binary checks; behind a Gateway, the Gateway's checks still run after it.

`@usine/config/factory`: `WorkerGateway` documents that a harness whose provider is not in `llm_providers` uses its login on the Worker.
