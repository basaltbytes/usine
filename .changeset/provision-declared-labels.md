---
"@usine/config": patch
"@usine/expression": patch
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.
