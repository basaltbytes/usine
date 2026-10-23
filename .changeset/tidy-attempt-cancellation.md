---
"@usine/executor": patch
---

Repeated cancellation keeps an attempt's typed failure, and concurrent cancels wait for checkout and credential cleanup. After a run ends, operator input is rejected.
