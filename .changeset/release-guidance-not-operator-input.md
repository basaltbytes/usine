---
"@usine/durable": patch
---

A released parent's answer to the release guidance no longer counts as an answer to the operator, so `AttemptReport.answeredOperator` is false and the Attempt is judged on its harvest and final answer like any other.
