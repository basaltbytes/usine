---
"@usine/gateway": minor
"@usine/executor": minor
"@usine/config": patch
---

The Gateway relays TLS from clients that ignore proxy variables (ADR 0027, amendment of 2026-10-15).

`@usine/gateway/node`: a fourth server, the transparent listener (`USINE_GATEWAY_TRANSPARENT_HOST` and `_PORT`, default `127.0.0.1:443`). It reads each connection's TLS ClientHello, requires a server name the egress allowlist permits on port 443 that resolves to a public address, connects to that host on port 443, and copies bytes both ways, through the same relay as the forward proxy's CONNECT tunnels. A missing or disallowed name ends with a TLS `unrecognized_name` alert and bytes that are not TLS are closed, each logged as `Gateway refused a request` with `via: "transparent"`. Both ways in now log `via` and a `Closed an egress tunnel` line with the side that closed first and the bytes sent and received. `GatewayListeners` and `GatewayAddresses` have a `transparent` member, and `TransparentListenError` is exported.

`@usine/gateway`: the reverse proxy refuses a plain HTTP request for an allowlisted host with the new reason `plain-http-egress` (403) instead of `unknown-host`.

New command `usine-gateway-dnsmasq`: prints the dnsmasq lines that answer each name the allowlist permits on port 443 with the transparent listener's address, from the same allowlist file.

`@usine/executor/ssh`: the login host check behind a Gateway also requests each host with `curl --noproxy '*'`, through the transparent listener, and fails preflight with a `gateway` capability error that says why when it gets no answer.

`@usine/config/factory`: `WorkerGateway` documents the transparent listener.
