---
"@usine/core": minor
"@usine/server": minor
---

`@usine/core/agent/session` adds `RoleSession`, a session identity with a kebab-case `RoleName` and an optional parent ID, as a third `AgentSession` member. It identifies a session that a role opens through the harness seam outside the parent and child tree. Stored parent and child sessions decode unchanged. The operator API's session schemas accept the new member; no session records it yet.
