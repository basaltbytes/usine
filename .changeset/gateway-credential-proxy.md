---
"@usine/gateway": minor
---

New package: the gateway service for Worker VMs without public addresses. A reverse proxy serves GitHub at `git.<domain>` (git smart HTTP and the REST and GraphQL API, so `gh` works with `GH_HOST`) and the Anthropic and OpenAI-compatible APIs at `llm.<domain>`, adding the installation token the executor attached for the Worker and repository, or the gateway's API key, in place of the Worker's caller token. A forward proxy opens connections only to the hosts on an allowlist file, and a tunnel only when the TLS ClientHello names the CONNECT host. The admin API attaches, renews, detaches, and lists attachments for the executor; each caller token is bound to its attachment's id. `@usine/gateway/node` runs the three servers on Node, and the `usine-gateway` command runs them from the environment.
