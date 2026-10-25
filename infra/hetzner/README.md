# SSH workers on Hetzner Cloud

An `ssh` worker is any Linux machine that the orchestrator reaches over SSH. These files create one on Hetzner Cloud in Falkenstein (`fsn1`), Nuremberg (`nbg1`), or Helsinki (`hel1`). [Add a worker](https://docs.usine.dev/guides/add-a-worker/) covers the same steps. [ADR 0026](../../docs/adr/0026-eu-ssh-worker.md) records why usine runs its own workers on EU machines.

- `cloud-init.yaml` builds a Debian 13 machine: the `usine` user, with SSH by key only, Docker, Git, gh, Node.js 24, pnpm, Claude Code, Codex pinned to a supported version, and Chromium. It also builds a worker behind the gateway of `gateway/`, where `gateway/gateway.sh worker-user-data` adds the gateway's worker settings.
- `create-worker.sh` creates the server with that file, labels it `usine=worker`, and attaches a Hetzner firewall that allows SSH only from the orchestrator's address.
- `snapshot.sh` builds the snapshot from which a [provisioned worker](#provisioned-workers) creates a server for each attempt.
- `../worker-image/Dockerfile` is the image of each attempt's container. CI builds it and pushes it to `ghcr.io/basaltbytes/usine-worker`, tagged with its Claude Code and Codex versions.

## Attempt containers

With Docker on the machine, each attempt runs in its own container from the attempt image, and every command of the attempt runs in it with `docker exec`. The container mounts the attempt's checkout and the `usine` user's harness login files read-write, and its cached clone and credential directory read-only, so attempts can't read each other's tokens ([#231](https://github.com/basaltbytes/usine/issues/231)). It uses the machine's network. `usine` starts and removes the containers, so it's in the `docker` group, which makes it root-equivalent on the machine; the containers have no Docker access, and no attempt runs as `usine` on a machine with Docker. Preflight at `usine up` checks Docker, pulls the image, and checks that the image's `usine` user has the user ID of the machine's `usine` (1000 on these machines). [`workers[].container`](https://docs.usine.dev/reference/configuration/usine-yaml/#workerscontainer) sets the image and each container's CPU, memory, and process limits.

Inside a container, the image sets `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`, and `TURBO_CACHE_DIR`, and the executor sets the attempt's credential and gateway variables. The image's entrypoint copies `~/.claude.json` and `~/.codex/config.toml` into the container's home, where the harnesses can write them; `~/.claude/.credentials.json` and `~/.codex/auth.json` are read-write mounts of the machine's files, which the harnesses rewrite when they refresh their tokens.

A machine without Docker runs each child as a non-interactive SSH session of `usine`, as described in the rest of this file, and preflight reports the worker as degraded. That session gets the variables of `/etc/environment` and reads no shell profile. `/etc/environment` sets:

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

A container's pnpm store and Turborepo cache are its own and go with it. The rest of this section is about a machine without Docker.

Each attempt starts in a new worktree, so only caches outside it carry over. All attempts run as `usine` and share pnpm's store at `/home/usine/.local/share/pnpm/store`, from which `pnpm install` links packages and downloads only missing ones, and Turborepo's cache at `/home/usine/.cache/turbo` (`TURBO_CACHE_DIR`). A task whose inputs match an earlier attempt's run restores its outputs. `TURBO_CACHE_DIR` overrides a `cacheDir` in the repo's `turbo.json`; task logs still go to `.turbo/` in the package folder, which is removed with the worktree.

Without `TURBO_CACHE_DIR` and a `cacheDir`, Turborepo 2.10 puts a linked worktree's cache beside the main repo, which for an attempt is `<root>/workers/<name>/repos/.turbo/cache`.

## Upgrade the harnesses

The attempt image has the Claude Code and Codex versions that the usine release supports, and its tag names them. A usine release with new versions names a new tag, which preflight pulls at the next `usine up` or reload that preflights the worker; nothing changes on the machine. A worker with `container.image` in `usine.yaml` gets new versions when you change that tag. CI pushes an image for every change to `infra/worker-image/`. A change that keeps the versions overwrites their tag, and workers get it at their next preflight.

The first image pushed to GHCR is private. Make the `usine-worker` package public in its package settings on GitHub, or run `docker login ghcr.io` as `usine` on each worker.

The harnesses that `cloud-init.yaml` installs on the machine serve the logins, and run attempts only on a machine without Docker. `cloud-init.yaml` runs only when the server is created, so to change their versions on a running worker, install them by hand. `usine` has no sudo and root can't log in over SSH, so install them as root through `su` in an SSH session as `usine`:

1. Give root a password with `hcloud server reset-password <name>`, which prints it, then switch to root:

   ```sh
   ssh -t -i ~/.ssh/usine_worker usine@<address> 'su -'
   ```

   For a worker behind the gateway, connect with its `Host` entry; see [`gateway/README.md`](gateway/README.md).

2. Run the `npm install -g` line of the setup script in `cloud-init.yaml`, with the variables of `/etc/environment`, which contain the forward proxy behind the gateway. Then lock root's password again:

   ```sh
   set -a; . /etc/environment; set +a
   npm install -g pnpm@11.20.0 @anthropic-ai/claude-code@2.1.308 @openai/codex@0.159.2
   passwd -l root
   ```

The harness logins stay. `usine up` checks the Codex version at startup and before every attempt.

## Add Docker to an existing worker

A worker created before `cloud-init.yaml` installed Docker runs attempts as `usine`. Stop `usine up` or wait until the worker runs no attempt: after Docker is installed, usine refuses to reattach or salvage a checkout from before, because that would run git as `usine`, who can then use Docker. Such a checkout stays for you to salvage and remove. Then, as root through `su` as above:

```sh
set -a; . /etc/environment; set +a
apt-get install -y docker.io
usermod -aG docker usine
passwd -l root
```

For a worker behind the gateway, write the Docker proxy drop-in and `daemon.json` of `gateway/worker-cloud-init.yaml` first, and add the `ghcr.io` hosts of `gateway/egress-allowlist` to the gateway's allowlist; see [`gateway/README.md`](gateway/README.md). Start `usine up`; preflight pulls the image.

## Provisioned workers

A worker with a `provisioner` in `usine.yaml`, instead of a `destination`, creates a server for each attempt from a snapshot and deletes it after the attempt ([#550](https://github.com/basaltbytes/usine/issues/550)). [Add a provisioned worker](https://docs.usine.dev/guides/add-a-provisioned-worker/) gives the steps, and [`workers[].provisioner`](https://docs.usine.dev/reference/configuration/usine-yaml/#workersprovisioner) the keys. The project needs:

- An API token with **Read & Write** permission, from **Security** > **API tokens** in the Hetzner Cloud Console. The orchestrator reads it from the variable that `token_env` names. The token applies to every resource of the project; usine deletes only servers with its `usine-instance` and `usine-worker` labels.
- The worker's SSH key, registered once: `hcloud ssh-key create --name usine-worker --public-key-from-file ~/.ssh/usine_worker.pub`. Hetzner adds it for root, whom sshd refuses, and so emails no root password. The `usine` user's key comes from the snapshot.
- For a worker behind the gateway, the gateway's network, `usine-gateway` by default. Each server joins it with no public address; see [`gateway/README.md`](gateway/README.md#provisioned-workers-behind-the-gateway).
- The snapshot.

A server created for one attempt has no harness login, so preflight requires the gateway's Anthropic credential (`llm_providers`) or `api_keys.anthropic` for Claude Code, and refuses Codex.

### Build the snapshot

`snapshot.sh` takes the public key of the worker's `identity_file`, with the private key next to it, and an SSH key of the project in `SSH_KEY`. With `NETWORK`, it builds the snapshot behind the gateway and connects through `GATEWAY_SSH`:

```sh
SSH_KEY=usine-worker NETWORK=usine-gateway GATEWAY_SSH=usine-gateway ./infra/hetzner/snapshot.sh ~/.ssh/usine_worker.pub
SSH_KEY=usine-worker ./infra/hetzner/snapshot.sh ~/.ssh/usine_worker.pub   # a worker without a gateway
```

The script:

1. Creates a temporary server `usine-snapshot-<time>`, labeled `usine=snapshot-build`, from `cloud-init.yaml` with the key authorized for `usine` and a public IPv4 address, or with `NETWORK` from `gateway/gateway.sh worker-user-data` in that network, with no public address.
2. Waits until it accepts SSH as `usine` and cloud-init finishes, through the gateway with `-J` if it's behind it. Each run uses a known-hosts file of its own.
3. Checks that Docker answers `usine`, and pulls the attempt image: `ATTEMPT_IMAGE` in `packages/executor/src/ssh/container.ts`, or the `ATTEMPT_IMAGE` variable.
4. Shuts the server down and saves it as a snapshot labeled `usine=snapshot`, with the description `usine-worker-<image tag>`, such as `usine-worker-claude-2.1.308-codex-0.159.2`, or `DESCRIPTION`.
5. Deletes the server, also after a failure, and prints the snapshot's ID and description for `provisioner.image`.

`LOCATION` (default `fsn1`), `SERVER_TYPE` (default `cx23`), `IMAGE` (default `debian-13`), and `SERVER_NAME` set the temporary server. A server created from the snapshot needs a disk at least as large as `SERVER_TYPE`'s, so build it on the smallest type you use; `cx33` and `cpx32` have more than `cx23`. Behind the gateway, `gateway.sh` reads `GATEWAY_IP`, `DOMAIN`, and `NETWORK_CIDR` as for `create`, and the snapshot works only in that gateway's network.

The snapshot has no harness login and no token. The attempt image must be public on GHCR, because a server created for one attempt has no `docker login`. Hetzner bills each snapshot by its size; `hcloud image list --type snapshot --selector usine=snapshot` lists them, and `hcloud image delete` deletes one.

When a usine release changes the attempt image or `cloud-init.yaml`, build a new snapshot from a checkout of that release. With `image` set to a description, each server is created from the newest available snapshot with it, so a new snapshot with the same description needs no restart. A changed `image` does: a reload refuses a changed `provisioner`.

### Servers without a gateway

Without a gateway, each server has a public IPv4 address and accepts the `usine` user's key from any address. To admit only the orchestrator, create a firewall with the rules file of `create-worker.sh` and name it in `provisioner.firewall`, so that each server gets it when it's created:

```sh
hcloud firewall create --name usine-<worker> --rules-file firewall.json
```

### Leftover servers

usine deletes the servers that no attempt holds after each startup's recovery and every 3 minutes. Servers are left only while no `usine up` runs for the instance. Then list and delete them by label, with the GitHub App's ID:

```sh
hcloud server list -l usine-instance=github-app-<App ID>
hcloud server delete <id>...
```

## Remove a worker

Remove it from `usine.yaml`, then delete the server and its firewall:

```sh
hcloud server delete eu-one
hcloud firewall delete usine-eu-one
```

The SSH key registered with Hetzner can stay for the next worker; `hcloud ssh-key delete` removes it.
