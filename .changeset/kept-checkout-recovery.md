---
"@usine/executor": patch
---

Confirm parent stops before releasing reattached checkouts, including read-permission checkouts. Save each checkout's base commit so recovery removes clean checkouts without creating salvage branches, preserves committed work, and harvests comments with a fresh credential when a later stop succeeds.

Keep a Cloudflare sandbox when its reattachment closes before launch and the parent stop fails. Revoke its credentials while preserving the checkout for recovery.
