---
title: Add a Boat worker
description: Create Boat sandboxes for SSH attempts.
---

Add an SSH worker that creates Boat sandboxes for attempts.

## Prerequisites

Instance admin access, an instance using SSH workers, a Boat account and CLI, an SSH key pair, and API keys for the rostered harnesses. Use [a gateway](/guides/connect-boat-to-a-gateway/) for subscription credentials.

## Procedure

1. Create a Boat API key and store it as `BOAT_API_KEY` in the instance’s private `.env`:

   ```sh
   boat api-key create usine-boat --ttl 365d
   ```

   Store the printed key securely. The key needs sandbox creation, listing, deletion, and SSH-key operations. Create the SSH key pair if needed:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/usine_boat -C usine-boat
   ```

2. Store the provider keys as variables such as `USINE_ANTHROPIC_API_KEY` and `USINE_OPENAI_API_KEY` in `.env`. Restart usine to read them.
3. Open **Configuration > Workers > New**. Choose `ssh`, root `/home/user/.usine`, identity file `~/.ssh/usine_boat`, and desired concurrency. Leave fixed destination and port unset.
4. Select provisioner `boat`, token variable `BOAT_API_KEY`, and an account-supported size such as `default`. Set the Anthropic or OpenAI API-key variable names needed by your roster. Save.

## Check the result

Preflight validates the token and account limits without creating a sandbox. A test run creates a sandbox, adds the public key, verifies its pinned SSH host key, and starts an attempt container. **Workers** shows the machine until cleanup retires it.

Boat offers no region setting. Each sandbox has no account secrets, automatic snapshots, command monitoring, or automatic stop. Without a gateway, the attempt can read its token and provider keys. [Boat settings](/reference/configuration/workers/#boat-provisioner) describes snapshots and reuse.

## SSH recovery

A running Codex child survives an SSH disconnect. usine reconnects to the same app-server, reads buffered output, and continues the existing thread. If the app-server exits, usine resumes its saved thread once before reporting a failure.

A confirmed machine loss ends the attempt as an infrastructure failure. usine retries automatically, up to the run's attempt cap, using the latest pushed salvage recorded on the run. Work that exists only on a deleted machine cannot be recovered. A child transport failure remains an infrastructure failure even if the parent reports an operator blocker.
