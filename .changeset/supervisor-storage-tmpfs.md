---
"@usine/core": minor
"@usine/agents": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Supervisor turns run under the documented systemd unit, which sets `NoNewPrivileges=yes`, on a host with only Docker or Podman. The harness's home is now an in-memory filesystem of `supervisor_limits.conversation_size_mib` in each turn's container, and usine keeps each conversation's saved home on the orchestrator as an archive at `.usine/supervisor/homes/<sha256>.tar`. usine copies the archive into the container before the harness starts, and copies the home back when the turn ends, up to `conversation_size_mib`. A save that fails or exceeds the limit keeps the previous archive and fails the turn with the reason. Pi's session files on the orchestrator are checked against the same limit before and after each turn. Conversation storage no longer needs FUSE, `fuse2fs`, `fusermount`, `e2fsprogs`, `fallocate`, `/dev/fuse`, or `user_allow_other`.

`conversation_size_mib` now defaults to 128. The home and `/tmp` count against `memory_mib`, and together they may use at most half of it; otherwise usine refuses turns and names the settings.

Startup runs a check in the background: a container with a turn's limits and in-memory home, into which usine copies a small home and back out. **Configuration > Settings** and `GET /api/conversations/status` report the supervisor as ready only after the check passes, and give the reason while it runs or after it fails. Under `NoNewPrivileges`, rootless Podman is reported as unable to run, because it needs the setuid helpers `newuidmap` and `newgidmap`.

Startup removes the ext4 conversation images of earlier `next` versions with their directories and logs one line for each. The next turn of such a conversation starts a new harness session.
