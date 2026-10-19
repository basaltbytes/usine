---
"@usine/gateway": patch
---

`usine-gateway` exits with status 0 when SIGTERM or SIGINT stops it, once its servers are closed, so systemd records a stop or restart as a success instead of a failure with status 130. A failure still exits non-zero.
