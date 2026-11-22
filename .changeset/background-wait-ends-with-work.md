---
"@usine/agents": minor
"@usine/core": patch
"@usine/server": patch
---

A child that answered while its background work ran no longer waits without end after that work ends. When a snapshot lists no work and no turn starts within five minutes, the child returns its answer, and its `SessionFinished` event doesn't set `backgroundWaitLimitPassed`. A turn that starts within the five minutes runs to its own answer, and work that runs again keeps the child waiting. With `settings.max_background_wait_minutes` set, the limit sets `backgroundWaitLimitPassed` only if work still runs when it passes. An operator Hold or pause keeps the answer for a Release, as it does at the limit.

Codex and Pi children drop their own inputs, such as the task, that a turn didn't record when the turn ends. An operator message that repeats the task is then read at its own record in a later turn, and Codex no longer sends it again.

The run page shows no "No background work" note for a session whose first snapshot is empty, and a snapshot during a run of tool calls follows the run instead of splitting it.
