---
"@usine/core": minor
"@usine/agents": minor
"@usine/server": patch
---

A session reports its background work, the work that runs independently of its current turn, with the session event `BackgroundWorkUpdated` in `@usine/core/agent/session`. Each event replaces the previous snapshot: `work` lists each `BackgroundWork` with its ID, kind (`command`, `agent`, or `other`), and description, an empty list means that nothing runs, and an event without `work` means that the harness doesn't report it. Claude Code children report each change to their background tasks, without ambient watchers, and report the work as not reported after a process restart until the new process lists its tasks. Codex and Pi children report no background work. The operator API's transcript reads return the event.

The wait for background work after an answer, and `settings.max_background_wait_minutes`, now apply in the conversation that every harness adapter shares, so any harness that reports its background work gets the same wait and the same limit. The wait behaves as before for Claude Code children. Its log lines name the session instead of the harness, and name the remaining work in `backgroundWorkIds`.

The run page shows each change to a session's background work as a note, and a warning note when a session returned its answer because its background work outlasted the wait limit.
