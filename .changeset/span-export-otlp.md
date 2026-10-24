---
"@usine/config": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

`usine up` can export its spans over OTLP/HTTP. Add a `tracing` block with `otlp_url`, the collector's traces endpoint without credentials or a query string, and an optional `service_name` to `usine.yaml`. Without the block, no spans are exported. A reload refuses a changed `tracing` block with `RestartRequiredError`.
