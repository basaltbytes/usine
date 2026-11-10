---
"@usine/gateway": patch
---

`usine-gateway` accepts `0` in `USINE_GATEWAY_PROXY_PORT`, `USINE_GATEWAY_EGRESS_PORT`, and `USINE_GATEWAY_ADMIN_PORT`, as the reference documents. The operating system assigns an available port, and each listener logs the port it bound.
