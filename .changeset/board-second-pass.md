---
"@usine/orchestrator": minor
"@usine/server": patch
---

On the Board, a card whose Item is on the desk's Not moving list carries the desk's reason and the one action that moves it again. The arrow between two authored lanes names the Loops whose trigger matches a Task of the left lane, with or without an open Run, and says when one is paused. A lane without a Task collapses to a narrow column that still takes a drop. Done and Unmapped leave the lane row for header toggles with their counts, and **Show all Items** brings back the Tasks no Loop can match, which the Board hides by default unless they carry a lane label, have an open Run, or need the operator.

`BoardTaskView.loops` names the Loops whose trigger matches one of the Task's Items now, evaluated by `LoopMatches` as the poll evaluates a changed Item, paused Loops included. `OperatorObservation.layer` now provides `LoopMatches` to the overview, and the overview's cache also follows each Loop's trigger and selector and each repository's tags.
