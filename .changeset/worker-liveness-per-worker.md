---
"@usine/executor": patch
---

The SSH and exe.dev executors probe each Worker's machine once a minute while any Attempt runs on it, instead of once a minute per Attempt, so a Worker with two slots gets one SSH connection a minute instead of two. The `WorkerUnresponsive` and `WorkerResponsive` notices go to the transcript of every Attempt on the Worker, and the probe stops when the last of them ends.
