---
"@usine/server": patch
---

`usine up` opens its listener right after it takes the instance lock and keeps the port until it exits. Before, startup checked the port by listening on it and closing it again, and a connection accepted in that window was reset. When setup completes, the listener keeps the port and returns startup responses until the runtime routes are installed.
