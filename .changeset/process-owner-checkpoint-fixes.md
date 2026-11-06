---
"@usine/core": patch
"@usine/agents": patch
---

Save a Claude child's zero usage for its replacement process before the replacement launches, so an orchestrator stop during that launch keeps the earlier process's tokens and cost in the session total. Wait for the worker to acknowledge pending input before the detach checkpoint, so an answered hook is not replayed after the restart. Save the assistant messages that the output checkpoint doesn't cover yet with the process usage, so a reattached process doesn't count their replay again.
