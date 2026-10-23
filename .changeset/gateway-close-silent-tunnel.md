---
"@usine/gateway": patch
---

Fixes `systemctl stop usine-gateway` waiting for the stop timeout: the forward proxy no longer waits for a tunnel without a ClientHello, and an interrupted tunnel destroys its client socket.
