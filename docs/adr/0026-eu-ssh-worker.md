# Customer code runs on EU machines that usine controls, over SSH

exe.dev's control plane, the `ssh exe.dev` lobby every VM command passes through, is in the United States for all accounts, under California-law terms and with no published data processing agreement ([research note](../research/agent-sandboxes.md), section 1). Customer code on an exe.dev worker therefore leaves usine-controlled EU infrastructure with no agreement covering it. Customer attempts instead run on EU machines usine controls: an `ssh` worker kind for any Linux machine reachable over SSH. The first are Hetzner Cloud servers in Falkenstein, Nuremberg, or Helsinki under Hetzner's data processing agreement, built from a repository cloud-init file and open to SSH only from the orchestrator's address ([#223](https://github.com/basaltbytes/usine/issues/223), stage 1).

SSH workers run attempts exactly like exe.dev ones: the Pi parent is a durable orchestrator task, each Claude Code or Codex child is one SSH command with a pid file next to the worktree, and checkouts, sweeps, salvage, recovery, and reattach share code. The kinds differ only in finding machines (the lobby versus `usine.yaml`) and in repository access. The executor contract of [ADR 0006](./0006-executor-contract-run-host-attempt-channel.md) is unchanged: credentials stay machine-attached, and readying a worker, logins included, stays the operator's out-of-band task.

Repository access is the one-hour single-repo installation token the orchestrator already mints ([ADR 0011](./0011-github-app-identity-scoped-worker-tokens.md)), written per attempt to `<root>/workers/<worker>/credentials/<attempt>` next to the checkouts, as locally, with 700 directories and 600 files. git's credential helper reads the file and gh reads its config directory, so running children get renewals without restarting. The token is passed on the writing command's standard input, never in arguments, environment, or logs, and kept git and gh output is scrubbed of it. It's removed when the attempt's scope closes, and a new orchestrator process removes leftovers on first use of a worker.

File modes block other Unix users, not other attempts: attempts on a worker share one SSH user, and the path is predictable from the root and attempt id, so any concurrent attempt's token is readable ([#231](https://github.com/basaltbytes/usine/issues/231)). Stage 1 accepts this, and an hour-long GitHub token on the machine, because each customer gets its own worker, so co-located attempts serve one customer; each token opens one repository and expires within the hour; ADR 0011 accepts the same exposure locally; and EU workers on the existing child host take days to build. Stage 2 of #223, a gateway with a credential-injecting proxy, removes the token and the exposure.

_Note, 2026-10-14:_ an SSH worker can now be behind a gateway ([ADR 0027](./0027-gateway-credential-proxy.md), `gateway` on the worker in `usine.yaml`), with no GitHub token on the machine. The executor attaches each attempt's token to the gateway and gives the machine only a caller token, passed in the children's SSH environment, never in a file or command line. Attempts sharing a user can still read each other's caller tokens from their processes and use that repository through the gateway while the attachment is valid, only from inside the private network ([#243](https://github.com/basaltbytes/usine/issues/243)), but none can take a GitHub token off the machine. Workers without a gateway are unchanged.

_Note, 2026-10-25:_ [ADR 0029](./0029-worker-kinds-and-adapter-set.md) runs each attempt on a long-lived `ssh` worker in its own container ([#548](https://github.com/basaltbytes/usine/issues/548)), which removes the shared-user exposure of #231 and #243, and adds a provisioner that creates one machine per attempt ([#550](https://github.com/basaltbytes/usine/issues/550)). It also makes EU residency a property of each worker adapter that the customer chooses, in place of this ADR's rule that customer attempts run on EU machines that usine controls.

## Considered options

- **Keep exe.dev**: works today, but its control plane and terms stay outside the EU and any agreement. Rejected.
- **exe.dev's Frankfurt region or Enterprise BYOC**: the VMs move, but exe.dev still operates the hosts and lobby. Rejected likewise.
- **Gateway first**: no token on the machine from the start, but two to three weeks before customer code could leave exe.dev. It's stage 2.
- **A Hetzner-specific worker kind**: ties the executor to one provider's API. An SSH destination in `usine.yaml` covers any machine, and machine creation is an `infra/hetzner` script outside the executor.

## Consequences

- SSH worker pushes are attributed to the instance's App, as locally; ADR 0011's exe.dev attribution split doesn't apply.
- Each customer gets its own worker machine, since concurrent attempts on one SSH worker can read each other's tokens, as an exe.dev VM has the grants of every repository it runs.
- `usine up` picks the executor from the worker kind in `usine.yaml`.
