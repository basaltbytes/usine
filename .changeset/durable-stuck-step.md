---
"@usine/durable": patch
---

`DurableHarness` logs the first report of each pi-durable failure, then the repeat count at most every five seconds. After 1,000 reports of one failure with no commit, the harness reopens the storage; if it gets stuck again within a minute, it stops and running attempts fail with an `InfraFailure`. `HarnessListener` adds `onStop`.
