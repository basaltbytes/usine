---
"@usine/orchestrator": patch
"@usine/server": patch
---

A configuration write or reload whose coordinator brain check runs out of time answers HTTP 503 instead of 504, so the UI receives the `ValidationTimeoutError` refusal through Cloudflare Tunnel, which replaces an origin 504 with its own error page.
