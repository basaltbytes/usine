---
"@usine/core": minor
"@usine/engine": minor
"@usine/agents": minor
"@usine/run-host": minor
"@usine/executor": patch
"@usine/orchestrator": patch
---

Add operator takeover, session pause and resume, and edit-and-retry.

Protocol v5 addresses guidance to the Pi parent or a live child. Pause waits at a tool boundary; a message resumes the same session. Messaging a child holds its result until release. Cancel stops the whole Attempt. Messages and delivery receipts identify the operator in the transcript, and stored v3 and v4 transcripts remain readable.

Failed Runs can retry with an amended task and roster agent. Later Attempts retain those amendments and record their effective task, agent, and intervention flag. The Run drawer exposes these controls for parent and child conversations, including held children outside the loaded history page. Holds pause the elapsed-time budget while the token ceiling remains active.
