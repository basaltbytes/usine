---
"@usine/durable": patch
"@usine/server": patch
---

Use the replacement child's report after an orchestrator restart instead of failing the attempt with the previous child's stored infrastructure failure. Preserve the previous failure in the transcript.
