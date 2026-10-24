---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
