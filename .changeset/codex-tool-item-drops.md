---
"@usine/agents": patch
---

Log a warning when a Codex thread item of a recognized tool kind does not decode, instead of skipping the item silently. The warning includes the decoding cause and the item type, for item notifications and for the in-progress turn of a resumed thread. Log at Info when an item notification of a kind other than a tool or a message is skipped, with its item type.
