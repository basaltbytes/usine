---
"@usine/core": minor
"@usine/agents": minor
"@usine/durable": patch
"@usine/server": patch
---

Share child continuation policy across Claude Code, Codex, Pi, and durable restart. Native resume reopens a conversation without sending input. Working children receive one continuation and unread guidance; supervised children wait. Persist a limit of three continuation turns per ten minutes and close interrupted tool calls with errors.

Assign Claude session UUIDs before the first prompt and give operator messages stable UUIDs. Acknowledge guidance by native message IDs so identical messages have separate delivery receipts, and use Claude's pending-send count only for results without UUID receipts. Send the task to a retained Claude process that never acknowledged its prompt. A restored child keeps its unread messages until its call ends. Preserve unread Codex guidance across turn boundaries and active-turn reattachment. Failed resume returns interrupted without spending another child-session slot, and a replacement clears the previous child's infrastructure failure.
