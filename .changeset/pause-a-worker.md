---
"@usine/config": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Workers accept `paused`. A paused worker takes no new attempts, and its running attempts finish; a run that reattaches an attempt already on the worker still takes a free slot there. The scheduler sends other runs to the next unpaused worker, so pausing the workers listed before a new worker sends attempts to it. Pausing or resuming applies on reload without a restart or a preflight. The worker page, the worker list, and the **Workers** line on **Overview** show a paused worker, and **Needs attention** lists it until it resumes. The worker form has a **Paused** option, and exports omit `paused: false`.
