---
"@usine/gateway": minor
---

New package: the gateway service for worker VMs without public addresses. A reverse proxy serves GitHub at `git.<domain>` and the Anthropic and OpenAI-compatible APIs at `llm.<domain>` and replaces the worker's caller token with the attached installation token or the gateway's API key; a forward proxy connects only to allowlisted hosts whose TLS ClientHello matches the CONNECT host; an admin API manages attachments. `@usine/gateway/node` runs the three servers on Node, and the `usine-gateway` command runs them from the environment.
