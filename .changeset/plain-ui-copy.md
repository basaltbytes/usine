---
"@usine/server": patch
---

The web UI states facts in short plain words. The home page is **Overview**, with **Needs attention**, **Running**, **Stalled**, and **Recent runs**, and its heading counts read `2 running, 7 stalled`. A stall reason is a short fragment, such as `Canceled 2d ago, unchanged since`, `Failed 3h ago: Agent failure`, or `Waiting for a free worker slot`, on Overview and on Board cards. Run, item, loop, worker, agent, attempt, event, and task are lowercase inside sentences, so a Run reads `Running, attempt 2` or `Failed after 3 attempts`, and the menus say **Open run** and **Cancel run**. Needs attention titles read `start-dev: approval needed`, `Question from start-dev`, and `start-dev: blocked`, and connectivity warnings read `usine-worker-1 silent since 19:31:03` and `claude: provider unreachable, 3 retries since 19:31`.
