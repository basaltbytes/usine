---
"@usine/durable": patch
---

Persist outbound envelopes before delivery so a restart preserves child events and intervention results with their original sequences and timestamps. Replay pending batches before new output, and keep terminal envelopes recoverable until delivery completes.
