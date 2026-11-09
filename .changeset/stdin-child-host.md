---
"@usine/agents": minor
---

Add a redacted stdin environment to `RemoteShell`. The remote shell consumes the environment block before command input and child protocols, keeping values out of command arguments and files.
