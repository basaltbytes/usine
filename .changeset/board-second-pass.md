---
"@usine/orchestrator": minor
"@usine/server": patch
---

Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.

On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
