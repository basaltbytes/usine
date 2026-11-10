---
"@usine/orchestrator": minor
"@usine/server": minor
---

Compare models per agent by task outcome. `GET /api/statistics` returns `agents`: for each agent that ran an attempt on a task done in the window, the harness and model of the agent's first attempt on each task, with the tasks merged, mixed tasks, tasks right the first time, median review rounds, median time from first attempt to merge, and median tokens and price per task with all loops summed. The agent page and the Statistics section show the comparison.
