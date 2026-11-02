---
title: Add a Hetzner worker
description: Create attempt machines from a Hetzner snapshot.
---

Add an SSH worker that creates Hetzner Cloud machines for attempts and retires them after use.

## Prerequisites

Instance admin access, an instance using SSH workers, a Hetzner project, `hcloud`, `jq`, a matching usine checkout, and an SSH key. Provide model credentials through a configured gateway or API keys; do not save subscription logins in the snapshot.

## Procedure

1. Generate a Hetzner project API token with **Read & Write** access. Store it as `HCLOUD_TOKEN` in the instance’s private `.env`. Register the worker’s public key in Hetzner:

   ```sh
   hcloud ssh-key create --name usine-worker --public-key-from-file ~/.ssh/usine_worker.pub
   ```

2. Build a snapshot from the matching release checkout:

   ```sh
   SSH_KEY=usine-worker ./infra/hetzner/snapshot.sh ~/.ssh/usine_worker.pub
   ```

   For a gateway worker, also set `NETWORK=usine-gateway` and `GATEWAY_SSH=usine-gateway`, with the gateway’s address and domain overrides if needed. The script prints the snapshot ID and description, then deletes its temporary machine. The snapshot and target server must share an architecture and have sufficient disk capacity.

3. Restart usine to read the new environment variables. Open **Configuration > Workers > New**, choose `ssh`, and set a name, root `/home/usine/.usine`, identity file `~/.ssh/usine_worker`, and desired concurrency.
4. Select provisioner `hetzner`. Set token variable `HCLOUD_TOKEN`, server type such as `cx33`, location such as `fsn1`, the snapshot ID, and SSH key name `usine-worker`. Leave fixed destination and port unset.
5. Set model API-key variable names for the rostered harnesses, or set the gateway and its provider list. Gateway workers also require the gateway network in the provisioner. Save.

## Check the result

Provider preflight validates the configured resources without creating a machine. A test run creates a machine, checks it, and runs one attempt there. **Workers** shows its provider ID and age; cleanup deletes it unless bounded reuse is configured.

Creation failures back off without blocking other workers. [Provisioner settings](/reference/configuration/workers/#provisioner) describes timing, reuse, pinned host keys, and recovery. Update the snapshot by building another and editing the worker’s image setting; connection revisions apply to new work.
