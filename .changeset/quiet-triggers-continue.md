---
"@usine/orchestrator": patch
---

Limit queued Event trigger re-checks to five seconds so a stalled GitHub read cannot indefinitely block the Item's next Run or an operator retry. Timed-out checks log a warning and let the queued Event proceed.
