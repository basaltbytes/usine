---
"@usine/orchestrator": minor
"@usine/server": patch
---

The Board keeps a card in the lane its running Run was triggered from. While a Task's newest open Run is `Running` and its current Item is open, the card goes to the first label lane that matches the labels the Item had when that Run's trigger matched, read from the Run's Event. A Loop that removes its trigger label as its first step, such as `review-pr` removing `ready-for-review`, no longer sends its card to a state lane such as Pull requests while it runs; when the Run ends, the card follows the labels the Item has then. A Run that has not started, an Item that is merged or closed, and a trigger whose labels route to no lane place the card by its current Item as before. The Task page names the same lane, and a Board move records the lane the card showed in as the lane it left.

`projectBoard` takes the running Runs' Events as an optional last argument. `Operator.overview`, `Operator.task`, and `Operator.moveBoardItem` read them with `RunReader.events`; `Operator.moveBoardItem` also reads the Items' Runs, so its error type includes `RunStoreError`.
