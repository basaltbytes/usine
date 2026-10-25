---
"@usine/agents": patch
---

The Pi preflight session's `bash` tool now gets the worker's environment instead of inheriting the orchestrator's. Preflight never prompts, so no tool ran, but the session was built as if it might.
