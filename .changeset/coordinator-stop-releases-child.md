---
"@usine/durable": patch
---

When a process stop interrupts an event-driven coordinator's `execute` call, the call now detaches before its child stops, and the child's harness leaves its session to resume after the restart, as it does for a Pi parent's children. A Claude Code child's turn is interrupted first; a Codex child is detached without a turn interrupt. The stop waits up to 10 seconds for the child. When a cancel or a failed sink ends the call, the child still stops without a resume. Previously the coordinator closed a Claude Code child without interrupting its turn and ended a Codex child's app server.
