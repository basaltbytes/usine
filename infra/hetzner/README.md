# SSH workers on Hetzner Cloud

An `ssh` worker is any Linux machine that the orchestrator reaches over SSH. These files create one on Hetzner Cloud in Falkenstein (`fsn1`), Nuremberg (`nbg1`), or Helsinki (`hel1`). [Add a worker](https://docs.usine.dev/guides/add-a-worker/) covers the same steps. [ADR 0026](../../docs/adr/0026-eu-ssh-worker.md) records why usine runs its own workers on EU machines.

- `cloud-init.yaml` builds a Debian 13 machine: the `usine` user, with SSH by key only, Git, gh, Node.js 24, pnpm, Claude Code, Codex pinned to a supported version, and Chromium. It also builds a worker behind the gateway of `gateway/`, where `gateway/gateway.sh worker-user-data` adds the gateway's worker settings.
- `create-worker.sh` creates the server with that file, labels it `usine=worker`, and attaches a Hetzner firewall that allows SSH only from the orchestrator's address.

Each child of an attempt is a non-interactive SSH session, which gets the variables of `/etc/environment` and reads no shell profile. `/etc/environment` sets:

- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`, for Debian's Chromium. Playwright doesn't read it, so a project's test config passes it as `executablePath`, as `apps/web/vitest.config.ts` does. A Turborepo task sees it only if the task lists it in `env`, as the `test` task in `turbo.json` does.
- `TURBO_CACHE_DIR`, which Turborepo reads itself; see [Caches shared by attempts](#caches-shared-by-attempts).

## Create a worker

You need the `hcloud` CLI with an active context for the project, and a dedicated SSH key pair for the worker on the orchestrator machine:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
./infra/hetzner/create-worker.sh eu-one fsn1 203.0.113.10 ~/.ssh/usine_worker.pub
```

The arguments are the worker name, the location, the IPv4 address that the orchestrator connects from, and the public key. `HCLOUD_SERVER_TYPE` sets the server type (default `cpx32`, 4 vCPU and 8 GB). A worker needs 8 GB, because the repo's lint and knip gates reserve a 6 GiB virtual buffer ([#270](https://github.com/basaltbytes/usine/issues/270)). `cx` types are often out of stock; check `hcloud server-type list`. The script registers the public key with Hetzner once (otherwise Hetzner emails a root password), creates the firewall `usine-<name>`, and creates the server.

cloud-init takes a minute or two after boot. The orchestrator's batch-mode SSH refuses unknown host keys, so connect once from the orchestrator machine to record the key, and wait for cloud-init:

```sh
ssh -i ~/.ssh/usine_worker usine@<address> cloud-init status --wait
```

## Log in to the harnesses

Harness logins are the operator's and stay on the machine. As the `usine` user, log in to each harness that the roster uses:

```sh
ssh -t -i ~/.ssh/usine_worker usine@<address>
claude auth login        # Claude subscription; open the URL it prints and paste the code back
codex login --device-auth  # ChatGPT plan; enter the code it prints at the URL it prints
```

`usine up` checks both logins at startup and before every attempt, and names the worker and harness if one is missing.

## Add the worker to `usine.yaml`

```yaml
workers:
  - name: eu-one
    kind: ssh
    destination: usine@203.0.113.7
    identity_file: ~/.ssh/usine_worker
    root: /home/usine/.usine
    max_concurrent_attempts: 2
```

`destination` can be a `Host` alias from the orchestrator user's SSH configuration, for `ProxyJump`, a separate `UserKnownHostsFile`, and other client settings. Without `identity_file` and `port`, the SSH agent and configuration decide. cloud-init creates `/home/usine/.usine` for `root`; the worker keeps its clones, checkouts, and attempt credentials under `<root>/workers/<name>`. The machine's memory must support `max_concurrent_attempts`; see [Memory per attempt](#memory-per-attempt).

All workers in one `usine.yaml` must have the same kind. Each attempt clones with the one-hour token that the factory's GitHub App mints for its repo. The token is written to `<root>/workers/<name>/credentials/<attempt>` and removed when the attempt ends. A worker behind the gateway of `gateway/` has a `gateway` setting instead and no token on its machine; see [`gateway/README.md`](gateway/README.md).

## Memory per attempt

An attempt's children run the repo's own gates, such as `pnpm install`, `pnpm build`, and `pnpm test`, which use far more memory than the harnesses. Preflight reads memory and swap from `/proc/meminfo` and fails below 1.5 GiB per concurrent attempt, or without swap and more than one; [Add a worker](https://docs.usine.dev/guides/add-a-worker/) gives the thresholds ([#270](https://github.com/basaltbytes/usine/issues/270)). A cx33 or cpx32 has 7.7 GiB and gets a 2 GB swap file from `cloud-init.yaml`, so it runs two attempts without a warning.

## Caches shared by attempts

Each attempt starts in a new worktree, so only caches outside it carry over. All attempts run as `usine` and share pnpm's store at `/home/usine/.local/share/pnpm/store`, from which `pnpm install` links packages and downloads only missing ones, and Turborepo's cache at `/home/usine/.cache/turbo` (`TURBO_CACHE_DIR`). A task whose inputs match an earlier attempt's run restores its outputs. `TURBO_CACHE_DIR` overrides a `cacheDir` in the repo's `turbo.json`; task logs still go to `.turbo/` in the package folder, which is removed with the worktree.

Without `TURBO_CACHE_DIR` and a `cacheDir`, Turborepo 2.10 puts a linked worktree's cache beside the main repo, which for an attempt is `<root>/workers/<name>/repos/.turbo/cache`.

## Remove a worker

Remove it from `usine.yaml`, then delete the server and its firewall:

```sh
hcloud server delete eu-one
hcloud firewall delete usine-eu-one
```

The SSH key registered with Hetzner can stay for the next worker; `hcloud ssh-key delete` removes it.
