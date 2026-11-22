---
"@usine/agents": minor
---

`RunningSession.steer` takes only the message and no longer accepts an `OperatorMessageId`. A Codex child sent a steer with an ID past its conversation, which never confirmed the read, so the child sent the steer again when the turn ended. Send operator messages with `RunningSession.intervene`. `ContinuationPolicy.recover` gives its `send` callback its own type.
