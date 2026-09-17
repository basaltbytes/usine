---
"@usine/executor": patch
---

Cancel Attempts during preparation and process startup, release acquired resources, and prevent launch after cancellation. Preserve the live channel cancellation handshake for local and exe.dev Workers.
