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

## Image preparation

The run page shows **Preparing the attempt image** during machine preflight and first-use cache preparation. The server logs whether the image is `present` or `absent`, the inspection duration, and the preflight pull duration. The pull's `downloaded` field compares the image IDs before and after the pull. The image user probe has its own duration. Each **Prepared shared cache volume** entry includes the complete script duration in milliseconds. When the host reports a readable container run duration, the entry also includes `runDurationMillis`. Otherwise, preparation succeeds without that field, and a debug log records the raw timing output.

If a new machine lacks the attempt image, the server logs a warning with the image name before pulling it. Rebuild the snapshot with that image and update the worker's snapshot setting. Rebuild snapshots after an upgrade that changes the attempt image. A present image with a slow first container run can indicate slow reads from the restored disk; use the separate timings to identify the slow step.
