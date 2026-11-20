---
"@usine/agents": minor
"@usine/config": minor
"@usine/core": minor
"@usine/durable": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A Claude Code child stops at its first request on usage credits. When a Claude subscription reaches its plan's usage limit and the account has usage credits turned on, Claude Code keeps working and bills the credits. A Claude Code child now stops at the first rate-limit report that says a request ran on usage credits, and the attempt ends with a capacity refusal: the run waits in its capacity group until the plan window resets, and **Needs attention** shows the reason. The report arrives after its request, so that request is already billed; other requests that Claude Code sent before usine closed the child can be billed too.

The new instance setting `settings.allow_usage_credits`, `false` by default, lets Claude Code children keep working on usage credits instead. An attempt applies the value that it started with, and the supervisor keeps working on usage credits. **Configuration > Settings** shows and edits the setting.
