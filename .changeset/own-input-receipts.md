---
"@usine/agents": patch
---

Codex and Pi children no longer report an operator message read when the harness records the child's own input with the same text, such as its task or a continuation message. The session's own inputs take those records first, so an operator message that repeats the task stays queued, and Codex sends it again with the next turn if the turn ends without reading it.
