---
"@usine/agents": minor
---

`ChildRequest` carries the child's complete environment. Claude Code, the Codex app server, and the Pi child's bash tool run with exactly that environment instead of inheriting the launching process's.

`@usine/agents/pi/authentication` exports the Pi parent's model and pool rules (`splitPiModel`, `piAuthentication`, `requiredPiPool`, `resolvePiPool`) for parent runtimes outside this package.
