---
title: Expose an instance over HTTPS
description: Publish a signed-in instance behind Caddy, Cloudflare Tunnel, or Tailscale.
---

Publish the loopback listener through HTTPS at a canonical instance address.

## Prerequisites

A running instance, completed first-member enrollment, instance admin access, a domain or tailnet HTTPS name, and control of the reverse proxy. Anonymous `GET /api/auth/session` must return 401 before sharing access.

## Procedure

1. Set `USINE_ORIGIN=https://usine.example.com` in the instance’s private `.env`, using the actual public address. Set the App callback to that origin plus `/api/auth/callback`, then run `usine stop`. Start it again with `usine up --detach` or its systemd service so it reads the new origin. Keep its listener on `127.0.0.1`.
2. Configure one proxy on the listener’s machine. For Caddy, point DNS to the host, allow ports 80 and 443, and use:

   ```text
   usine.example.com {
       reverse_proxy 127.0.0.1:7331
   }
   ```

   For Cloudflare Tunnel, route the hostname to `http://127.0.0.1:7331` and enable HTTPS redirection. For tailnet access, run `tailscale serve --bg http://127.0.0.1:7331` and use its printed HTTPS origin.

3. Forward `Host`, `Origin`, `Authorization`, `Cookie`, `Content-Type`, `X-Usine-CSRF`, and CORS preflight headers unchanged. Permit `OPTIONS`; preserve `Set-Cookie`, `Vary`, `Cache-Control`, CORS, and security response headers. Disable API and sign-in redirect caching and script injection. Pass error responses from usine through unchanged: the UI reads the JSON body of a refusal, such as the HTTP 503 that a configuration save returns when its checks run out of time. Caddy, Cloudflare Tunnel, and `tailscale serve` pass that response through by default.
4. Let usine trust the proxy's `X-Forwarded-For` header, so that sign-in rate limits count each client address separately. Run `usine config edit settings instance`, add the proxy's loopback addresses, and restart:

   ```yaml
   auth:
     trusted_proxies: [127.0.0.1/32, ::1/128]
   ```

   Caddy, Cloudflare Tunnel, and `tailscale serve` add the client address to `X-Forwarded-For`. Without this setting, usine ignores the header, so every sign-in request through the proxy shares one allowance of 60 requests per minute per operation. See [trusted proxies](/reference/configuration/settings/#trusted-proxies).
5. If using endpoint webhook hints, expose `/webhooks/github` with the signature headers and unchanged body bytes. Configure its public URL and secret in [webhook settings](/reference/configuration/settings/#webhook-hints).

## Check the result

Check the deployed address without a browser session:

```sh
curl -I https://usine.example.com/
curl -i https://usine.example.com/api/auth/session
```

The first response includes security headers and HSTS; the second returns 401. Sign in through the public URL and confirm an allowed action works.

## Browser origins

The bundled UI uses the canonical origin. For another browser client, edit `auth.origins` with `usine config edit settings instance`, add its exact HTTPS origin, and restart. HTTP origins are allowed only on loopback, and development ports must be explicit. Wildcards and `null` are invalid.

An allowed origin receives its exact CORS origin and credential header; unknown origins return 403 without CORS headers. Requests without Origin still require authentication. A client on another site should use a device token because SameSite cookies do not provide cross-site sessions.

The server derives public-origin and HTTPS policy from `USINE_ORIGIN`, independently of forwarded headers. It reads `X-Forwarded-For` only to choose the client address for sign-in rate limits, and only from a peer in `auth.trusted_proxies`. Additional Cloudflare Access or tailnet restrictions control network access; usine authentication and role bindings still apply.
