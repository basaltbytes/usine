---
"@usine/core": patch
"@usine/run-host": patch
---

Collect pull request facts from GitHub using the Attempt's final commit and existing worker credentials. Encode PR and comment URLs as strings so facts survive the Attempt channel and durable storage.
