---
title: Add a boxd worker
description: Restore boxd machines from prepared snapshots for SSH attempts.
---

Add an SSH worker that restores a boxd machine for each attempt.

## Prerequisites

Instance admin access, a boxd account with a payment method and available machine slots, the boxd CLI, and an SSH key pair. The snapshot and machines must be in the same region. `fra` is Frankfurt; `nyc` is New York.

Use a gateway for subscription credentials. Without a gateway, configure API keys for the rostered harnesses.

## Procedure

1. Sign in with `boxd auth login`. Create a member API key:

   ```sh
   boxd auth keys create usine --kind member
   ```

   Store the key as `BOXD_API_KEY` in the instance's private `.env`. Restart usine to read new variables. API keys cannot link SSH keys to an account. The snapshot builder uses the CLI's linked device key for setup and writes the worker public key into `/home/boxd/.ssh/authorized_keys`; each restored machine accepts that key without another account link.

2. Create the worker key if needed:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
   ```

3. From the usine source checkout, build a snapshot in the intended region using the CLI's regional configuration:

   ```sh
   infra/boxd/build-snapshot.sh --size 2x8 usine-attempt ~/.ssh/usine_worker
   ```

   The script creates a temporary Ubuntu machine at the requested size, writes the worker key, prepares Docker, pulls the release's attempt image, installs Tailscale, and saves the snapshot. It deletes the temporary machine and prints the snapshot name. Set `USINE_CONTAINER_RUNTIME=podman` to install Podman instead. Set `ATTEMPT_IMAGE` to bake a custom attempt image.

4. Open **Configuration > Workers > New**. Choose `ssh`, root `/home/boxd/.usine`, identity file `~/.ssh/usine_worker`, and the desired concurrency. Select provisioner `boxd`, token variable `BOXD_API_KEY`, region `fra`, size `2x8`, and snapshot `usine-attempt`. Leave **Isolated** checked to exclude the in-machine boxd CLI, integrations, agent logins, and default private network.

5. For subscription credentials, select gateway `usine-gateway` and enable the provisioner's tailnet settings. Enter the gateway's Tailscale address and OAuth client variable names. The client needs `auth_keys` write access for `tag:usine-attempt`. The [Boat gateway guide](/guides/connect-boat-to-a-gateway/) describes the shared tailnet policy and gateway setup. Each machine joins with an ephemeral single-use key and leaves during cleanup. Package downloads use the machine's direct internet connection.

   Without a gateway, set the Anthropic or OpenAI API-key variable names needed by the roster. Save the worker.

## Check the result

Worker preflight validates the API key, snapshot readiness, captured size, region, and available machine slots without creating a machine.

boxd serves SSH through its proxy, so the worker's variables can't reach the machine with `SendEnv`. For workers with a gateway, the machine check reports the variables as not accepted. Workers using API keys without a gateway get no preflight error for the missing variables. Attempts fail in either configuration because the required variables don't arrive.

`size` asserts the snapshot's captured size: a mismatch requires rebuilding the snapshot at that size or changing the setting. Restores retain the captured CPU and memory.

After the variable transport issue is resolved, start a test run. usine disables auto-hibernate and auto-suspend, pins the SSH proxy host key reported by boxd, and connects as `boxd` at the machine's public IP and assigned port. **Workers** shows the machine until cleanup retires it. [boxd settings](/reference/configuration/workers/#boxd-provisioner) lists all options, including reuse.

Token exchanges and gRPC calls time out after 30 seconds. A stalled token exchange reports an unreachable provider and allows waiting calls to retry authentication.

## SSH recovery

usine refreshes the machine's SSH endpoint during recovery because its proxy port can change. A deleted, stopped, failed, or destroyed machine ends the attempt as an infrastructure failure. For suspended, hibernated, migrating, or pending machines, usine reports a provider error and keeps the last endpoint for recovery. Unpushed work on a lost machine cannot be recovered; retries use the latest pushed salvage.

## Image preparation

boxd snapshots retain the pulled attempt image. Rebuild the snapshot after upgrading usine to a release with a different attempt image, or when changing a custom image. Preflight logs an absent image at warning level and downloads it before running attempts. Shared pnpm and Turbo cache volumes remain available while a machine is reused and disappear when it is deleted.

To run the opt-in live test, set `BOXD_API_KEY` and `BOXD_TEST_SNAPSHOT` in a local checkout. The snapshot must be a ready `2x8` snapshot in `fra` containing `~/.ssh/usine_worker.pub`. Run `pnpm --filter @usine/executor exec vitest run test/ssh/provisioner/boxd-live.test.ts`. The test creates one machine, runs SSH `true`, and destroys it; it is skipped in CI.
