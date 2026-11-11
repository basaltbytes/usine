# Worker kinds: a long-lived machine or a machine per attempt, through each platform's own tools

Isolated workers take one of two shapes:

- **A long-lived machine** that the operator provides, reached over SSH (the `ssh` kind). Any Linux host works, so no provider gets a kind of its own. With Podman or Docker, each attempt runs in its own container, which mounts no other attempt's checkout or credentials. Attempts still share the kernel, the cached clone read-only, package caches, and any harness login on the machine, read-write. Without a container runtime, attempts share one user, and preflight reports the worker degraded.
- **A machine per attempt**, created for one attempt in the operator's account, or reused within limits: a provisioner on the `ssh` kind with Hetzner Cloud, Boat, and boxd drivers, or the `cloudflare` kind. A hypervisor separates concurrent attempts.

The `local` kind suits trusted agents only.

**Platform tools first.** An adapter starts from what an attempt needs and uses the platform's own transport, snapshots, and network rules, even when an existing interface has to change. boxd machines run commands over boxd's `Exec` stream, restore from snapshots that keep the attempt image, and can get an egress allowlist, sent in the restore request, that boxd enforces. boxd may become the main provider.

**Residency per adapter.** Customers need EU residency, so the operator picks the adapter and region: Hetzner's EU locations, a boxd region, or Boat's EU machines, whose snapshot copies can leave the EU.

**Credentials.** A machine per attempt can't keep a harness login, so its harnesses use the gateway's credential (ADR 0027) or an API key passed to that attempt. On an `ssh` machine without a gateway, the attempt's GitHub token is on the machine.

Each adapter must track a vendor, so usine has adapters only for providers that operators use. An instance runs all its workers with one executor kind. The exe.dev implementation is on hold: its adapter stays in the code, and the server doesn't run exe.dev workers today.

## Considered options

- **A Unix user per attempt**: accounts, sudo rules, and ownership changes, where a container gives the same boundaries in one command.
- **Microvm hosts that usine operates**: bare metal or nested virtualization, plus hardware or cluster operations.
- **SSH for every provider**: boxd's proxy accepts only keys linked by a signed-in session, and SSH costs a process and a TLS connection per command.
