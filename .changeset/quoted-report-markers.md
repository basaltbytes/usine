---
"@usine/agents": patch
---

`reportedOutcome` treats a quoted blocker or question marker as ordinary text. A marker inside a fenced code block, inside a string literal such as `"[usine:blocked]\nmsg"`, or after a space in a sentence, such as "The child returned [usine:blocked]", no longer fails the session. A marker at the start of a line, or appended directly to narration at the end of a line, still produces `AgentBlockedError` or `AgentQuestionError`. The same rule applies to child sessions.
