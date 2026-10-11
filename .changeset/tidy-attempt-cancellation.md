---
"@usine/executor": patch
---

Preserve an Attempt's typed failure when cancellation repeats during settlement. Concurrent cancellations wait for checkout and credential cleanup before returning. Once an Attempt's run has ended, operator input is rejected and a cancel only waits for that cleanup.
