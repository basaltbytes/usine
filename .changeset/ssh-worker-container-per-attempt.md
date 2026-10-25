---
"@usine/executor": minor
"@usine/config": minor
"@usine/agents": patch
"@usine/core": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

An SSH worker whose machine has Docker runs each attempt in its own container, so attempts on one machine can't read each other's checkouts, tokens, caller tokens, or processes.

- The container runs the image that `workers[].container.image` names in `usine.yaml`, or `ghcr.io/basaltbytes/usine-worker` at the harness versions of the release (`ATTEMPT_IMAGE` in `@usine/executor/ssh`). `cpus` (default 2), `memory_mib` (default 4096), and `pids` (default 4096) limit each container.
- It mounts only the attempt's checkout read-write, and its cached clone, credential directory, and the SSH user's harness login files read-only. It uses the machine's network and gets the attempt's variables, secrets included, on `docker run`'s standard input.
- Every command for the attempt runs in it with `docker exec`: the children, git in the checkout, the harvest, the salvage, the pre-push hook, and the attempt's harness check. The checkout is a repository of its own that reads the cached clone's objects through an alternate.
- The container is removed with the checkout. Before a process starts its first container on a worker, it removes the containers that earlier processes of the instance left on that machine.
- Preflight checks Docker, pulls the image, checks the image's user ID, and probes the harnesses in a container from the image. A machine without Docker runs attempts as the SSH user, and preflight reports the worker as degraded in the log, on the Workers page, and on the desk.

`Executor.preflight` returns a `PreflightReport`, `SshExecutorOptions` takes the `instance` label, `SshWorkerAddress` takes `container`, and `RemoteShell` takes an optional `container` that wraps each command line in `docker exec`. `infra/worker-image/Dockerfile` defines the image, and cloud-init installs Docker.
