---
"@usine/cloudflare": minor
"@usine/executor": minor
"@usine/config": minor
"@usine/core": minor
"@usine/agents": minor
"@usine/orchestrator": minor
---

Adds the `cloudflare` Worker kind, which runs each attempt in its own Cloudflare sandbox ([#551](https://github.com/basaltbytes/usine/issues/551)).

- `@usine/cloudflare` is the Worker that you deploy to your Cloudflare account: a Durable Object per attempt that owns one container from a named image, a WebSocket exec stream whose commands keep pid, log, and exit-code files so a dropped stream can attach again, a keepalive alarm, and outbound handlers that add the attempt's installation token for `github.com` and `api.github.com` and the provider API key for Claude Code and Codex. The container receives no credential and reaches no other host, except the hosts in `ALLOWED_HOSTS`. Every request needs the Cloudflare Access service token headers. The package also exports the sandbox API contract, the stream messages, and the harness environment, and ships the Wrangler configuration and the image's Dockerfile.
- `@usine/config` accepts `kind: cloudflare` workers with `worker_url`, `access_client_id_env`, `access_client_secret_env`, `image`, `instance_type` (default `standard-4`), and `llm_providers`, each with an `api_key_env`. `@usine/core` adds `cloudflare` to the Worker kinds, and the `CloudflareInstanceType`, `CloudflareImageName`, and `CloudflareLlmProvider` schemas.
- `@usine/executor/cloudflare` creates a sandbox per attempt, runs each child, git, and gh command in it through the sandbox shell, renews the installation token in the Worker, stops the sandbox's commands and destroys it when the attempt ends, revokes the credentials of a sandbox that it keeps, reattaches a live attempt after a restart, and destroys a worker's orphan sandboxes. Sandbox names and orphan cleanup are scoped to the usine instance, the GitHub App, so instances that share a deployed Worker keep apart. Preflight checks the Worker's health route, its image, the provider keys, and the image's Claude Code and Codex versions.
- `@usine/orchestrator` runs the instance on the Cloudflare executor when every worker is `cloudflare`, and its new `/cloudflare` subpath reads each worker's Access service token and provider keys at startup.
- `@usine/agents` lets a Codex child on a worker that injects the OpenAI API key outside the machine use a model provider that needs no ChatGPT login, and counts it in the API keys pool.

Sandboxes can't be kept in the EU: the Sandbox SDK 1.0 needs the `durable_object` scheduling policy, which rejects `jurisdiction` placement.
