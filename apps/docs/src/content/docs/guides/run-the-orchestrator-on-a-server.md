---
title: Run the orchestrator in a Hetzner gateway network
description: Create a Hetzner orchestrator with systemd and tailnet HTTPS access.
---

Create an always-on orchestrator in a gateway’s Hetzner private network.

For a VPS or another Linux machine without this gateway setup, [host usine on a Linux server](/guides/host-usine-on-linux/).

## Prerequisites

A configured gateway and private network, a matching usine checkout, `hcloud`, SSH keys registered in the Hetzner project, and Tailscale with MagicDNS and HTTPS certificates enabled. Use remote workers; this server image has no child harnesses.

## Procedure

1. In the tailnet policy, permit your devices to reach `tag:usine-orchestrator` on TCP 22 and 443, and configure who can apply that tag. Remove broader grants that would allow unintended access.
2. Create the server from the checkout:

   ```sh
   SSH_KEY=usine-worker ./infra/hetzner/gateway/gateway.sh orchestrator ~/.ssh/id_ed25519.pub
   ```

   The script creates its private-network connection, firewall, Unix user, Node.js installation, global usine package, and systemd units. It prints the private address.

3. Wait for cloud-init through the gateway, then join the tailnet and publish HTTPS:

   ```sh
   ssh -J usine-gateway -i ~/.ssh/usine_worker root@10.42.0.4 cloud-init status --wait
   GATEWAY_SSH=usine-gateway ./infra/hetzner/gateway/gateway.sh orchestrator-tailnet-up -i ~/.ssh/usine_worker
   ```

   Replace the sample private address. Complete the printed Tailscale login. The script enables nftables, which restricts SSH to the tailnet, and prints the HTTPS address.

4. Connect as `usine` over the tailnet. Set up the gateway and worker SSH aliases, private keys, and trusted known-hosts entries in `/home/usine/.ssh/`. Check `ssh usine-gateway true` and each fixed worker connection as this user.
5. Create `/home/usine/factory` and initialize it using the [quickstart](/get-started/quickstart/), or [move an existing instance](/guides/move-an-instance/). Configure remote workers. Set `USINE_ORIGIN` in the instance’s private `.env` to the printed HTTPS address, and supply the Pi parent credential as the `usine` user.
6. Start the service from the instance folder:

   ```sh
   systemctl start usine.service
   journalctl -u usine.service -f
   ```

   Complete setup and member enrollment through the local sign-in link before sharing access.

## Check the result

`usine status` reports `usine.service` as managed with systemctl. The HTTPS UI requires sign-in and shows the expected projects and workers. Startup recovery finishes before readiness succeeds.

The unit starts at boot and restarts after failures. Run `usine stop` or `usine restart` from the instance folder to retain systemd management. The service reads `.env` itself and inherits no shell variables. Keep credentials there or in its configured credential files.

The listener stays on loopback. Tailscale access rules restrict network reachability; instance role bindings govern product access. [Upgrade an instance](/guides/upgrade-an-instance/) describes the included upgrade helper.
