---
"@usine/core": patch
"@usine/agents": patch
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": patch
---

An Agent asks the operator for a decision by opening its final answer with `[usine:question]`, followed by the question; the prompt asks it to post the question on the Item first. The Attempt ends with the new `QuestionFailure`, which never retries automatically, and Needs you shows the question. A child's question reaches the parent like a blocker, as `AgentQuestionError`, and fails the Attempt with `QuestionFailure` when the parent does not relay it.

The Loop then holds the Item: the first state after the question, usually the Agent's own comment, returns the new `Held` submission result and opens no Run, and the Item's queued Events wait. Another change to the Item, a sighting that does not match, a retry, or marking the question answered with `RunEngine.resolveFailure` ends the hold; marking it answered also gives the newest queued Event its turn.
