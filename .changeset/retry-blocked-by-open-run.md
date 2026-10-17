---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

An operator retry of a Failed Run, plain or edited, fails with `RunRetryBlockedError` while another Run of the same Loop and Item is open, so one Loop never has two open Runs on one Item. The error names the open Run; the operator API returns it with status 409 and the web UI shows its message.
