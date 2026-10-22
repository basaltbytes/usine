---
"@usine/agents": patch
---

Depend on `@anthropic-ai/claude-agent-sdk` 0.3.308. It bundles Claude Code 2.1.308, whose embedded root store no longer trusts the compromised eMudhra certificate authorities; the 2.1.261 binary bundled with 0.3.261 still did. Claude children keep running the Worker's own `claude` from PATH, so the bundled binary is not used at runtime.
