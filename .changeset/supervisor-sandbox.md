---
"@usine/agents": minor
"@usine/durable": patch
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

The supervisor runs in a read-only container on the orchestrator host and reads the instance's source, on Claude Code, Codex, and Pi.

`RoleSpec.nativeTools` is `none`, `read`, or `all`. A role that keeps only `read` tools gets Claude Code's `Read`, `Grep`, and `Glob`, or Pi's `read`, `grep`, `find`, and `ls`. A harness that can't turn its own tools off keeps them all, and `AdmittedBrain.ownToolsKept` and `HarnessPresentation.ownTools` carry the descriptor's reason. The supervisor role keeps `read` tools, so it no longer requires `closed-tools`, and Codex serves it. On an exec shell host, Pi runs its read and search tools' file operations on that host.

`@usine/agents/supervisor` exports the `SupervisorSandbox` port: `open` starts the sandbox of one turn and returns the seat that the turn runs on, with each `SupervisorSource` under the seat's directory, and `unavailable` says why sessions can't run. `@usine/executor/supervisor` provides it as one Podman or Docker container per turn, with no network, the sources and the session's directory read-only, and no instance file but the conversation's own directory. A relay forwards the harness's model requests to the orchestrator, which sends them through the instance's gateway model route with the instance's credential. `prepareSupervisorSources` exports each repository's default branch head, without its history, for the sandbox to mount.

`@usine/orchestrator/parent-models` exports `instanceModelRoute`. The orchestrator provides the container sandbox, with the attempt image and the instance's gateway route. On a host without Podman or Docker, or an instance without a gateway, the instance starts, logs `The configured supervisor is unavailable on this orchestrator` with the reason, and `SettingsView.supervisor.unavailable` carries it. `SettingsView.supervisor.ownTools` says when the supervisor's harness keeps all its own tools. **Configuration > Settings** and the settings form show both.
