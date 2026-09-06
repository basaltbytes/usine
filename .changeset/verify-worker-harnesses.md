---
"@usine/agents": minor
"@usine/core": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/run-host": minor
---

Verify rostered harness executables and login state on local and exe.dev Workers before scheduling and preparation. Require codex-cli 0.144.0 and verify ChatGPT authentication before starting Codex turns. Capability gaps require operator action; incomplete checks and transport failures retain infrastructure retries.

Executor preflight and orchestrator engine layers now accept the roster’s brain specs. The run host provides a credential-free harness readiness command, replacing exe.dev’s manually configured login checks. Claude’s Agent SDK uses the Worker’s preflight-checked `claude` executable.
