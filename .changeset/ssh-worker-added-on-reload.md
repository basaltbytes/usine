---
"@usine/orchestrator": patch
---

A reload adds an SSH Worker: it joins the executor before its preflight with its Gateway's admin token read then, an unset token variable refuses the reload, and a removed SSH Worker leaves the executor once its last Attempt ends.
