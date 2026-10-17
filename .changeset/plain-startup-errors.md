---
"@usine/server": patch
"@usine/orchestrator": patch
---

Every expected failure of a `usine` command prints one plain message instead of an Effect cause: an invalid `usine.yaml` names the file, stage, and key, and a failed Worker Preflight names the Worker, the check, and its cause. Defects still crash with their full trace. A Worker preflight that fails on an operation, such as a timed-out harness probe, now names the Worker in its message.
