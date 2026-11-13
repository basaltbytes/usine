---
title: Add an SSH worker
description: Connect a fixed Linux worker and verify its attempt container.
---

Run attempts on a fixed Linux machine over SSH.

## Prerequisites

Instance admin access, an instance using SSH workers, a Linux machine with Git, rootless Podman or Docker, a writable worker root, an SSH key, and the child harness credentials. Pi children require local workers.

## Procedure

1. Prepare the machine with the [worker image and cloud-init scripts](https://github.com/basaltbytes/usine/tree/main/infra/hetzner). For a Hetzner machine, create a key and run the worker script from a matching usine checkout:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
   ./infra/hetzner/create-worker.sh worker-one fsn1 203.0.113.10 ~/.ssh/usine_worker.pub
   ```

   Replace the orchestrator’s public address and use the worker address printed by the script in the next step.

2. Connect to record the trusted host key and wait for cloud-init:

   ```sh
   ssh -i ~/.ssh/usine_worker usine@203.0.113.20 cloud-init status --wait
   ```

3. Log in as the worker user for each rostered harness, unless a gateway supplies its credential:

   ```sh
   ssh -t -i ~/.ssh/usine_worker usine@203.0.113.20
   claude auth login
   codex login --device-auth
   ```

4. Open **Configuration > Workers > New**. Enter a name, select kind `ssh`, and set destination `usine@203.0.113.20`, identity file `~/.ssh/usine_worker`, root `/home/usine/.usine`, and concurrency `1`. Save.
5. Inspect preflight. Fix any image, UID, resource-control, tool, or login error before running work.

## Check the result

The worker reports passing preflight, its selected runtime, and applied container limits. Start a test run and confirm its attempt lists the SSH worker.

For Docker and Podman, the server logs whether the attempt image is present and how long inspection and pulling take. A missing image produces a warning and is pulled before the first container starts. Other Podman inspection errors stop preparation and report a container capability error.

After a pull, usine removes the other images of the attempt image's repository. It keeps the current image, the most recently built other image, and any image that a container uses. After a rollback, the retained image can be newer than the current image. Preflight and each attempt check that the worker's root and image storage have at least 10 GiB free. Below that, **Needs attention** shows the free space and the threshold, and attempts wait until a preflight passes. Set `min_free_disk_gib` to change the threshold; see [Free disk space and older images](/reference/configuration/workers/#free-disk-space-and-older-images).

For later edits, run `EDITOR=vi usine config edit worker worker-one`. [Attempt containers](/reference/configuration/workers/#attempt-container) explains image requirements and shared caches. [Configure a gateway](/guides/configure-a-gateway/) to proxy credentials.

## Home worker on a Mac

Use an always-on Linux VM in OrbStack or Lima for a Mac worker. On Apple Silicon, use an arm64 VM; the default attempt image supports arm64. Allocate at least 3 GiB per concurrent attempt, plus memory for the VM. Use NAT networking rather than a bridged interface. NAT gives the VM internet access through the Mac, but does not prevent it from connecting to the home network.

1. Install Debian or Ubuntu in the VM, then prepare the SSH worker prerequisites above. Use rootless Podman with the required UID, cgroup delegation, and lingering, or Docker with host networking. Install OpenSSH server, curl, Tailscale, nftables, and `systemd-socket-proxyd` (included with systemd on Debian). Create the writable worker root. Give the orchestrator's SSH user passwordless sudo for the gateway configuration; preflight runs a shell script as root. Keep that user and its sudo access outside attempt containers.
2. Join the VM to Tailscale using a long-lived worker identity, such as `tag:usine-worker`, with subnet routes and Tailscale DNS disabled:

   ```sh
   sudo tailscale up --accept-routes=false --accept-dns=false --advertise-tags=tag:usine-worker
   ```

   Authorize the tag in your tailnet policy and configure unattended key expiry. Use public DNS resolvers in the VM so that attempts do not need access to a home DNS server. Keep the VM clock synchronized.

3. Configure tailnet grants in your own policy. Permit the orchestrator identity to connect to the worker's TCP port 22, and permit the worker identity to connect only to the gateway's TCP port 80. Remove broader grants that also match the worker, because grants are additive. Join the gateway to the tailnet and enable its reverse proxy on `tailscale0` as described in [Connect Boat to a gateway](/guides/connect-boat-to-a-gateway/). A fixed worker uses no OAuth client or per-attempt auth keys.
4. Before running attempts, install persistent nftables rules in the VM. This example uses gateway address `100.64.0.2`; replace it with yours. Merge these rules with the VM's existing rules and load them with its nftables service:

   ```text
   table inet usine_home_worker {
     set private_v4 {
       type ipv4_addr
       flags interval
       elements = { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }
     }
     set private_v6 {
       type ipv6_addr
       flags interval
       elements = { fc00::/7, fe80::/10 }
     }
     chain output {
       type filter hook output priority filter; policy accept;
       oifname "lo" accept
       ct state established,related accept
       meta skuid 0 accept
       ip daddr 100.64.0.2 tcp dport 80 accept
       ip daddr @private_v4 reject
       ip6 daddr @private_v6 reject
     }
     chain forward {
       type filter hook forward priority filter; policy drop;
     }
   }
   ```

   Attempts use host networking, so the output rules also apply to their container processes. The root exception lets Tailscale maintain its encrypted transport through the Mac's NAT; attempt processes must run as a non-root host UID. The forwarding policy blocks bridge containers. Loopback services remain accessible, so keep sensitive services off the VM. NAT alone is insufficient. Apply the rules before opening attempt connections and confirm that a non-root process cannot connect to the Mac, a home device, or another tailnet device. Both IPv4 and IPv6 require checks.

5. Verify the VM's SSH host key through its console, then record it on the orchestrator. Set an SSH alias using the worker's tailnet address and trusted key. Check `ssh usine-home true` and `ssh usine-home sudo -n true` from the orchestrator. The worker must be able to connect to the gateway's TCP port 80 over Tailscale.
6. Edit the worker with `EDITOR=vi usine config edit worker home` or the configuration text editor. Use the gateway's existing admin-token variable in the orchestrator:

   ```yaml
   name: home
   kind: ssh
   destination: usine-home
   root: /home/usine/.usine
   max_concurrent_attempts: 1
   gateway:
     domain: gw.internal
     destination: usine-gateway
     admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
     llm_providers: [anthropic-messages, openai-responses]
   tailnet:
     gateway_address: 100.64.0.2
   ```

   Set `llm_providers` to the credentials configured on your gateway. Save and inspect preflight. Each preflight reapplies gateway host entries and gh's HTTP socket through passwordless sudo, then requires `http://git.<domain>/` to answer `x-usine-gateway-refusal: missing-caller-token` without a token. A sudo, service, or gateway failure prevents the worker from accepting work.

Run a test attempt and confirm that GitHub and configured model requests use the gateway while package downloads use direct internet access. Check private-address refusal from inside the attempt container. Removing an attempt leaves the VM joined to the tailnet; the operator manages its identity.

## Codex connection recovery

Remote Codex children continue running through an SSH disconnect. usine reconnects to the same app-server and reads buffered output. If the disconnect interrupts an output frame, usine replays that frame from the last complete output offset. The relay discards incomplete input frames, and reconnection resends them to the running app-server. If the supervisor or app-server exits after the thread is saved, including an unexpected exit with code 0 or an exit before the first turn request starts or completes, usine stops the remaining process group and confirms termination before resuming the thread once. Recovery resends the original task if the saved thread has no user message; otherwise, it continues the saved work. Recovery replays unread operator guidance in order and reports delivery after the recovered turn accepts it. A paused or idle child waits for operator guidance after recovery and includes any unread messages when it resumes. When Codex records that resumed input, usine reports its queued guidance as read so another pause does not resend it. A second failure records an infrastructure failure, which takes precedence over earlier child questions or blockers and permits an automatic retry. The worker needs Node.js on its command path, including inside the attempt container.
