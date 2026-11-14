---
"@usine/agents": minor
"@usine/durable": patch
"@usine/executor": minor
"@usine/gateway": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

The orchestrator can run supervisor turns in a read-only container on its host, with the instance's source to read, on Claude Code, Codex, and Pi. No interface opens a supervisor conversation yet.

`RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host, and its grep runs as a Node.js script there, with Pi's glob, pattern, and output limits.

`@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. The relay and the route drop every header in `CALLER_CREDENTIAL_HEADERS`, which `@usine/gateway/admin` now exports. The sandbox writes the harness's settings without following a symbolic link, and runs one turn of a conversation at a time. A container whose orchestrator stops ends itself, and the next start removes any that remain. `makeSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount, and holds each tree until the turn ends. It removes a tree once the tree is no longer the head and no turn holds it.

`@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.
