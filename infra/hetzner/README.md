# SSH Workers on Hetzner Cloud

An `ssh` Worker is any Linux machine the orchestrator connects to over SSH. This folder creates one on
Hetzner Cloud in Falkenstein (`fsn1`), Nuremberg (`nbg1`), or Helsinki (`hel1`):

- `cloud-init.yaml` builds the machine on Debian 13: the `usine` user, Git, gh, Node.js 24, pnpm,
  Claude Code, Codex, and Chromium, with SSH open to the `usine` user by key only. Codex is pinned
  to a version usine supports. Chromium is Debian's package, for Playwright: `/etc/environment`
  sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`, which Playwright does not read
  itself, so a project's test config passes it to Playwright as `executablePath`, as
  `apps/web/vitest.config.ts` does. A Turborepo task sees the variable only when it lists it in
  `env`, as the `test` task in `turbo.json` does. `/etc/environment` also sets `TURBO_CACHE_DIR`,
  which Turborepo reads itself: see [Caches shared by Attempts](#caches-shared-by-attempts). Each
  of an Attempt's children is a non-interactive SSH session, which gets these variables from
  `/etc/environment` and reads no shell profile. The same file builds a Worker behind the gateway
  of `gateway/`, where `gateway/gateway.sh worker-user-data` adds the gateway's Worker settings to
  it.
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
4 vCPU and 8 GB). A Worker needs 8 GB: the repository's lint and knip gates reserve a 6 GiB
virtual buffer ([#270](https://github.com/basaltbytes/usine/issues/270)). The cost-optimized `cx`
types are often out of stock, so check `hcloud server-type list` first. The script registers the
public key with Hetzner once (otherwise Hetzner emails a root password), creates the firewall
`usine-<name>`, and creates the server.

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
- `max_concurrent_attempts` is the number of Attempts the Worker runs at the same time. Its memory
  must carry them: see [Memory per Attempt](#memory-per-attempt).

Every Worker in one `usine.yaml` must have the same kind. Each Attempt clones from GitHub with the
one-hour token the factory's GitHub App mints for the Attempt's repository; the token is written to
`<root>/workers/<name>/credentials/<attempt>` on the machine and removed when the Attempt ends.

A Worker on a private network behind the gateway of `gateway/` takes a `gateway` setting instead,
and no token is written on its machine: see [`gateway/README.md`](gateway/README.md).

## Memory per Attempt

The children of an Attempt run the repository's own gates on the Worker, such as `pnpm install`,
`pnpm build`, and `pnpm test`, and these use far more memory than the harnesses. On 2026-10-15 two
Attempts at once on a 4 GB Worker without swap thrashed it until sshd stopped answering
([#270](https://github.com/basaltbytes/usine/issues/270)). At startup, preflight reads the
Worker's memory and swap from `/proc/meminfo` and divides the memory by `max_concurrent_attempts`:

| Memory per concurrent Attempt | Preflight                                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| 3 GiB or more                 | passes                                                             |
| 1.5 GiB to 3 GiB              | passes, and logs a warning with a `max_concurrent_attempts` to use |
| less than 1.5 GiB             | fails the `memory` check, and `usine up` stops                     |

A Worker without swap also fails the `memory` check when `max_concurrent_attempts` is more than 1.
A cx33 or cpx32 has 7.7 GiB of memory and gets a 2 GB swap file from `cloud-init.yaml`, so it runs
two Attempts without a warning.

## Caches shared by Attempts

Every Attempt starts in a new worktree, so only the caches outside the worktree carry over from
one Attempt to the next. All Attempts on the machine run as the `usine` user and share two caches:

- pnpm's store, at pnpm's default location `/home/usine/.local/share/pnpm/store`. `pnpm install`
  links packages from it into the worktree and downloads only the packages it lacks.
- Turborepo's cache, at `/home/usine/.cache/turbo`, which `/etc/environment` sets as
  `TURBO_CACHE_DIR`. A task whose inputs match a run of an earlier Attempt restores its outputs
  instead of running. The variable takes precedence over a `cacheDir` in the repository's
  `turbo.json`. Turborepo still writes each task's log to `.turbo/` in the package's folder, which
  is removed with the worktree.

Without `TURBO_CACHE_DIR`, Turborepo 2.10 puts the cache of a linked worktree beside the main
repository, which for an Attempt is `<root>/workers/<name>/repos/.turbo/cache`, unless `turbo.json`
sets `cacheDir`.

## Remove a Worker

Remove it from `usine.yaml` first, then delete the server and its firewall:

```sh
hcloud server delete eu-one
hcloud firewall delete usine-eu-one
```

The SSH key registered with Hetzner can stay for the next Worker; `hcloud ssh-key delete` removes it.
