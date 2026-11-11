---
"@usine/agents": patch
---

`reportedOutcome` treats a quoted blocker or question marker as ordinary text. A marker inside a fenced code block, including one indented under a list item, inside a string literal such as `"[usine:blocked]\nmsg"` or a quoted string that spans lines, such as `The child answered "[usine:blocked]` followed by a line break, or after a space in a sentence, such as "The child returned [usine:blocked]", no longer fails the session. A marker at the start of a line, or appended directly to narration at the end of a line, still produces `AgentBlockedError` or `AgentQuestionError`. The same rule applies to child sessions.
