---
"@usine/agents": minor
---

Add a redacted stdin environment to RemoteShell for SSH servers that ignore SendEnv. Consume the environment block before command input and child protocols, keeping values out of command arguments and files.
