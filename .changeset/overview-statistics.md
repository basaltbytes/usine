---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

The operator API adds `GET /api/statistics?window=7d|30d|all` (30 days by default), which computes from the stored runs, their usage, and the stored items how the factory ran in the window: closed runs by outcome, loop, agent, and harness, model, and effort; run and attempt time with median and 90th percentile beside the mean; tokens per pool and the cost of priced runs; runs closed per day; first-pass merges and lead time to merge; queue wait, attempts per run, and slot use per worker; and Needs attention entries with their waits. `RunReader.closedSince` reads the runs closed since a time.

The overview ends with a Statistics section that shows these as figures and charts, with a switch between 7 days, 30 days, and all runs.
