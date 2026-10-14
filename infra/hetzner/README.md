# SSH Workers on Hetzner Cloud

An `ssh` Worker is any Linux machine the orchestrator connects to over SSH. This folder creates one on
Hetzner Cloud in Falkenstein (`fsn1`), Nuremberg (`nbg1`), or Helsinki (`hel1`):

- `cloud-init.yaml` builds the machine on Debian 13: the `usine` user, Git, gh, Node.js 24, pnpm,
  Claude Code, and Codex, with SSH open to the `usine` user by key only. Codex is pinned to a
  version usine supports.
- `create-worker.sh` creates the server with that file, labels it `usine=worker`, and attaches a
  Hetzner firewall that admits SSH from the orchestrator's address only.

Why usine runs its own Workers on EU machines is recorded in
[ADR 0026](../../docs/adr/0026-eu-ssh-worker.md).

## Create a Worker

You need the `hcloud` CLI with an active context for the project, and an SSH key pair on the
orchestrator machine for the Worker. A dedicated key keeps the Worker's access separate:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
./infra/hetzner/create-worker.sh eu-one fsn1 203.0.113.10 ~/.ssh/usine_worker.pub
```

The arguments are the Worker name, the location, the IPv4 address the orchestrator connects from,
and the public key to authorize. `HCLOUD_SERVER_TYPE` selects the server type (default `cpx32`,
4 vCPU and 8 GB); the cost-optimized `cx` types are often out of stock, so check
`hcloud server-type list` first. The script registers the public key with Hetzner once (otherwise
Hetzner emails a root password), creates the firewall `usine-<name>`, and creates the server.

cloud-init takes a minute or two after the server starts. Connect once from the orchestrator
machine to record the server's host key, and wait for cloud-init to finish:

```sh
ssh -i ~/.ssh/usine_worker usine@<address> cloud-init status --wait
```

The orchestrator connects in batch mode, so it refuses a host whose key is not in `known_hosts`.

## Log in to the harnesses

Harness logins are the operator's and stay on the machine. Log in as the `usine` user for each
harness the roster uses:

```sh
ssh -t -i ~/.ssh/usine_worker usine@<address>
claude auth login        # Claude subscription; open the URL it prints and paste the code back
codex login --device-auth  # ChatGPT plan; enter the code it prints at the URL it prints
```

`usine up` checks both logins at startup and before every Attempt, and names the Worker and
harness when one is missing.

## Add the Worker to `usine.yaml`

```yaml
workers:
  - name: eu-one
    kind: ssh
    destination: usine@203.0.113.7
    identity_file: ~/.ssh/usine_worker
    root: /home/usine/.usine
    max_concurrent_attempts: 2
```

- `destination` is `user@host`, or a `Host` alias from the orchestrator user's SSH configuration
  (for `ProxyJump`, a separate `UserKnownHostsFile`, and other client settings).
- `identity_file` and `port` are optional; without them the SSH agent and configuration decide.
- `root` is a directory the SSH user can write to; cloud-init creates `/home/usine/.usine`. Each
  Worker keeps its cached clones, Attempt checkouts, and Attempt credentials under
  `<root>/workers/<name>`.

Every Worker in one `usine.yaml` must have the same kind. Each Attempt clones from GitHub with the
one-hour token the factory's GitHub App mints for the Attempt's repository; the token is written to
`<root>/workers/<name>/credentials/<attempt>` on the machine and removed when the Attempt ends.

A Worker on a private network behind the gateway of `gateway/` takes a `gateway` setting instead,
and no token is written on its machine: see [`gateway/README.md`](gateway/README.md).

## Remove a Worker

Remove it from `usine.yaml` first, then delete the server and its firewall:

```sh
hcloud server delete eu-one
hcloud firewall delete usine-eu-one
```

The SSH key registered with Hetzner can stay for the next Worker; `hcloud ssh-key delete` removes it.
