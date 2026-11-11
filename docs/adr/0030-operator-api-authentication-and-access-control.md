# Operator API authentication: GitHub sign-in, instance tokens, and role bindings

Every operator API request is authenticated and authorized, on loopback too, because a reverse proxy such as `tailscale serve` delivers every request from 127.0.0.1. Health, version, readiness, sign-in, the OpenAPI document, and the setup callback are public. GitHub webhook deliveries are checked by signature.

- **Sign-in.** Members sign in with GitHub through the instance's App ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)): the web flow in browsers, the device flow elsewhere. usine reads the identity, then asks GitHub to revoke the user token. Membership follows the numeric user ID, not the login.
- **Instance credentials.** usine issues its own secrets and stores only their hashes. The bundled UI keeps a 30-day session in an `HttpOnly`, `SameSite=Strict` cookie and sends a CSRF header with each write. Other clients send a device token, valid until revoked, whose permission ceiling narrows the member's current bindings. The CLI on the instance's machine reads a mode-0600 admin token file that each start replaces.
- **Role bindings.** Access is denied unless a binding grants it: instance admin, or viewer, operator, or maintainer on one project. Bindings are configuration with revisions ([ADR 0031](./0031-authored-configuration-in-the-database.md)), so each grant records who made it. Lists show only what the member may read. The person who completes setup through the one-time link is the first admin; later members get no role until an admin grants one.
- **Transport.** The server listens only on 127.0.0.1, and a reverse proxy provides TLS. Only listed browser origins are accepted, each on HTTPS except on loopback. Sign-in endpoints are rate limited.

Decided, not built: device tokens gain an expiry and an operation ceiling, and MCP tools serve the API through the same checks (#879).

## Considered options

- **The network as the only boundary**: no identity, and no protection on a public address.
- **Instance tokens without sign-in**: an approval can't record who approved.
- **Any OIDC provider**: every instance would need one, while every member has a GitHub login.
- **Instance-wide roles only**: a contractor on one project would see every project.
- **GitHub repository permissions as the only source of bindings**: no way to grant less than GitHub does.
- **Built-in ACME**: usine would bind ports 80 and 443 and handle keys and renewals.
