---
title: Open the web UI
description: Open a local instance or forward its port over SSH.
---

Connect a browser to a running instance and open a project board.

## Prerequisites

A running instance and an enrolled member with project access, or access to the instance machine for a one-time sign-in link.

## Procedure

1. For a local instance, open `http://127.0.0.1:7331`, using its configured port if different. For an SSH-only remote instance, forward its loopback listener:

   ```sh
   ssh -N -L 7331:127.0.0.1:7331 orchestrator.example.com
   ```

2. Sign in with GitHub, or run `usine sign-in-link` in the instance folder and open the printed private link. The link expires after ten minutes and works once.
3. Select a project in the sidebar, then **Board** or **Tasks**.

## Check the result

The UI lists only projects you can read. A project board combines its repositories and links to task and run pages. If no project appears, ask an instance admin to check your role bindings.

For a shared address, [expose the instance over HTTPS](/guides/expose-an-instance/). Authentication is required on loopback as well as through a proxy.
