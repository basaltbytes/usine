---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Each run is now a trace of its own: its root span, `RunDriver.drive`, links to the span that launched the run, such as a poll cycle or an approval request. The **Settings** configuration page shows the `tracing` block, and a reload refused for a changed `tracing` block links to it. A malformed `OTEL_RESOURCE_ATTRIBUTES` now stops `usine up` with a message that names the key, instead of crashing it. The web UI no longer sends trace headers.
