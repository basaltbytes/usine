---
"@usine/agents": patch
---

Save the remote child's output checkpoint when the worker doesn't acknowledge pending input within 4 seconds of a detach, instead of skipping it. The worker relay now ignores an input line cut off by a dropped connection and exits normally. If the worker cannot identify the process that holds the child, it stops that process and exits instead of leaving the child unsupervised.
