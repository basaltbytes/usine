---
"@usine/agents": patch
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/gateway": patch
"@usine/orchestrator": minor
---

Run Attempts on SSH Workers behind a Gateway, with no GitHub token on the Worker's machine (ADR 0027).

`@usine/core/worker`: `GatewayDomain` and `GatewayLlmProvider`.

`@usine/config/factory`: an `ssh` Worker takes an optional `gateway` with `domain`, `destination` (the Gateway's SSH destination), `admin_port` (the admin API's port on the Gateway, 7070 by default), `admin_token_env` (the environment variable that contains the admin token; the token never goes in the file), and `llm_providers` (`[anthropic]` when the Gateway holds the Anthropic credential).

`@usine/executor/ssh`: for a Worker behind a Gateway, prepare attaches the Attempt's single-repository token to the Gateway's admin API instead of writing it on the machine, renewal replaces the token on the same attachment, the same request stores it again every two minutes so a restarted Gateway has it back, and cleanup detaches it after the checkout is cleaned up; the first use of a Worker by a process detaches what an earlier process left. Each admin request gives up after 30 seconds. The checkout clones from `http://git.<domain>/`, and children, harvesting, and git get the environment that points git, gh, package managers, and Claude Code (with `anthropic`) at the Gateway. The caller token reaches the machine through the SSH connection (`SendEnv` of `GIT_CONFIG_VALUE_0`, `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`), never in a command line or a file. Preflight also checks the admin API, that the Worker's sshd accepts those variables, and that the Worker reaches `git.<domain>`; a gap is a `WorkerCapabilityError` with the new `gateway` capability. Behind a Gateway, preflight checks only the `claude` binary when the Gateway holds the Anthropic credential, and refuses a Claude brain otherwise and a Codex brain always, since neither would have a route to its provider. The layer now requires an `HttpClient`. `RemoteAccess` gains `shell`, the child host for the Attempt's commands and children, and `RemoteWorker.repositoryUrl` takes the machine. `renewableCredential` hands `publish` the whole `WorkerCredential` and returns what the first publish returned.

`@usine/agents/child-host`: `RemoteShell.sshEnvironment` documents that variables named in an `-o SendEnv=` option reach the child.

`@usine/gateway/admin` also exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER` for clients.

`@usine/orchestrator/ssh`: `sshWorkerAddressesOf(config)` reads each Gateway's admin token from its environment variable at startup and fails with the variable's name when it is unset; the SSH composition calls admin APIs with `fetch`. `usine up` runs Attempts on SSH Workers behind a Gateway.
