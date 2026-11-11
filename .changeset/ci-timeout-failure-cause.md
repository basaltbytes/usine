---
"@usine/core": patch
"@usine/engine": patch
"@usine/server": patch
---

A CI wait that times out or ends with partly run CI records an `InfraFailure` whose `cause` holds the CI resolution, pull request number, and head, instead of a copy of the message. The `InfraFailure` reference now states that these CI failures aren't retried automatically.
