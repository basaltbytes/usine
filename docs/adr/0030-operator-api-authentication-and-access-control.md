# Operator API authentication: GitHub sign-in, instance tokens, and role bindings

Until 2026-10-28 the operator API and the web UI had no authentication. `usine up` listens on loopback and refuses browser requests whose `Origin` isn't a loopback name or `USINE_ORIGIN`, so the network (loopback, an SSH tunnel, or a tailnet) was the only boundary, and the operator that approvals and interventions record was the `operator:` value of `usine.yaml`. That stops working when clients other than the bundled UI use the API, such as a UI served from another origin, the CLI against a remote instance, or an iOS app, and when several people share one instance. Decided on 2026-10-28 ([#632](https://github.com/basaltbytes/usine/issues/632)): every API request is authenticated and authorized by role.

- **Sign-in.** A member signs in with their GitHub login through the instance's GitHub App ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)): the web flow for browsers, the device flow for the CLI and native apps. The GitHub user token proves the login at sign-in; usine doesn't use it as the API credential.
- **Instance tokens.** The instance then issues its own token for each device or automation, stores it hashed, and lists it so that it can be revoked. Every client sends it as a bearer token in the `Authorization` header. A token has scopes that can only narrow its member's permissions: a phone's token can be read-only, and an automation's token can be limited to one project.
- **Role bindings.** Access is denied unless a role binding grants it. A binding is a member, a role, and a scope, where the scope is the instance or one project. An instance admin manages members, role bindings, workers, settings, and tokens. On a project, viewer reads its tasks, runs, loops, and lanes; operator also acts on its runs and tasks, such as approving, retrying, canceling, messaging, and moving cards; maintainer also edits its loops and lanes. A member with no binding on a project doesn't see it.
- **Enforcement.** The server checks the permission on every route and filters every list (projects, tasks, runs, needs-you) to what the member may see. The UI hides the actions that the member can't take.
- **Audit.** Role bindings are configuration, stored in the database with a revision for each change ([ADR 0031](./0031-authored-configuration-in-the-database.md)), so every access change records who granted it. Approvals, interventions, retries, cancellations, and configuration revisions record the member's GitHub login.
- **Transport.** TLS is required when the API isn't on loopback. Web origins that the instance allows get CORS headers.
- **Public exposure.** An instance can serve the API over public HTTPS, so this applies from the start: rate limits on the sign-in and token endpoints, security headers, and no route without a token except health, sign-in, and the signature-verified GitHub webhook endpoint ([ADR 0014](./0014-webhook-delivery-as-hints.md)).
- **API contract.** The API has a versioned path and a published schema, so a client built against one version keeps working against a newer server.

These choices are open in #632:

1. The source of role bindings: bindings managed in usine only, bindings derived from GitHub permissions on the project's repositories (read to viewer, write to operator, admin to maintainer), or both.
2. Whether `usine up` on loopback still accepts requests without sign-in.
3. TLS built into `usine up` (ACME), or a documented reverse proxy such as Caddy, `tailscale serve`, or Cloudflare Tunnel.
4. The bundled UI's session: a bearer token in memory with a refresh flow, or an `HttpOnly` cookie with CSRF protection.

## Considered options

- **The network as the only boundary** (until 2026-10-28): enough for one operator behind a tailnet, but it has no identity, no per-device revocation, and no protection once the address is public.
- **Instance-issued tokens only** (`usine token create`, pasted or scanned into a client): no identity provider, but no single sign-in, and no person behind a token, so an approval can't record who approved.
- **Any OIDC provider**: works with Google, Okta, or Authentik, but every instance needs a provider configured, while every member already has a GitHub login for the managed repositories. Since the API credential is usine's own token, another sign-in method can be added later.
- **Tailscale identity headers** (`tailscale serve` passes the caller's Tailscale login): no sign-in code, but only clients on the tailnet can connect, and the identity is a Tailscale login, not a GitHub one.
- **Instance-wide roles only**: simpler bindings, but a contractor on one project would see every project.
- **An access entry on each loop, run, and worker**: finer control, but many entries to manage and no current need. A binding's scope can gain a resource level later.
- **GitHub repository permissions as the only source of bindings**: no membership to manage in usine, but no way to grant less than GitHub does or to scope a token. Whether bindings are derived from them is open question 1.

## Consequences

- The GitHub App needs user authorization: the device flow turned on, and a callback URL at the instance's address for the web flow. An instance created before this change needs those App settings changed by hand.
- `operator:` in `usine.yaml` identifies only the approvals and interventions recorded before sign-in exists.
- Every client signs in, including the bundled UI. Scripts that call the API with `curl` need a token.
- The API on a public address is an attack surface that the network used to hide. A deployment guide states what an instance needs before it's public: TLS, the allowed origins, and the rate limits.
