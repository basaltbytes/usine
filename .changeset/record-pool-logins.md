---
"@usine/core": minor
"@usine/agents": patch
---

Record the provider login in `PoolRateLimitsUpdated.login`. Codex records the ChatGPT login email and refreshes it after an account change. Older snapshots and gateway-backed sessions remain readable without a login.
