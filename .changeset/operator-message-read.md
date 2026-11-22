---
"@usine/core": minor
"@usine/agents": minor
"@usine/server": patch
---

A session reports each operator message that it reads with the session event `OperatorMessageRead`, which names the message's `OperatorMessageId` and sits in the transcript where the harness reported the read: at once for a message that starts or joins a turn, or at the harness's receipt for a queued one. The operator API's transcript reads return it; the web app's transcript doesn't show it. `OperatorMessageId` moves to `@usine/core/agent/session`; `@usine/core/attempt/channel` still exports it.

The Claude Code, Codex, and Pi adapters share one implementation of receipt matching: each decodes its harness's signals into receipts that name messages by ID, by recorded text, or by count, and the shared conversation decides which messages the session read.
