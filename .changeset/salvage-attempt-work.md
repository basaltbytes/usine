---
"@usine/core": minor
"@usine/executor": minor
"@usine/engine": minor
"@usine/agents": minor
"@usine/orchestrator": minor
"@usine/config": minor
"@usine/server": minor
"@usine/web": patch
---

Salvage an Attempt's unfinished work before its worktree is removed: when an Attempt ends without success, the executor commits uncommitted changes and pushes HEAD to `usine/salvage/<run>/<attempt>`, records the ref on the Attempt, shows it in the run drawer, and checks it out for the next retry with a preamble line telling the agent to continue.

Make `max_attempt_minutes` and `max_attempt_tokens` opt-in with no default: an absent setting leaves that half of the runaway guard unarmed, and an armed ceiling steers the parent session once at 80% of its limit before tripping. Attempt channel protocol version 7.

Count consumed tokens as output plus uncached input for Codex, Claude, and Pi, so the meter no longer grows with the conversation's re-read context. Stored protocol-v6 transcripts stay readable after the bump.

Retain work on salvage inspection or snapshot failure, reconcile retained and crashed Attempts at startup before workflow recovery, and renew local credentials and exe.dev grants throughout an Attempt.
