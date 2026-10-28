---
"@usine/gateway": patch
---

Persist encrypted gateway attachments in the state directory so running attempts retain their caller tokens across restarts. Restore unexpired credentials before listening, return typed errors for failed writes, and close HTTP sockets and CONNECT tunnels promptly on SIGTERM.
