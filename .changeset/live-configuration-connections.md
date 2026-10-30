---
"@usine/server": patch
"@usine/orchestrator": patch
"@usine/executor": patch
---

Apply webhook modes and URLs, worker connections, and new Cloudflare workers without restarting the orchestrator. Existing attempts retain their machine and cleanup clients. A changed worker connection runs preflight after acceptance and disables new scheduling if the check fails, with automatic retries. Document tracing as a restart-only setting because existing runtime fibers retain the process-wide tracer context.
