---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

`@usine/engine/board-moves` adds `BoardMoves`, which keeps the operator's Board moves: the repository, the Item, when the move was sent, the source and destination lanes, and the labels added and removed. A migration adds the `usine_board_moves` table, and the local SQLite layers provide the service.

`Operator.moveBoardItem` records each move before it sends the label swap to GitHub; a move that cannot be recorded is not sent. `Operator.githubChanges` takes a label change that a recorded move made out of the Attempt's changes and lists the move instead as `BoardMovedView`, with its lanes, in the Attempt at work when the operator made it. A change matches a move when the move sent the same label the same way and GitHub recorded it from 1 second before the second the move was recorded until 10 seconds after it.

The Run page shows such a move as the operator's, with its time: "You moved it from Review to Findings on the Board". Moves made before this change were not recorded and still show as the Agent's label changes.
