---
title: Sign in to an instance
description: Open a browser session with a one-time link or GitHub.
---

Open an authenticated browser session for an instance.

## Prerequisites

A running instance and either an enrolled GitHub identity or local access to the instance machine. For an existing GitHub App, an admin must enable Device Flow and set its callback to `<instance-origin>/api/auth/callback`, with client ID and secret in the instance environment.

## Procedure

1. Open the instance’s canonical address. For local access, use `http://127.0.0.1:7331` with the configured port.
2. Select **Sign in with GitHub** and authorize the App. For first-member enrollment or local recovery, run this command in the instance folder and open its printed private URL instead:

   ```sh
   usine sign-in-link
   ```

   The one-time link works for ten minutes. First-member enrollment requires the local link or setup flow; public GitHub sign-in cannot enroll the first member.

3. Complete GitHub identity verification when prompted and open the instance.

## Check the result

The browser shows the projects and actions permitted by your current role bindings. The first member receives instance admin access. **Sign out** revokes the browser session.

Browser sessions expire after 30 days and use an HttpOnly, SameSite=Strict cookie, with Secure on HTTPS. The bundled UI adds the required CSRF header on writes. [Manage members](/guides/manage-members/) to grant project access, or [create a device token](/guides/create-a-device-token/) for API use.
