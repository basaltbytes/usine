---
"@usine/config": minor
"@usine/server": minor
---

Sign-in rate limits count each client address separately. Each sign-in operation allows 60 requests per minute from one client address and 600 per minute for the whole instance. The client address is the address of the connection. When that address is in the new `auth.trusted_proxies` setting, such as `[127.0.0.1/32, ::1/128]` for a reverse proxy on the same machine, the server reads the client address from `X-Forwarded-For`. Without the setting, the server ignores the header.

On an instance behind a reverse proxy, the per-client limits take effect only after you list the proxy in `auth.trusted_proxies`. Until then, every client behind the proxy counts as the proxy's address and shares one allowance, so one client can still lock every member out of sign-in.
