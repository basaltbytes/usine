---
"@usine/agents": patch
"@usine/durable": patch
---

Child recovery avoids resending a saved task or operator messages already reported as read. A held or paused child whose saved conversation holds no task receives the original task. A remote Claude Code child that loses its process before its owner acknowledges the task receives the task again, not the continuation instruction. Codex recovery reports unread guidance that the saved thread's last turn records as read instead of resending it, and previously observed user-message items don't count again after an orchestrator restart. Concurrent guidance never starts a second Codex turn. A Pi recovery steer that Pi handles at once is reported as read. A failed native reopen keeps its error as the cause of the `SessionInterruptedError`. When a restored `subagent` call fails before it restores its child's operator messages, the parent's delivery pass settles them as soon as the call returns.
