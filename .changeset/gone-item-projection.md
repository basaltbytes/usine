---
"@usine/engine": patch
"@usine/orchestrator": patch
---

An open pull request that GitHub no longer has leaves the board's open lanes. The poll calls the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the item's projection until a later poll sees the item again, and the board places a gone item by its closed state; a migration adds `gone_at` to `usine_item_projections`.
