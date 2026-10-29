---
"@usine/orchestrator": minor
"@usine/server": minor
---

Support endpoint webhook delivery with HMAC-SHA256 verification and startup configuration of the GitHub App hook URL. Refresh registered repositories through existing hints, show the running mode and last hint in Settings, and warn after ten minutes without a verified delivery. Endpoint mode requires an active App webhook and `USINE_GITHUB_WEBHOOK_SECRET` in the instance environment.
