---
"@usine/durable": patch
---

When a process stop interrupts an event-driven coordinator's `execute` call, the call now detaches before its child stops. The coordinator then interrupts the child's turn, and the child's harness leaves its session to resume after the restart, as it does for a Pi parent's children. Previously the coordinator closed a Claude Code child without interrupting its turn and ended a Codex child's app server.
