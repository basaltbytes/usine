---
title: Create a device token
description: Authorize a CLI or API client and limit its access.
---

Create an instance bearer token for a command-line or external API client.

## Prerequisites

An enrolled GitHub identity with the required role bindings, GitHub Device Flow enabled on the App, and HTTPS access for a remote instance.

## Procedure

1. Run:

   ```sh
   usine sign-in https://usine.example.com
   ```

2. Open the printed GitHub device page, enter the code, and authorize the App. The CLI prints the instance token once; store it in a secret manager.
3. Send the token as `Authorization: Bearer <token>` to protected API routes. Use **Tokens** in a browser session to inspect or narrow the device token’s permission ceiling.

## Check the result

An authenticated `GET /api/auth/session` returns the token’s effective permissions. Requests require both its permission ceiling and the member’s current bindings. Revoke the device entry under **Tokens** to end access.

Device tokens remain valid until revoked. Adding a role does not expand an existing device ceiling; use a browser session to edit scopes or sign in on the device again. [Operator API](/reference/operator-api/) documents token issuance and scope updates.
