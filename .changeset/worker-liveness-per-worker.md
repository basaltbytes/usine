---
"@usine/executor": patch
---

The SSH and exe.dev executors probe each worker once a minute while any attempt runs on it, instead of once a minute per attempt. The notices go to the transcript of every attempt on the worker.
