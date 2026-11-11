---
title: Add a boxd worker
description: Restore boxd machines from prepared snapshots and run attempts on them through boxd's Exec API.
---

Add an SSH worker that restores a boxd machine for each attempt. usine runs commands on the machine through boxd's gRPC `Exec` API with the worker's API key, so the worker needs no SSH key.

## Prerequisites

Instance admin access, a boxd account with a payment method and available machine slots, and the boxd CLI. The snapshot and machines must be in the same region. A region is the id of a region that boxd enables for your org. `boxd manage regions` lists the org's regions and whether each is enabled, and `boxd manage regions --json` prints them as JSON. `fra` (Frankfurt) and `nyc` (New York) are the hosted regions, and a boxd deployment in your own cloud account has its own id. Your org's home region is always enabled; to use another region, ask boxd to enable it with `boxd manage regions request <id>`.

Use a gateway for subscription credentials. Without a gateway, configure API keys for the rostered harnesses.

## Prepare the snapshot

1. Sign in with `boxd auth login`. Create a member API key:

   ```sh
   boxd auth keys create usine --kind member
   ```

   Store the key as `BOXD_API_KEY` in the instance's private `.env`. Restart usine to read new variables. The snapshot builder needs only this key: it calls boxd's API and runs its setup through `Exec`, without SSH or the CLI's signed-in session.

2. From the usine source checkout, after `pnpm install`, build a snapshot in the intended region:

   ```sh
   BOXD_API_KEY=bxd_... node infra/boxd/build-snapshot.mjs --size 2x8 --region fra usine-attempt
   ```

   The script creates a temporary Ubuntu machine from a machine spec: isolated, shared with the key's org, at the requested size, and with the egress allowlist that `infra/boxd/egress.mjs` prints for the gateway's checked-in list. It prepares Docker, pulls the release's attempt image, installs Tailscale, and saves the snapshot, which keeps the spec's allowlist. The setup downloads from hosts outside the allowlist, so the script lifts the machine's allowlist while the setup runs: it starts the setup one second after boxd reports the machine's egress unrestricted, because an egress edit takes up to a second to take effect. After the setup, it sets the allowlist again and checks that boxd reports it in effect and records it in the machine's spec before it saves. It waits up to 10 minutes for the version that the save captures to become ready and prints the snapshot name. If boxd reports that the save failed, or the version isn't ready by then, the build fails. It deletes the temporary machine when the build ends, fails, or is interrupted, and names the machine if the deletion fails.

   Without `--region`, the machine and the snapshot are in the region that the endpoint serves, `fra` on the hosted service. A self-hosted cluster or a boxd deployment in your own cloud account passes its API endpoint with `--endpoint https://<api endpoint>`. Set `USINE_CONTAINER_RUNTIME=podman` to install Podman instead of Docker. Set `ATTEMPT_IMAGE` to bake a custom attempt image.

## Create the worker

1. Open **Configuration > Workers > New**. Choose `ssh`, root `/home/boxd/.usine`, and the desired concurrency. Leave the identity file empty: a boxd worker runs its commands through boxd's `Exec` API with the API key. A boxd worker that sets one loads and ignores it, and its preflight logs a warning that names the file. Select provisioner `boxd`, token variable `BOXD_API_KEY`, region `fra` or the id of the snapshot's region, size `2x8`, and snapshot `usine-attempt`. Leave **Isolated** checked to exclude the in-machine boxd CLI, integrations, agent logins, and default private network.

2. For subscription credentials, select gateway `usine-gateway` and enable the provisioner's tailnet settings. Enter the gateway's Tailscale address and OAuth client variable names. The client needs `auth_keys` write access for `tag:usine-attempt`. The [Boat gateway guide](/guides/connect-boat-to-a-gateway/) describes the shared tailnet policy and gateway setup. Each machine joins with an ephemeral single-use key and leaves during cleanup. Package downloads use the machine's direct internet connection.

   Without a gateway, set the Anthropic or OpenAI API-key variable names needed by the roster.

3. Optionally, restrict each machine's egress; see [Restrict egress](#restrict-egress). Save the worker.

## Restrict egress

A machine restored from the builder's snapshot starts with the snapshot's allowlist, the gateway's checked-in list. `provisioner.egress` replaces it with the list you configure. A snapshot without an allowlist leaves restored machines unrestricted unless `provisioner.egress` lists what they may reach. The gateway's forward proxy enforces the same kind of list for Hetzner workers, so both come from one file: `infra/hetzner/gateway/egress-allowlist`, or the copy you maintain on the gateway at `/etc/usine-gateway/egress-allowlist`. Print it as a boxd allowlist from the usine source checkout:

```sh
node infra/boxd/egress.mjs                                      # the checked-in list
node infra/boxd/egress.mjs /path/to/egress-allowlist            # a copy of the gateway's list
```

The script prints an `egress:` block for `provisioner`, with `*.tailscale.com` first. It refuses a rule with a port, which a boxd allowlist can't express. Paste the block under `provisioner`, or enter the entries in the worker form's **Egress allowlist** field, separated by commas. Leave the field empty to keep the snapshot's allowlist.

Remove the API and login hosts of each provider whose credential the gateway holds: `api.anthropic.com` and `platform.claude.com` for `anthropic-messages`, `api.openai.com`, `chatgpt.com`, and `auth.openai.com` for `openai-responses`. Attempts reach those providers at `llm.<domain>`, and a direct connection would carry the caller token. usine refuses a configuration that admits them, or `github.com` or `api.github.com`, and names the host.

What each entry is for:

