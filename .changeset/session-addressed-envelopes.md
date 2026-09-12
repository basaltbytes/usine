---
"@usine/core": minor
"@usine/engine": minor
"@usine/agents": minor
"@usine/run-host": minor
"@usine/executor": patch
"@usine/orchestrator": patch
---

Add session-addressed inbound attempt-channel envelopes (protocol v5).

Inbound frames now carry a session target (the Pi parent by default, or a harness child by its id) and two new payloads, `OperatorMessage` and `Release`. The run host keeps a directory of the parent and each live child and routes a frame to the addressed session: a parent interrupt still ends the attempt, a child interrupt stops only that child, and steer or operator-message frames reach the target as user turns. Stored v3 and v4 transcripts remain readable.
