# Rootless attempt containers

Research for [#668](https://github.com/basaltbytes/usine/issues/668), read on 2026-10-29. Repository baseline: [`f54b3bd`](https://github.com/basaltbytes/usine/tree/f54b3bd708bc443cae1b543139a69fdff356fe6a). This is a documentation and source review, not a runtime benchmark or a completed worker migration. No rootless container tests were run for this note.

Prefer rootless Podman with `--userns=keep-id` for the SSH worker migration. It preserves the relationship between the SSH user's files and the image's non-root user. Rootless Docker removes the privileged daemon but requires a different ownership arrangement. Both require cgroup v2 with delegated controllers; neither makes an SSH account safe to expose to attempt code.

## Existing lifecycle

[`ssh/container.ts`](../../packages/executor/src/ssh/container.ts) detects Docker, pulls the attempt image, compares the SSH UID with the image's default UID, prepares a shared pnpm store, and derives resource limits. [`remote/container.ts`](../../packages/executor/src/remote/container.ts) implements the lifecycle:

- Start a detached, named container with instance, worker, and attempt labels; run commands through `<runtime> exec -i` over SSH. Preflight containers expire after 15 minutes; attempt containers remain available for salvage before removal.
- Use `--network host`, CPU and memory limits, a PID limit, and `--memory-swap` equal to `--memory` to disallow container swap.
- Mount the checkout read-write, its parent as tmpfs, and the repository cache and credential directory read-only. Mount shared harness login files read-write, seed other harness files, and mount the `usine-pnpm-store` named volume. Turborepo's cache is local to the container at this baseline.
- Inspect and restart a stopped container for salvage; stop children before cleanup. Read `memory.events` before removal, record OOM kills by container ID, and sweep orphan containers using both instance labels.

[`infra/hetzner/cloud-init.yaml`](../../infra/hetzner/cloud-init.yaml) installs `docker.io` and `docker-cli`, then adds `usine` to the `docker` group. The [gateway overlay](../../infra/hetzner/gateway/worker-cloud-init.yaml) configures a system Docker daemon proxy, disables Docker's firewall rules, and exposes gh's HTTP relay at `/run/usine-gateway/http.sock`. The [image](../../infra/worker-image/Dockerfile) runs as `usine`, UID 1000 by default; its home and init script assume `/home/usine`.

[ADR 0011](../adr/0011-github-app-identity-scoped-worker-tokens.md) defines mount and credential isolation. [ADR 0027](../adr/0027-gateway-credential-proxy.md), amendment of 2026-10-25, explicitly accepts the root-equivalent SSH user and relies on host-network traffic passing through nftables' output chain. [ADR 0029](../adr/0029-worker-kinds-and-adapter-set.md) distinguishes persistent SSH workers from machines created per attempt. A rootless implementation must amend the Docker-specific rules; this note proposes that change without replacing those decisions.

## Compatibility

Podman references below use version 5.4.2, the version listed for Debian trixie when read [P1]. Docker's rolling documentation includes a host-network behavior change in Engine 29.5 [D3]. Neither version is a claim about the runtime installed on an existing worker.

| Requirement | Rootless Docker | Rootless Podman with `keep-id` |
| --- | --- | --- |
| No root-equivalent runtime access | Daemon and containers run in a user namespace. Remove access to the system daemon as well [D1]. | Local Podman needs no privileged daemon. Remove Docker group/socket access as well [P2]. |
| CPU, memory, PID limits | Requires cgroup v2 and systemd; Docker ignores cgroup flags when those requirements are absent. Delegate CPU explicitly [D2]. | Requires cgroup v2 and usable systemd delegation for rootless limits. Verify actual controller values [P3, K1]. |
| OOM kill count | Keep the cgroup counter and inspect-based stopped-container handling; validate the cgroup mount [K1]. | Same kernel counter; inspect exposes `State.OOMKilled`, but validate its behavior and the cgroup mount [P4, K1]. |
| Gateway and host networking | Before Engine 29.5, `--network host` refers to RootlessKit's network namespace. The current docs describe real host networking from 29.5 [D3]. | `--network host` selects the host network. Podman's rootless limitations document a caveat for subsequent `exec` calls [P2, P5]. |
| Checkout and login ownership | Host UID maps to namespace root; the image's UID 1000 maps to a subordinate host UID. Numeric UID equality is insufficient [D1, D4]. | `keep-id` maps the SSH UID and GID to the same container IDs; optional `uid` and `gid` parameters map them to the image's IDs [P6]. |
| GHCR pulls | Supported. Configure the rootless user daemon's proxy and image store [D2, D5, G1]. | Supported through `podman pull`. Use the SSH process's proxy environment and user-owned image store [P2, P7]. |
| Lifecycle and cleanup | Keeps the Docker CLI protocol, with explicit rootless socket/context selection [D2]. | Equivalent commands exist, but detect Podman explicitly and validate formats, exit codes, mount options, and signal behavior [P4, P8]. |

### Limits and OOM accounting

For either runtime, provision cgroup v2 and a systemd user manager with `cpu`, `memory`, and `pids` delegation. Docker documents that user delegation may include only memory and PIDs, which leaves CPU enforcement unavailable [D2]. Podman documents no rootless cgroup v1 support and requires the systemd cgroup manager for rootless cgroup management [P2, P3]. A successful `run` or a recognized version string does not prove limits work.

Preflight should start a small disposable container using the actual attempt settings and read `cpu.max`, `memory.max`, `memory.swap.max`, and `pids.max`. Require the configured quota, memory cap, zero swap, and PID cap; return a typed capability error when the runtime cannot enforce them. Keep the existing host reserve and concurrency-based limit derivation. Reject `--cgroups=disabled` and do not replace container limits with process-local `ulimit`.

There is a documentation discrepancy around swap: Podman 5.4.2's `--memory-swap` text says the combined limit must be larger than `--memory` [P3]. Its vendored runc cgroup v2 implementation explicitly handles equal values by writing `memory.swap.max=0` [P9]. Podman's resource validation can discard the swap limit when the kernel lacks accounting [P9]. Preserve the existing no-swap policy, but prove equality works with the packaged OCI runtime, including crun if selected; the vendored runc source alone does not prove crun's behavior.

The kernel defines `memory.events` as hierarchical. Its `oom_kill` field counts processes in the cgroup killed by any OOM killer, including host OOM; it is not proof that the attempt reached its own cap [K1]. A boolean `State.OOMKilled` cannot replace that count when a child dies and init survives. Keep the behavior introduced in [#607](https://github.com/basaltbytes/usine/pull/607): read the live cgroup, use the stopped-container indication when necessary, account for salvage restarts, and aggregate records by container ID without counting repeated writes twice.

Use a private cgroup namespace so `/sys/fs/cgroup/memory.events` identifies the container subtree, not the host or the user's whole slice. Podman defaults to a private cgroup namespace on v2; set it explicitly in the migration [P3]. Confirm it with both init and `exec` processes. Do not mount the host cgroup tree writable. Read the counter after children stop and before removing the container; retain warning logs if collection fails. Tests must distinguish an unreadable counter from a verified zero.

### Mounts and user IDs

Rootless Docker uses RootlessKit, where the caller becomes namespace UID 0 [D1, D4]. With the current image, a container process at UID 1000 therefore does not own a checkout created by host UID 1000. The existing UID comparison can pass while writes fail, and mode-0600 login or credential files can be inaccessible.

Running the image as namespace root would make host-owned files accessible, but would change the image's user, home-directory behavior, and harness assumptions. Chowning checkout files to subordinate IDs would interfere with host Git operations and cleanup. Neither is a configuration-only replacement for this image. Docker would also need a revised ownership probe and a tested image/user contract.

Podman's `--userns=keep-id` preserves host ownership when the SSH and image IDs match. For a custom image or a host whose IDs differ, `--userns=keep-id:uid=<image-uid>,gid=<image-gid>` can map the caller to the image user [P6]. Select the user explicitly and preserve `/home/usine`; probe UID and GID, not just UID. Verify a file written in the mounted checkout is readable and writable by host Git, and that the container can read a mode-0600 credential and refresh a mounted login.

Apply the same mapping to every helper container, including image-user probes, pnpm-store initialization, store-size checks, and preflight. Today the store helper uses `--user 0` to set ownership to the image user. Under `keep-id`, namespace root and the mapped application user are different host identities; initialize the new volume using that mapping and verify ownership before reuse. Rootless Podman cannot reuse the rootful Docker image/volume store [P2]. Re-pull the image and recreate the cache after draining attempts, rather than changing ownership recursively on a Docker volume.

Podman's `:U` mount option recursively changes host ownership; avoid it for checkouts, credentials, cached clones, and shared logins [P10]. Keep read-only and read-write access exactly as specified by ADR 0011. Verify tmpfs and bind mounts with the current CSV quoting, including paths containing commas. Keep runtime storage on a local filesystem; Podman documents restrictions on NFS and on native overlay support, with fuse-overlayfs as an alternative [P2].

### Gateway access and GHCR

Podman's host network mode is the closest match to ADR 0027: keep the host output-chain rules, gateway DNS, HTTP/HTTPS proxy variables, and the gh Unix socket bind mount. Host networking retains access to host loopback and abstract Unix sockets; rootless mode does not remove that existing exposure [P5]. Podman 5.4.2's rootless limitations say subsequent `exec` calls do not join the root-owned host network namespace [P2]. Since usine starts commands through `exec`, verify gateway access from that path over a fresh SSH connection; success from the container's initial command is insufficient. This is a rollout condition, not evidence that the documented `host` mode cannot work.

For Docker, do not assume `--network host` has the same meaning across versions. Engine versions before 29.5 place it inside RootlessKit's network namespace; Engine 29.5 and later support the host network according to the current documentation [D3]. Earlier versions require separate validation of user-mode egress, DNS, host access, and the Unix socket. Pin the selected version before relying on either behavior.

Test both allowed and refused traffic: gateway Git/LLM endpoints and proxy downloads must work; direct internet and metadata access must fail where the worker policy forbids them. The metadata rule permits only host UID 0, so namespace root must not bypass it. Boat with a Tailscale gateway has a different policy: credential routes use the tailnet while package downloads retain direct internet access, as ADR 0027's amendment of 2026-10-28 states. Test its host entries and gh relay separately.

GHCR accepts Docker and OCI images and permits anonymous pulls of public images [G1]. Keep the fully qualified `ghcr.io/basaltbytes/usine-worker:<tag>` image name; a private override requires a credential with package access, separate from the attempt's repository token. Keep registry credentials on the host, outside attempt mounts, and use stdin for login. Podman's default auth file is under `XDG_RUNTIME_DIR` and does not persist across reboot; use an explicit protected persistent auth file when a private image requires one [P7].

The existing gateway allowlist includes `ghcr.io` and `pkg-containers.githubusercontent.com`. Preserve it and verify a cold pull, including blob redirects. Rootless Docker requires the proxy drop-in under the user's systemd directory instead of `/etc/systemd/system/docker.service.d/` [D5]. Podman pulls in the SSH user's process, so retain the proxy environment supplied through `/etc/environment`; there is no daemon proxy service to configure. Podman also forwards proxy variables to containers by default [P8]. Prefer explicit attempt environment values and disable that automatic forwarding if it would change the executor's environment contract.

### Security boundary

Removing membership in `docker` is necessary for either choice. Also remove writable system-Docker sockets, privileged runtime services available to the account, and sudo grants that would restore root access. Provisioning still needs an administrator to install packages, allocate non-overlapping subordinate IDs, and configure delegation; the steady-state SSH account does not [D1, P2, K2].

Rootless containers share the host kernel. All containers managed by the same SSH user remain accessible to that user, and `keep-id` is not a distinct host identity for each attempt [P2, P6]. Continue to keep the runtime socket, storage, SSH home, and sibling checkouts outside attempt mounts. Preserve private PID namespaces and the current credential mounts. Shared harness logins and the pnpm store remain shared writable resources; rootless mode does not resolve those accepted exposures. ADR 0029's machine-per-attempt option remains the stronger boundary between attempts.

## Validation required for implementation

Run these checks on a disposable worker built from the proposed cloud-init and on the exact Podman/OCI runtime versions selected for release. They are acceptance tests for the migration, not results of this research.

| Check | Required result |
| --- | --- |
| Boot and non-interactive SSH | An unprivileged `usine` session can inspect, pull, start, and exec after reboot, without an interactive login or sudo. Record runtime, OCI runtime, kernel, cgroup version, and delegated controllers. |
| Resource enforcement | Read the configured CPU, memory, swap, and PID limits from the attempt cgroup; exercise CPU throttling and a small memory limit. Missing delegation fails preflight. |
| OOM lifecycle | Kill a memory-consuming child while init survives, then exercise init OOM, salvage restart, reattach, repeated recording, and removal. Preserve counts by container ID. |
| File ownership | Host Git and the container can both write the checkout; mode-0600 credentials are readable only through intended mounts; login refresh and the shared pnpm store work across two concurrent attempts. |
| Network and pulls | Test initial-command and `exec` paths, gh through its socket, Git and LLM gateway routes, proxy downloads, metadata denial, direct-egress policy, and a cold GHCR pull. Include the Boat tailnet path. |
| Harnesses and project gates | Claude, Codex, and Pi preflight and child startup work with the image user; Chromium and any nested user-namespace tools used by project tests work without privileged mode. |
| Lifetime and cleanup | Detached containers survive SSH disconnect; stdin streaming, cancellation, salvage, reattach, and label-scoped orphan cleanup work. Removing one attempt preserves the other attempt and the shared store. |

## Sources read

- **D1:** Docker, [Rootless mode](https://docs.docker.com/engine/security/rootless/): user namespaces, prerequisites, installation, and disabling the rootful daemon.
- **D2:** Docker, [Rootless tips](https://docs.docker.com/engine/security/rootless/tips/): user service, lingering, socket/context, storage paths, cgroup requirements, and delegation.
- **D3:** Docker, [Rootless troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/): network namespaces and the Engine 29.5 host-network change. Rolling documentation, read on the research date.
- **D4:** Docker, [UID/GID mapping](https://docs.docker.com/engine/security/rootless/uid-gid-mapping/): the caller maps to container root; other container IDs map to subordinate host IDs.
- **D5:** Docker, [Daemon proxy configuration](https://docs.docker.com/engine/daemon/proxy/): rootless user-service proxy configuration.
- **P1:** Debian, [trixie Podman package](https://packages.debian.org/trixie/podman): 5.4.2 package series and dependencies.
- **P2:** Podman 5.4.2, [rootless tutorial](https://github.com/containers/podman/blob/v5.4.2/docs/tutorials/rootless_tutorial.md), [rootless limitations](https://github.com/containers/podman/blob/v5.4.2/rootless.md), and [podman(1)](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman.1.md): setup, user storage, systemd, and host-network exec caveat.
- **P3:** Podman 5.4.2 option sources: [CPU](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/cpus.container.md), [memory](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/memory.md), [swap](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/memory-swap.md), [cgroups](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/cgroups.md), and [cgroup namespace](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/cgroupns.md).
- **P4:** Podman 5.4.2, [container inspect](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman-container-inspect.1.md.in): inspect fields, including state and OOM indication.
- **P5:** Podman 5.4.2, [network options](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/network.md): host network and default rootless networking.
- **P6:** Podman 5.4.2, [user namespace options](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/userns.container.md): default mapping, `keep-id`, and explicit UID/GID mapping.
- **P7:** Podman 5.4.2, [pull](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman-pull.1.md.in) and [login](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman-login.1.md.in): registry pulls, stdin login, and auth-file paths.
- **P8:** Podman 5.4.2, [run](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman-run.1.md.in), [ps](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/podman-ps.1.md), and [proxy environment](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/http-proxy.md): run options, label filtering and formatting, and environment precedence.
- **P9:** Podman 5.4.2, [resource validation](https://github.com/containers/podman/blob/v5.4.2/pkg/specgen/generate/validate_linux.go) and vendored runc [swap conversion](https://github.com/containers/podman/blob/v5.4.2/vendor/github.com/opencontainers/runc/libcontainer/cgroups/utils.go) and [cgroup v2 memory controller](https://github.com/containers/podman/blob/v5.4.2/vendor/github.com/opencontainers/runc/libcontainer/cgroups/fs2/memory.go): swap handling beyond the CLI documentation.
- **P10:** Podman 5.4.2, [volume options](https://github.com/containers/podman/blob/v5.4.2/docs/source/markdown/options/volume.md): bind ownership and recursive chown with `:U`.
- **K1:** Linux kernel, [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): controller files, delegation, and `memory.events` counter semantics.
- **K2:** systemd, [Control group delegation](https://systemd.io/CGROUP_DELEGATION/): manager ownership and delegation boundaries.
- **G1:** GitHub, [Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry): image formats, public pulls, and package authentication.

## Recommendation and required changes

Adopt rootless Podman with `--userns=keep-id`, subject to the worker validation above. It preserves the current non-root image and host-owned mounts with less disruption than rootless Docker. Keep Docker as the existing supported runtime during migration; select a runtime explicitly rather than installing a `docker` alias for Podman. Rootless Docker remains viable if retaining its CLI outweighs changing the image/user contract and provisioning a persistent user daemon.

In `infra/hetzner/cloud-init.yaml`, install Podman, an OCI runtime such as crun, `uidmap`, and the systemd user-session dependencies supplied by Debian. Allocate non-overlapping subordinate UID/GID ranges for `usine`; verify unprivileged user namespaces and local overlay storage, adding fuse-overlayfs where the kernel requires it. Remove `usermod -aG docker usine` and any remaining privileged-runtime access. Enable lingering for `usine`, make its user manager and runtime directory available after boot, and delegate `cpu memory pids` through systemd before any attempt starts. Pin and record the package/runtime versions used to validate the image. Do not start a Podman API socket: the executor invokes the local CLI over SSH.

In the gateway cloud-init overlay, remove the system Docker proxy drop-in and Docker-only `daemon.json` for Podman workers. Preserve `/etc/environment`, nftables, gateway DNS, the gh socket service, and metadata protection. Build replacement snapshots with images pulled as `usine`; rootful Docker's cached images and volumes do not populate the rootless store. Drain attempts before replacing persistent workers, recreate the pnpm cache, and verify logout/reboot behavior before admitting work.

In the executor, replace the global `CONTAINER_RUNTIME` assumption with an explicit runtime choice carried through the existing container operations and `ShellContainer.runtime`. Add Podman detection using its structured info, including rootless state, cgroup manager, and version; Docker's `{{.Server.Version}}` probe is not a Podman capability check. Apply `keep-id` and the selected user to all container creation paths, request private cgroup namespaces and host networking, replace numeric UID equality with ownership probes, and initialize the pnpm volume under the same mapping. Verify resource enforcement during preflight and fail a configured rootless worker if the runtime is unavailable; never silently run its attempts as the shared SSH user.

Reuse the existing operations for start, exec, inspect, restart, cancellation, OOM recording, removal, and label-scoped sweeping. Validate their exact CLI output and errors against the selected runtime, preserving secrets on stdin and typed errors with structured worker/attempt logs. Update runtime-specific diagnostics and cleanup instructions. Amend ADRs 0011 and 0027 and the worker setup documentation when the implementation passes the acceptance tests; this research requires no executable changes.
