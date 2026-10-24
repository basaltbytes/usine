---
"@usine/engine": patch
---

An event whose run was canceled, superseded, or revoked, or a queued event that a revoke ignored, opens a new run when the item leaves that state and comes back to it, for example when a label is removed and added again. The new run's event has the dedup key `["reopened", n, <original key>]`, and the engine records each loop's last sighting of an item in the new `usine_loop_items` table.
