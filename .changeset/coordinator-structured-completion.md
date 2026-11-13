---
"@usine/agents": minor
"@usine/durable": minor
"@usine/server": minor
---

The event-driven coordinator decides a child's report without a reserved marker with a structured completion when the agent sets `decision`. The completion runs once on the agent's harness with the `decision` model and effort, on the attempt's worker and the child's credential route, with no tools and no saved conversation, and returns one decision: complete, replace the child, or fail the attempt. Its usage counts as a separate session of the attempt, including the usage of a failed completion. A refusal, an invalid answer, a usage limit, a timeout, or a replacement past the child-session budget completes the attempt with the report, as without `decision`, and logs the reason at Warning. An agent without `decision` and every other event keep their rule.

`@usine/agents` adds `workerAdmissionContext` to `/harness`, which returns the placement and credential route of a session of any role on a worker, and the platform-free `/harness/registry` subpath for `Harnesses`.
