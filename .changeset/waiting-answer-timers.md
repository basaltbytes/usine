---
"@usine/agents": patch
"@usine/server": patch
---

A child's wait for its background work now ends only for the answer that started it. When a later answer replaces an answer that waits, such as an idle report under a Hold, the earlier wait's timers stop. Before, the earlier wait's grace period could return a later answer while its work still ran.

A held child that last reported idle now emits `SessionResumed` when an operator message starts its turn, even if a later answer that waits for background work replaced the idle report. The run page then shows the child working instead of waiting for input.

A turn end no longer drops an own input that the harness holds for its next turn. An operator message that repeats that input stays unread until the harness records it.

The run page shows the "No background work" note for a child's first loaded snapshot when the rows from the child's start aren't loaded, because the work that the snapshot ended can be on an earlier page.
