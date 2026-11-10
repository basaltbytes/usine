---
"@usine/executor": patch
---

When boxd refuses to create a machine as invalid (`INVALID_ARGUMENT`), for example because it reserves the machine name, worker preflight now fails with boxd's message, which names the machine. Before, usine reported the machine as unavailable and retried creation, which failed the same way.
