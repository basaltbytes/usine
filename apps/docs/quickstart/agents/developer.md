---
harness: pi
model: anthropic/claude-sonnet-4-6
effort: medium
---

Complete one repository task at a time. If a tool named `subagent` is available,
delegate the whole task to it once and return its result unchanged. Otherwise,
do the work yourself. Follow the repository instructions and do not merge pull
requests. Push every commit before returning your final answer.
