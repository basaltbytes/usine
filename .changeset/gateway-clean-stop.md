---
"@usine/gateway": patch
---

`usine-gateway` exits with status 0 after SIGTERM or SIGINT once its servers close, so systemd records a stop or restart as a success. A failure still exits non-zero.
