---
"@usine/agents": patch
---

Log a warning when a Codex thread item of a recognized tool kind does not decode, instead of skipping the item silently. Warnings for item notifications include the decoding cause; warnings for the in-progress turn of a resumed thread name the item type.
