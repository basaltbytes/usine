---
"@usine/engine": patch
"@usine/orchestrator": patch
---

An open pull request that the poll drops because GitHub no longer has it now leaves the Board's open lanes. The poll records it with the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the Item's projection and keeps its last payload, and the Board places a gone Item by its closed state (`pr-closed` or `issue-closed`). A later poll that observes the Item again clears `goneAt`. A migration adds `gone_at` to `usine_item_projections`; no row is deleted.
