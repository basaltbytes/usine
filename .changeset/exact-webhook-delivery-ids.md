---
"@usine/github": minor
"@usine/orchestrator": patch
---

Preserve GitHub's 64-bit webhook delivery IDs when decoding summaries, filtering newer deliveries, and saving cursors. `WebhookDeliveryId` now accepts decimal strings instead of numbers; compare IDs with `BigInt`. Existing numeric cursors reset once and subsequent polls store exact strings.
