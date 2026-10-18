---
"@usine/engine": patch
---

An Event whose Run was canceled, superseded, or revoked opens a new Run when the Loop sees the Item leave that state and come back to it, for example after a label is removed and added again. A queued Event that a revoke ignored opens the same way. While the Item stays as it was, a later sighting still joins the canceled Run. The new Run's Event has the dedup key `["reopened", n, <original key>]`, so existing Run ids do not change. The engine records what each Loop last saw of an Item in the new `usine_loop_items` table.
