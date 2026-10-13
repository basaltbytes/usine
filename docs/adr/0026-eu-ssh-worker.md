# Customer code runs on EU machines usine controls, reached over SSH

exe.dev's control plane, the `ssh exe.dev` lobby every VM command passes through, is in the United States for every account; its terms are governed by California law, and it publishes no data processing agreement ([research note](../research/agent-sandboxes.md), section 1). Customer code checked out and run on an exe.dev Worker therefore leaves EU infrastructure that usine controls, and no agreement covers it. Customer Attempts run instead on EU machines usine controls: an `ssh` Worker kind for any Linux machine the orchestrator reaches over SSH, first rented from Hetzner Cloud in Falkenstein, Nuremberg, or Helsinki under Hetzner's data processing agreement, built from a cloud-init file in the repository and reachable over SSH from the orchestrator's address only ([#223](https://github.com/basaltbytes/usine/issues/223), stage 1).

The SSH Worker runs Attempts exactly as the exe.dev Worker does: the Pi parent is a durable task in the orchestrator, each Claude Code or Codex child is one SSH command with its pid file beside the worktree, and checkouts, sweeps, salvage, recovery, and reattachment are the same code, shared by both kinds. The kinds differ only in how a machine is found (the lobby for exe.dev, `usine.yaml` for SSH) and in how an Attempt gets access to its repository. The executor contract of [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md) needs no change: credentials stay machine-attached, and making a Worker ready, harness logins included, stays the operator's out-of-band task.

The Attempt's repository access is the one-hour single-repository installation token the orchestrator already mints ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)), written for the Attempt into a private directory beside the Worker's checkouts the way the local Worker writes it: git's credential helper reads the token file and gh reads its own configuration directory, so a renewal reaches running children without restarting them. The token reaches the machine on the standard input of shell builtins, so no process's arguments, environment, or log line carries it, and git and gh output is scrubbed of it before it is kept. It is removed when the Attempt's scope closes, and the first use of a Worker by a new orchestrator process removes whatever an earlier process left. Stage 1 accepts this posture, a GitHub token on the machine for up to an hour, because it is the blast radius ADR 0011 already accepts for the local Worker, and it lets EU Workers ship in days on the existing child host. Stage 2 of #223, a gateway with a credential-injecting proxy, removes the token from the machine.

## Considered Options

- **Keep exe.dev**: the Worker works today, but its control plane and terms stay outside the EU and outside any agreement. Rejected.
- **exe.dev's Frankfurt region or Enterprise BYOC**: the VMs move, but exe.dev still operates the hosts and the lobby. Rejected for the same reason.
- **Gateway first**: no token on the machine from the start, but two to three weeks before any customer code can leave exe.dev. It is stage 2.
- **A Hetzner-specific Worker kind**: it would tie the executor to one provider's API. An SSH destination in `usine.yaml` covers any machine, and creating machines is a script in `infra/hetzner`, outside the executor.

## Consequences

- Pushes from an SSH Worker are attributed to the factory's own App, as on the local Worker; the attribution fork ADR 0011 records for exe.dev does not apply to this kind.
- Each customer gets its own VM, because concurrent Attempts on one SSH Worker run as one Unix user and can read each other's tokens while they run, as an exe.dev VM holds the grants of every repository it runs.
- `usine up` selects the executor from the Worker kind in `usine.yaml`.
