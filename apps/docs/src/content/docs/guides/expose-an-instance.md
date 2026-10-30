---
title: Expose an instance over HTTPS
description: Publish the operator UI and API with Caddy, Cloudflare Tunnel, or Tailscale.
---

`usine up` listens on `127.0.0.1:7331`. Run the reverse proxy on the same machine and keep that listener off public interfaces. Set `USINE_ORIGIN=https://usine.example.com` in the instance environment before starting the server. This is the canonical address for sign-in links, the GitHub callback, secure cookies, and HSTS; it also belongs to the browser origin allowlist.

## Prerequisites

Before enabling public access:

- Configure HTTPS with a valid certificate and redirect public HTTP to HTTPS. Set the GitHub App callback to `https://usine.example.com/api/auth/callback` and configure [GitHub sign-in](/guides/sign-in/).
- Complete first-member enrollment through a local one-time sign-in link, then add the intended members. Every enrolled member has instance admin access. Verify that an anonymous request to `/api/auth/session` returns 401.
- Protect the instance folder and `.env`. The `.usine/admin-token` file must belong to the service user, have mode `0600`, and be a regular file. The server replaces it on each start; never publish it or copy it into a browser client.
- If you use `webhooks.mode: endpoint`, set `USINE_GITHUB_WEBHOOK_SECRET` to the GitHub App's webhook secret and set `webhooks.public_url` to `https://usine.example.com/webhooks/github`. Preserve the signed request bytes. Otherwise, use `off` or `deliveries` and leave the endpoint disabled.

Sign-in operations have separate instance-wide limits of 60 requests per minute. Health, sign-in, the OpenAPI schema, and the release-string upgrade health endpoint are public; the webhook endpoint verifies a signature. Other API routes require a session or bearer token.

## Browser origins

The bundled UI needs only the canonical origin. To permit an additional browser client, edit the instance settings with `usine config edit settings instance`, or use **Configuration > Settings > Edit as text**. Add this top-level block alongside `settings`:

```yaml
auth:
  origins:
    - https://client.example.com
```

Restart the server after changing `auth`. On first startup this block can be in `usine.yaml`; subsequent starts read stored configuration, so editing that file alone does not apply a change. Use `usine config import` for folder changes.

Origins must match exactly: scheme, host, and port, without a trailing slash, path, credentials, query, or fragment. Wildcards and `null` are invalid. HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]`; each development origin and port must be listed explicitly, for example `http://localhost:5173` for the Vite UI. Without `USINE_ORIGIN` or `--origin`, the canonical origin is `http://127.0.0.1:<port>`.

Allowed origins receive `Access-Control-Allow-Origin` with their exact value and `Access-Control-Allow-Credentials: true`. Preflight permits `GET`, `POST`, `PUT`, and `DELETE`, with `Authorization`, `Content-Type`, and `X-Usine-CSRF`. Unknown origins receive 403 before route handling and no CORS headers. Requests without `Origin`, such as CLI requests, still require authentication on protected routes.

A client on another site should use a [device token](/guides/sign-in/#device-tokens) in `Authorization: Bearer <token>`. Adding an origin does not relax the bundled UI's `SameSite=Strict` cookies or its CSRF requirement.

## Caddy

Point the instance DNS name at the server, allow Caddy to receive ports 80 and 443, and add this to the Caddyfile:

```text
usine.example.com {
    reverse_proxy 127.0.0.1:7331
}
```

Caddy obtains the certificate and redirects HTTP to HTTPS. Start usine with `USINE_ORIGIN=https://usine.example.com`, then reload Caddy. Caddy forwards the request headers listed below by default.

## Cloudflare Tunnel

Create a named tunnel and a DNS route for `usine.example.com`. On the instance machine, configure `cloudflared` with the tunnel credentials:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: usine.example.com
    service: http://127.0.0.1:7331
  - service: http_status:404
```

Start usine with `USINE_ORIGIN=https://usine.example.com` and run the tunnel as a service. Enable **Always Use HTTPS** for the hostname in Cloudflare. Disable caching for the instance hostname, and preserve the application's response headers. If you add Cloudflare Access, configure its policies so the intended clients and signed GitHub webhook deliveries can reach their routes; usine authentication remains required.

## Tailscale Serve

For access restricted to a tailnet:

```sh
tailscale serve --bg http://127.0.0.1:7331
```

Set `USINE_ORIGIN` to the HTTPS address printed by the command and restart usine. The [server deployment guide](/guides/run-the-orchestrator-on-a-server/) includes the system service and tailnet access configuration. Sign-in is required even when the proxy connects from loopback.

## Proxy headers and caching

Forward `Host`, `Origin`, `Authorization`, `Cookie`, `Content-Type`, `X-Usine-CSRF`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers` unchanged. Permit `OPTIONS` requests. For webhooks, also forward `X-Hub-Signature-256`, `X-GitHub-Event`, and `X-GitHub-Delivery`, and preserve the body bytes. Do not cache API responses or sign-in redirects.

Preserve `Set-Cookie`, `Vary`, `Cache-Control`, all `Access-Control-*` response headers, and the security headers. The proxy can set `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto` for its own logging, but usine derives its public origin and HTTPS policy from `USINE_ORIGIN`, not caller-supplied forwarding headers.

Every response, including assets and errors, includes Content Security Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a Permissions Policy disabling camera, microphone, and geolocation, and `X-Frame-Options: DENY`. An HTTPS canonical origin also enables `Strict-Transport-Security: max-age=31536000`. The CSP permits bundled scripts, bundled and data-URL fonts, inline styles used by UI components, and HTTPS images used by avatars and Markdown. It blocks inline scripts, framing, and plugins. Avoid proxy features that inject scripts into the UI.

Verify the deployed address before sharing it:

```sh
curl -I https://usine.example.com/
curl -i https://usine.example.com/api/auth/session
curl -i -X OPTIONS https://usine.example.com/api/auth/session \
  -H 'Origin: https://client.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: Authorization'
```

The first response includes the security headers; the second returns 401 without credentials. The preflight returns 204 only when the client origin is allowed. Repeat it with an unknown origin to verify a 403 response without CORS headers.
