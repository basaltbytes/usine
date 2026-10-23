---
"@usine/core": patch
"@usine/agents": patch
"@usine/durable": patch
"@usine/engine": patch
"@usine/orchestrator": patch
---

An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.

The loop then holds the item: the next item state returns the new `Held` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` ends the hold.
