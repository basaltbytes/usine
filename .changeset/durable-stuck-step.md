---
"@usine/durable": patch
---

`DurableHarness` logs the first report of each pi-durable failure, then the number of repeats at most once every five seconds, instead of one line per report. A failure reported 1,000 times with no commit in between means pi-durable keeps retrying a step that cannot succeed: the harness closes at once and reopens the storage. If the reopened harness gets stuck again within a minute, the harness stops, logs the cause, and fails every later call with it, so running Attempts fail with an `InfraFailure` instead of the process running out of memory. `HarnessListener` gains `onStop`.
