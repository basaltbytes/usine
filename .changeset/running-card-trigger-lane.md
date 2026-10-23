---
"@usine/orchestrator": minor
"@usine/server": patch
---

While a task's newest open run is `Running` and its item is open, the board keeps its card in the first label lane that matches the item's labels when the trigger matched. A loop that removes its trigger label first, such as `review-pr` removing `ready-for-review`, no longer moves its card to a state lane while it runs.

`projectBoard` takes the running runs' events as an optional last argument, and the error type of `Operator.moveBoardItem` includes `RunStoreError`.
