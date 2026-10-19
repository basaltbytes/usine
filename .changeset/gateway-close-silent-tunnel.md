---
"@usine/gateway": patch
---

Closing the forward proxy no longer waits for a tunnel whose client has not sent its ClientHello yet. An interrupted tunnel now destroys its client socket, so `systemctl stop usine-gateway` returns at once instead of waiting for the unit's stop timeout.
