---
"@usine/durable": patch
---

Fixes `AttemptRuntime.notify` dropping a worker notice sent before the attempt's relay or parent starts; it records the notice after `Started`.
