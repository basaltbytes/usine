---
title: Add a boxd worker
description: Restore boxd machines from prepared snapshots for SSH attempts.
---

Add an SSH worker that restores a boxd machine for each attempt.

## Prerequisites

Instance admin access, a boxd account with a payment method and available machine slots, the boxd CLI, and an SSH key pair. The snapshot and machines must be in the same region. A region is the id of a region that boxd enables for your org. `boxd manage regions` lists the org's regions and whether each is enabled, and `boxd manage regions --json` prints them as JSON. `fra` (Frankfurt) and `nyc` (New York) are the hosted regions, and a boxd deployment in your own cloud account has its own id. Your org's home region is always enabled; to use another region, ask boxd to enable it with `boxd manage regions request <id>`.

Use a gateway for subscription credentials. Without a gateway, configure API keys for the rostered harnesses.

## Prepare the snapshot

1. Sign in with `boxd auth login`. Create a member API key:

   ```sh
   boxd auth keys create usine --kind member
   ```

   Store the key as `BOXD_API_KEY` in the instance's private `.env`. Restart usine to read new variables. Worker preflight checks that the worker public key is linked to the boxd account of this API key. The snapshot builder uses the CLI's linked device key for setup.

2. Create the worker key if needed:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
   ```

3. From the usine source checkout, build a snapshot in the intended region using the CLI's regional configuration:

   ```sh
   infra/boxd/build-snapshot.sh --size 2x8 usine-attempt
   ```

   The script creates a temporary Ubuntu machine at the requested size, prepares Docker, pulls the release's attempt image, installs Tailscale, and saves the snapshot. It deletes the temporary machine and prints the snapshot name. Set `USINE_CONTAINER_RUNTIME=podman` to install Podman instead. Set `ATTEMPT_IMAGE` to bake a custom attempt image.

## Link the worker key

The boxd SSH proxy accepts only public keys linked to the account. API keys cannot link SSH keys: linking requires a signed-in session. Use a session for the account that owns the worker's member API key. Set `BOXD_TOKEN` to that signed-in boxd session token, then run this command from the usine source checkout after `pnpm install`:

```sh
node infra/boxd/link-ssh-key.mjs ~/.ssh/usine_worker.pub boxd-pool
```

Replace `boxd-pool` with the worker name you use in usine. The script calls `account.linkSshKey` from `@boxd-sh/sdk` with the session token and `deviceId: "usine:<worker name>"`, then prints the linked SHA-256 fingerprint. Repeat this step after rotating the worker key; the same device id replaces its previous key. `BOXD_API_KEY` remains the member API key used by the worker.

## Create the worker

1. Open **Configuration > Workers > New**. Choose `ssh`, root `/home/boxd/.usine`, identity file `~/.ssh/usine_worker`, and the desired concurrency. Select provisioner `boxd`, token variable `BOXD_API_KEY`, region `fra` or the id of the snapshot's region, size `2x8`, and snapshot `usine-attempt`. Leave **Isolated** checked to exclude the in-machine boxd CLI, integrations, agent logins, and default private network.

2. For subscription credentials, select gateway `usine-gateway` and enable the provisioner's tailnet settings. Enter the gateway's Tailscale address and OAuth client variable names. The client needs `auth_keys` write access for `tag:usine-attempt`. The [Boat gateway guide](/guides/connect-boat-to-a-gateway/) describes the shared tailnet policy and gateway setup. Each machine joins with an ephemeral single-use key and leaves during cleanup. Package downloads use the machine's direct internet connection.

   Without a gateway, set the Anthropic or OpenAI API-key variable names needed by the roster.

6. Optionally, restrict each machine's egress; see [Restrict egress](#restrict-egress). Save the worker.

## Restrict egress

A restored boxd machine reaches the whole internet unless `provisioner.egress` lists what it may reach. The gateway's forward proxy enforces the same kind of list for Hetzner workers, so both come from one file: `infra/hetzner/gateway/egress-allowlist`, or the copy you maintain on the gateway at `/etc/usine-gateway/egress-allowlist`. Print it as a boxd allowlist from the usine source checkout:

```sh
node infra/boxd/egress.mjs                                      # the checked-in list
node infra/boxd/egress.mjs /path/to/egress-allowlist            # a copy of the gateway's list
```

The script prints an `egress:` block for `provisioner`, with `*.tailscale.com` first. It refuses a rule with a port, which a boxd allowlist can't express. Paste the block under `provisioner`, or enter the entries in the worker form's **Egress allowlist** field, separated by commas. Leave the field empty for unrestricted egress.

Remove the API and login hosts of each provider whose credential the gateway holds: `api.anthropic.com` and `platform.claude.com` for `anthropic-messages`, `api.openai.com`, `chatgpt.com`, and `auth.openai.com` for `openai-responses`. Attempts reach those providers at `llm.<domain>`, and a direct connection would carry the caller token. usine refuses a configuration that admits them, or `github.com` or `api.github.com`, and names the host.

What each entry is for:

- **Tailscale.** `*.tailscale.com` admits the coordination server that the machine joins through and the DERP relay servers. boxd blocks UDP from a restricted machine, so the machine can't connect to the gateway directly: tailnet traffic, including git and model traffic to the gateway, goes through Tailscale's DERP relays over HTTPS. The gateway's tailnet and public addresses need no entry.
- **Packages.** The package hosts that attempts download from over the machine's direct connection, and `ghcr.io` with `pkg-containers.githubusercontent.com`, from which preflight pulls an attempt image the snapshot lacks.
- **Harness hosts.** A harness whose provider credential the gateway doesn't hold calls its provider directly with the key from `provisioner.api_keys`. Keep that provider's API host, `api.anthropic.com` or `api.openai.com`; the gateway's list doesn't include `api.openai.com`.

usine applies the list right after boxd restores the machine, then waits one second, the time boxd states the list takes to come into force, before it connects to the machine or starts anything on it. Processes that the snapshot resumes, such as `tailscaled` and the container runtime, run without the list during that second. If boxd refuses the list or reports the machine's egress unrestricted afterwards, usine deletes the machine and retries creation later. When usine reuses a machine for another attempt, it applies the list again.

An address entry admits all traffic to that address, and usine can't tell whose address it is. The gateway check therefore covers host names only: behind a gateway, preflight logs a warning that names the address entries. Make sure none of them belongs to GitHub or to a provider the gateway serves. Like boxd, usine refuses an address or range with host bits set, one that overlaps a private, CGNAT, loopback, link-local, multicast, or reserved range, and a range wider than `/8`.

Preflight logs the number of entries in `boxd provisioner verified`. If a restricted machine can't join the tailnet or reach the gateway, the error says that `provisioner.egress` restricts the machine.

## Check the result

Worker preflight validates the API key, snapshot readiness, captured size, region, and available machine slots without creating a machine. It reads `<identity_file>.pub` next to the worker identity file, computes its OpenSSH SHA-256 fingerprint, and checks the account fingerprints returned by `Whoami`. The verified log includes the fingerprint. A missing, unreadable, or invalid public key fails preflight with a provider capability error that includes the file path. An unlinked key fails with its fingerprint, file path, and a pointer to the linking step. usine finds the region's API endpoint in the regions that boxd lists. If boxd lists no region with the configured id for your org, including a region that boxd hasn't enabled for it, preflight fails and names the ids that boxd lists.

boxd's proxy terminates SSH and authenticates account-linked keys; it ignores the machine's `authorized_keys`. The snapshot does not need the worker public key. usine sends gateway tokens and API keys over standard input, which the proxy carries. Gateway setup configures the host entries and the HTTP socket units.

`size` asserts the snapshot's captured size: a mismatch requires rebuilding the snapshot at that size or changing the setting. Restores retain the captured CPU and memory.

Start a test run. usine disables auto-hibernate and auto-suspend, pins the SSH proxy host key reported by boxd, and connects as `boxd` at the machine's public IP and assigned port. **Workers** shows the machine until cleanup retires it. [boxd settings](/reference/configuration/workers/#boxd-provisioner) lists all options, including reuse.

If boxd refuses to create the machine as invalid, for example because it reserves the machine name `usine-<worker name>-<8 hex digits>`, worker preflight fails with boxd's message, which names the machine. Rename the worker or correct the provisioner settings; retrying the same request fails the same way.

Token exchanges and gRPC calls time out after 30 seconds. A stalled token exchange reports an unreachable provider and allows waiting calls to retry authentication.

## Environment variables

boxd terminates SSH at its proxy and runs commands through its exec agent, which ignores OpenSSH `SendEnv` and `SetEnv`. usine sends secret variables to every SSH worker, boxd included, as an environment block on standard input. Each command reads the block before its command input or child protocol starts. Values stay out of command arguments, logs, and credential files. Gateway preflight checks that placeholder variables arrive this way.

## SSH recovery

usine refreshes the machine's SSH endpoint during recovery because its proxy port can change. A deleted, stopped, failed, or destroyed machine ends the attempt as an infrastructure failure. For suspended, hibernated, migrating, or pending machines, usine reports a provider error and keeps the last endpoint for recovery. Unpushed work on a lost machine cannot be recovered; retries use the latest pushed salvage.

## Image preparation

boxd snapshots retain the pulled attempt image. Rebuild the snapshot after upgrading usine to a release with a different attempt image, or when changing a custom image. Preflight logs an absent image at warning level and downloads it before running attempts. Shared pnpm and Turbo cache volumes remain available while a machine is reused and disappear when it is deleted.

To run the opt-in live test, set `BOXD_API_KEY` and `BOXD_TEST_SNAPSHOT` in a local checkout. The snapshot must be a ready `2x8` snapshot in `fra`, and `~/.ssh/usine_worker` and its `.pub` file must exist. Run `pnpm --filter @usine/executor exec vitest run test/ssh/provisioner/boxd-live.test.ts`. Link the test key to the account first with the operator script. The test checks the key fingerprint during preflight, creates one machine with a unique name, checks SSH connectivity, sends a variable over stdin and reads it back, and destroys it; it is skipped in CI.
