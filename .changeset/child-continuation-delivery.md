---
"@usine/agents": patch
"@usine/durable": patch
---

Child recovery delivers the task and operator messages once. A held or paused child whose saved conversation holds no task receives the original task. A remote Claude Code child that loses its process before its owner acknowledges the task receives the task again, not the continuation instruction. Codex recovery reports unread guidance that the saved thread's last turn records as read instead of resending it, and a recorded message that acknowledged earlier guidance with the same text doesn't count again after an orchestrator restart, and concurrent guidance never starts a second Codex turn. A Pi recovery steer that Pi handles at once is reported as read. A failed native reopen keeps its error as the cause of the `SessionInterruptedError`. When a restored `subagent` call fails before it restores its child's operator messages, the parent's delivery pass settles them as soon as the call returns.
