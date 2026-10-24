---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

Adds `BoardMoves` to `@usine/engine/board-moves`, which records the operator's board moves in the new `usine_board_moves` table. `Operator.moveBoardItem` records each move before it sends the label swap, and `Operator.githubChanges` lists a matching label change as a `BoardMovedView`, so the run page shows it as the operator's move.

Moves made before this change still show as the agent's label changes.
