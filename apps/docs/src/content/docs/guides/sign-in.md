---
title: Sign in to an instance
description: Configure GitHub sign-in, enroll members, and manage instance tokens.
---

Every operator API request requires an instance token or a browser session, including requests from loopback. Every member has instance admin access.

Start `usine up` and open the printed **Sign in** URL. The link expires after 10 minutes and works once. To print another link, run `usine sign-in-link` in the instance folder. This also works before GitHub user authorization is configured. Keep these URLs private.

`usine up` writes `.usine/admin-token` with mode `0600` and replaces it on each start. Local status and lifecycle commands read this file. Configuration commands access the local database directly; access to the instance folder is required.

### GitHub App settings

For an existing App, open **GitHub > Settings > Developer settings > GitHub Apps > your App**:

1. Under user authorization, enable **Device Flow**.
2. Set the callback URL to `<instance-origin>/api/auth/callback`, for example `https://usine.example.com/api/auth/callback`.
3. Copy the App's client ID and generate a client secret. Add `USINE_GITHUB_CLIENT_ID` and `USINE_GITHUB_CLIENT_SECRET` to the instance's `.env` file. These differ from the App ID and private key.
4. Set `USINE_ORIGIN` to the same instance origin, then restart `usine up`.

Use HTTPS for remote access through a reverse proxy. With Tailscale, publish the loopback listener with `tailscale serve --bg http://127.0.0.1:7331` and set `USINE_ORIGIN` to the HTTPS address it prints. `usine up` continues to bind only `127.0.0.1`.

On upgrade, the configured `operator` becomes the first member after the instance resolves that login to a GitHub user ID. On a new instance, open the one-time link after configuring the App's user authorization and complete GitHub sign-in to become the first member. A public sign-in cannot enroll the first member.

Add members by GitHub login on **Members**. The last member cannot be removed. Removing a member revokes that member's tokens. GitHub identity checks use the numeric user ID; a different GitHub account cannot sign in by reusing a member's former login.

### Device tokens

Run `usine sign-in <instance-origin>`, open the GitHub device page, and enter the printed code. After authorization, the CLI prints an instance token once. Store it in a secret manager and send it as `Authorization: Bearer <token>`. The instance stores only its hash. GitHub user tokens are discarded after reading identity.

**Tokens** lists the signed-in member's browsers and devices, creation times, and last use. Revoke an entry to end access. Device tokens remain valid until revoked; browser sessions expire after 30 days. **Sign out** revokes the current browser session.

Browser sessions use an `HttpOnly`, `SameSite=Strict` cookie, with `Secure` except for local HTTP origins. Browser writes require `X-Usine-CSRF`. The bundled UI reads its CSRF cookie and sends that header. Health and sign-in endpoints are public; the separate GitHub webhook listener verifies delivery signatures. Sign-in operations have an instance-wide limit of 60 requests per operation per minute and device polls also honor GitHub's interval.
