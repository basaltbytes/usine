---
"@usine/agents": patch
---

A control request that Claude Code cancels no longer holds back the output checkpoint of a remote Claude child. A turn result logs the subtype of each control request that is still unanswered. Claude stdout lines also end at a lone carriage return, as in the Claude Agent SDK.
