---
"@usine/server": patch
---

In setup mode, `usine up` answers every request from the moment it accepts connections. Before, a request that arrived after the port opened but before the routes were installed never got a response. Until startup finishes, `GET /api/version` returns the running release and other requests return HTTP 503 with `Retry-After: 1`, as in runtime mode.
