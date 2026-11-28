---
"@usine/agents": patch
"@usine/executor": patch
---

OpenCode starts in a Docker or Podman attempt container that mounts the shared pnpm store (#1450).

- `@usine/agents`: OpenCode sessions, the `opencode --version` check, and the model check keep OpenCode's data, configuration, state, and cache directories in the session's data directory or a temporary directory, never in the home directory. A version check that exits with a code other than 126 or 127 fails with its exit code instead of an installation check, and the **Harness prerequisite check failed** log entry has the exit code and the end of the command's error output. `hostOutput` and `probeOutput` return the command's trimmed `stderr`.
- `@usine/executor`: the attempt image gives the `usine` user `~/.local`, `~/.local/share`, `~/.local/state`, and every parent of the shared cache mounts, which the runtime would otherwise create as root. The image's tag ends with the first 12 hexadecimal digits of the SHA-256 digest of the image's files, so a worker that has the earlier image pulls the new one: `ghcr.io/basaltbytes/usine-worker:claude-2.1.311-codex-0.172.0-opencode-2.3.2-68d8c89ccdaa`.
