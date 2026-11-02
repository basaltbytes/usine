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

A running Codex child survives an SSH disconnect. usine reconnects to the same app-server, reads buffered output, and continues the existing thread. If the disconnect interrupts an output frame, usine replays that frame from the last complete output offset. The relay discards incomplete input frames, and reconnection resends them to the running app-server. If the supervisor or app-server exits after the thread is saved, usine confirms that the remaining process group has stopped before resuming the thread once, including when the first turn request fails or the app-server exits unexpectedly with code 0. Recovery replays unread operator guidance in order and reports delivery after the recovered turn accepts it. Paused or idle children wait for operator guidance and include any unread messages when they resume. When Codex records that resumed input, usine reports its queued guidance as read so another pause does not resend it.

A confirmed machine loss ends the attempt as an infrastructure failure. usine retries automatically, up to the run's attempt cap, using the latest pushed salvage recorded on the run. Work that exists only on a deleted machine cannot be recovered. A child transport failure remains an infrastructure failure even if the parent reports an operator blocker.

## Image preparation

The run page shows **Preparing the attempt image** during machine preflight and first-use cache preparation. The server logs whether the image is `present` or `absent`, the inspection duration, and the preflight pull duration. The pull's `downloaded` field compares the image IDs before and after the pull. The image user probe has its own duration. Each **Prepared shared cache volume** entry includes the complete script duration in milliseconds. When the host reports a readable container run duration, the entry also includes `runDurationMillis`. Otherwise, preparation succeeds without that field, and a debug log records the raw timing output.

If a new machine lacks the attempt image, the server logs a warning with the image name before pulling it. Rebuild the snapshot with that image and update the worker's snapshot setting. Rebuild snapshots after an upgrade that changes the attempt image. A present image with a slow first container run can indicate slow reads from the restored disk; use the separate timings to identify the slow step.
