---
title: Sign in to an instance
description: Configure GitHub sign-in, enroll members, and manage instance tokens.
---

Operator API requests require an instance token or a browser session, including requests from loopback. Health and sign-in endpoints are public. Role bindings determine which projects a member can read and which actions they can take.

`GET /api/version` is an upgrade health endpoint that returns only the running release string. It remains public so helpers copied by releases before member authentication can verify the new server during a managed upgrade. Upgrade status and upgrade requests require instance admin access.

When `usine up` writes to a terminal, open the printed **Sign in** URL. The link expires after 10 minutes and works once. For a detached instance, a system service, or a new link, run `usine sign-in-link` in the instance folder. This also works before GitHub user authorization is configured. Keep these URLs private.

`usine up` writes `.usine/admin-token` with mode `0600` and replaces it on each start. Local status and lifecycle commands require this file to be owned by the current user, have mode `0600`, and be a regular file rather than a symbolic link. An unreadable or unsafe file fails the command before stop or restart sends a signal. Configuration commands access the local database directly; access to the instance folder is required.

### GitHub App settings

For an existing App, open **GitHub > Settings > Developer settings > GitHub Apps > your App**:

1. Under user authorization, enable **Device Flow**.
2. Set the callback URL to `<instance-origin>/api/auth/callback`, for example `https://usine.example.com/api/auth/callback`.
3. Copy the App's client ID and generate a client secret. Add `USINE_GITHUB_CLIENT_ID` and `USINE_GITHUB_CLIENT_SECRET` to the instance's `.env` file. These differ from the App ID and private key.
4. Set `USINE_ORIGIN` to the same instance origin, then restart `usine up`.

Use HTTPS for remote access through a reverse proxy. See [Expose an instance over HTTPS](/guides/expose-an-instance/) for public access prerequisites, Caddy and Cloudflare Tunnel examples, and browser origins. With Tailscale, publish the loopback listener with `tailscale serve --bg http://127.0.0.1:7331` and set `USINE_ORIGIN` to the HTTPS address it prints. `usine up` continues to bind only `127.0.0.1`.

On upgrade, the configured `operator` becomes the first member after the instance resolves that login to a GitHub user ID. If GitHub is unavailable, the instance logs a warning and retries enrollment on the next start; the local sign-in link remains available. On a new instance, open the one-time link after configuring the App's user authorization and complete GitHub sign-in to become the first member. A public sign-in cannot enroll the first member.

Add members by GitHub login on **Members**. Removing the last member or last member with an admin binding is refused. Removing a member revokes their tokens and deletes their bindings atomically. GitHub identity checks use the numeric user ID; a different GitHub account cannot sign in by reusing a member's former login.

### Device tokens

Run `usine sign-in <instance-origin>`, open the GitHub device page, and enter the printed code. After authorization, the CLI prints an instance token once. Store it in a secret manager and send it as `Authorization: Bearer <token>`. The instance stores only its hash. After reading identity, usine requests revocation of the GitHub user token and wipes its local copy. A failed revocation logs a warning and preserves the sign-in result.

**Tokens** lists the signed-in member's browsers and devices, creation times, and last use, updated at most once a minute per token. Listing tokens deletes expired credentials and excludes them from the response. Revoke an entry to end access. Device tokens remain valid until revoked; browser sessions expire after 30 days. **Sign out** revokes the current browser session.

Browser sessions use an `HttpOnly`, `SameSite=Strict` cookie, with `Secure` except for local HTTP origins. Browser writes require `X-Usine-CSRF`. The bundled UI reads its CSRF cookie and sends that header. Health and sign-in endpoints are public; the separate GitHub webhook listener verifies delivery signatures. Sign-in initiation, link issuance, GitHub exchanges, and invalid challenges have separate instance-wide limits of 60 requests per operation per minute. Invalid challenges do not consume the limits for valid sign-ins. Device polls also honor GitHub's interval.


### Roles and bindings

An instance admin manages members, bindings, workers, repository membership, settings, and upgrades. Project roles are cumulative:

| Role | Project access |
| --- | --- |
| viewer | Read tasks, runs, transcripts, loops, and lanes. |
| operator | Viewer access, plus approve, retry, cancel, message, pause loops, reset cycle budgets, and move cards. |
| maintainer | Operator access, plus edit loops and project lanes. |

The first member receives instance admin access. The upgrade migration grants every existing member an instance admin binding once. Members added afterward have no access until an admin grants a binding.

Open **Configuration > Role bindings** to create or edit a binding. Use the numeric GitHub ID shown on **Members**. For example:

```yaml
name: alice-alpha
member: 12345
role: maintainer
scope:
  _tag: Project
  project: alpha
```

An admin binding uses `role: admin` and `scope: {_tag: Instance}`. Project roles require a project scope. Binding names are unique; projects must exist. Bindings identify GitHub accounts by numeric ID and can be prepared before enrollment. They grant nothing until the account is enrolled.

Bindings are configuration entities with revision history. Local commands support `usine config edit binding alice-alpha`, import, export, and revert. If an edit removes all admin bindings, use the instance machine's configuration CLI to restore access.

Lists omit projects without read access, including their runs and attention items. Worker status and instance attention controls require admin access. Shared agent definitions and non-secret runtime settings remain readable to members with project read access.

### Token scopes and local access

Browser sessions follow the member's current role bindings on every request. Adding, changing, or removing a binding takes effect without signing in again, including for sessions created before this behavior changed. Browser sessions have no scope ceiling to edit.

**Tokens** shows each device token's permission ceiling. Create a token with selected permissions or edit an existing device token's scopes. The secret is shown once. The server refuses scopes wider than the caller's effective permissions. Every device token request intersects its ceiling with current bindings, so removing a binding takes effect on the next request. Adding a role does not expand a device token; use a browser session to edit its scopes or sign in on the device again.

Device sign-in snapshots the member's current permissions. Device tokens issued before role bindings retain a full-member ceiling for compatibility, still limited by current bindings. Read, operate, and maintain scopes are independent: include read when a client needs to fetch data before acting. Non-admin device tokens cannot manage other tokens; use a browser session.

The local admin token represents the built-in local actor, displayed as **local admin**. It has instance admin access and no member identity. Local API writes and configuration CLI revisions record **local admin**, even when no member is enrolled. The actor cannot sign in through GitHub or own member tokens. A one-time sign-in link still opens a member browser session when members exist.
