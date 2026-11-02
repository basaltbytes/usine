---
title: Connect Boat to a gateway
description: Use gateway credentials from Boat sandboxes over Tailscale.
---

Keep GitHub and subscription credentials on the gateway while Boat attempts use caller tokens.

## Prerequisites

A configured Boat worker, a paid Boat plan supporting saved snapshots, a gateway with both required provider credentials, instance admin access, a matching usine checkout, and Tailscale administration access.

## Procedure

1. Join the gateway and orchestrator to the tailnet. Record the gateway’s `100.64.0.0/10` IPv4 address. Set `USINE_GATEWAY_PROXY_HOST=0.0.0.0` on the gateway, apply the gateway nftables rules that allow port 80 on `tailscale0`, and restart the gateway. Keep admin and forward-proxy ports private.
2. Create a Tailscale OAuth client with `auth_keys` write access for `tag:usine-attempt`. Store its client ID and secret as `TAILSCALE_CLIENT_ID` and `TAILSCALE_CLIENT_SECRET` in the instance `.env`, then restart usine.
3. Configure tag ownership and a tailnet grant that permits attempt nodes to reach only the gateway’s TCP port 80:

   ```json
   { "src": ["tag:usine-attempt"], "dst": ["tag:usine-gateway"], "ip": ["tcp:80"] }
   ```

   Remove broader grants matching attempt nodes because grants are additive. Normal Boat SSH uses Boat’s endpoint.

4. Build a saved snapshot with Tailscale and the release’s attempt image:

   ```sh
   infra/boat/build-snapshot.sh usine-attempt <attempt-image> ~/.ssh/usine_boat
   ```

   Set `BOAT_API_KEY` in this shell. Use the image from the matching release’s worker image setting. The script requires `curl`, `jq`, and OpenSSH and removes Tailscale identity before saving. Keep credentials and repository checkouts out of the source snapshot.

5. Edit the Boat worker. Set the gateway’s domain, SSH destination, admin-token variable, and provider list. Set provisioner snapshot `usine-attempt`, tailnet gateway address, client-ID variable `TAILSCALE_CLIENT_ID`, and client-secret variable `TAILSCALE_CLIENT_SECRET`. Save.

## Check the result

Preflight validates snapshot readiness, OAuth tag access, and the gateway address. From a test attempt, gateway port 80 answers while ports 22, 3128, and 7070 are blocked. Usage appears under the credential’s plan.

Boat retains direct internet access for package downloads. Cleanup revokes the gateway attachment, logs out of Tailscale, and deletes the sandbox. Restore the orchestrator or delete orphan sandboxes after an outage; a live sandbox stays on the tailnet until cleanup.
