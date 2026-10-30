---
"@usine/config": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Order waiting runs with integer CEL priority expressions over item labels and other stream fields. Priorities default to zero and sort highest first, followed by lane rank and event arrival. Failed evaluations log a warning and use zero. Overview and wait and lease logs show the evaluated value; loop checks and previews validate and evaluate expressions.

Scheduler layers now require `ExpressionEngine`.

Queue positions now include priority and lane together. Loop preview items and Overview’s queued-run responses include the evaluated priority.