- **Tailscale.** `*.tailscale.com` admits the coordination server that the machine joins through and the DERP relay servers. boxd blocks UDP from a restricted machine, so the machine can't connect to the gateway directly: tailnet traffic, including git and model traffic to the gateway, goes through Tailscale's DERP relays over HTTPS. The gateway's tailnet and public addresses need no entry.
- **Packages.** The package hosts that attempts download from over the machine's direct connection, and `ghcr.io` with `pkg-containers.githubusercontent.com`, from which preflight pulls an attempt image the snapshot lacks.
- **Harness hosts.** A harness whose provider credential the gateway doesn't hold calls its provider directly with the key from `provisioner.api_keys`. Keep that provider's API host, `api.anthropic.com` or `api.openai.com`; the gateway's list doesn't include `api.openai.com`.

usine sends the list in the request that restores the machine, so the machine is created with it. The list isn't always fully in force when the restored machine resumes: processes that the snapshot resumes, such as `tailscaled` and the container runtime, can reach hosts outside the list for up to about a second. usine waits one second after boxd creates the machine before it connects to the machine or starts anything on it, so no attempt process runs in that window. If boxd refuses the list, creation fails with boxd's message, like any creation request that boxd refuses as invalid. If boxd reports the new machine's egress unrestricted, usine deletes the machine and retries creation later. When usine reuses a machine for another attempt, it applies the list again.

An address entry admits all traffic to that address, and usine can't tell whose address it is. The gateway check therefore covers host names only: behind a gateway, preflight logs a warning that names the address entries. Make sure none of them belongs to GitHub or to a provider the gateway serves. Like boxd, usine refuses an address or range with host bits set, and one that overlaps a private, CGNAT, loopback, link-local, multicast, or reserved range. usine also refuses a range with a prefix length under 8.

Preflight logs the number of entries in `boxd provisioner verified`. If a restricted machine can't join the tailnet or reach the gateway, the error says that `provisioner.egress` restricts the machine.

## Check the result

Worker preflight validates the API key, snapshot readiness, captured size, region, and available machine slots without creating a machine. usine finds the region's API endpoint in the regions that boxd lists. If boxd lists no region with the configured id and an API endpoint for your org, including a region that boxd hasn't enabled for it, preflight fails and names the ids that boxd lists. If boxd reports the snapshot's storage as `archiving`, `archived`, or `unarchiving` rather than `local`, preflight logs a warning that names the state: boxd creates machines only from a local snapshot.

usine reaches each machine through boxd's `Exec` API at the region's API endpoint, with the worker's API key as the bearer. Nothing on the machine or the boxd account needs an SSH key, and the snapshot needs none. usine sends gateway tokens and API keys over standard input. Gateway setup configures the host entries and the HTTP socket units.

`size` asserts the snapshot's captured size: a mismatch requires rebuilding the snapshot at that size or changing the setting. Restores retain the captured CPU and memory.

Start a test run. usine disables auto-hibernate and auto-suspend, then runs each command on the machine as user `boxd` through `Exec`. **Workers** shows the machine until cleanup retires it. [boxd settings](/reference/configuration/workers/#boxd-provisioner) lists all options, including reuse.

If boxd refuses to create the machine as invalid, for example because it reserves the machine name `usine-<worker name>-<8 hex digits>`, worker preflight fails with boxd's message, which names the machine. Rename the worker or correct the provisioner settings; retrying the same request fails the same way.

Token exchanges and gRPC calls time out after 30 seconds. A stalled token exchange reports an unreachable provider and allows waiting calls to retry authentication, each with its own 30 seconds. usine exchanges the API key for a new session 5 minutes before the session expires. When boxd refuses a session before then, usine exchanges the key again and retries the call once.

A token exchange that answers HTTP 429 counts as a rate limit, and HTTP 502, 503, or 504 counts as an unreachable provider: usine retries the attempt's launch later. Any other error status fails preflight with the status.

## How commands run

usine runs each command on a boxd machine over an `Exec` stream from the orchestrator process itself, without starting a local program. All of a worker's commands share one HTTP/2 connection to the region's API endpoint, which carries the API key; the key never reaches a child process or a command line. usine raises the HTTP/2 receive window to 8 MiB, sends standard input in chunks of at most 64 KiB, and sends HTTP/2 keepalive pings, so a dead connection fails within a minute instead of hanging. A stream that ends without an exit code, because boxd refused the key, the connection dropped, or the machine is gone, counts as an unreachable machine, never as a command result. When usine cancels a command, boxd ends its process group.

`Exec` has no field for environment variables. usine sends secret variables to every SSH worker, boxd included, as an environment block on standard input. Each command reads the block before its command input or child protocol starts. Values stay out of command arguments, logs, and credential files. Gateway preflight checks that placeholder variables arrive this way.

## Recovery

A boxd machine keeps its id, so its endpoint never changes. When the machine stops answering, usine asks boxd whether it still exists. A deleted, stopped, failed, or destroyed machine ends the attempt as an infrastructure failure. A suspended, hibernated, migrating, or pending machine counts as unresponsive, and usine keeps probing it. Unpushed work on a lost machine cannot be recovered; retries use the latest pushed salvage.

## Image preparation

boxd snapshots retain the pulled attempt image. Rebuild the snapshot after upgrading usine to a release with a different attempt image, or when changing a custom image. Preflight logs an absent image at warning level and downloads it before running attempts. Shared pnpm and Turbo cache volumes remain available while a machine is reused and disappear when it is deleted.

To run the opt-in live test, set `BOXD_API_KEY` and `BOXD_TEST_SNAPSHOT` in a local checkout. The snapshot must be a ready `2x8` snapshot in `fra`. Run `pnpm --filter @usine/executor exec vitest run test/ssh/provisioner/boxd-live.test.ts`. The test runs preflight, creates one machine with a unique name, runs a command on it through `Exec`, sends a variable over stdin and reads it back, and destroys it; it needs no SSH key and is skipped in CI.
