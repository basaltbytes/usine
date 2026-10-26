---
"@usine/durable": patch
---

Fixes a forced stop that never exited after it released a running attempt ([#573](https://github.com/basaltbytes/usine/issues/573)). The attempt's Pi parent kept running until the durable harness closed. If it called `subagent` in that time, the call waited for an `execute` call to supply the child host, and no `execute` call follows in a stopping process. The harness close waits for every running call, so it never finished. An aborted `subagent` call now stops waiting and logs `Abandoning the child spawn of an aborted tool call`. The next start resumes the attempt, and the call ends as interrupted.
