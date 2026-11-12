# Spans export over OTLP/HTTP when tracing is configured

`usine up` exports spans with the OTLP tracer in `effect`, as protobuf over HTTP, to `tracing.otlp_url` in the instance settings. A change applies at the next restart, because the tracer wraps the whole process. OTLP reaches any backend through a collector, and `effect` already contains the exporter.

- **Off by default.** Spans carry repository names, URLs, paths, and SQL statements, so nothing leaves the process until the operator names a collector.
- **No credentials.** `otlp_url` refuses a username, password, or query string. A collector next to the server holds the backend's credentials, which keeps them out of configuration revisions.
- **One trace per run.** A run's root span links to the span that launched it, so a trace holds one run, even when an attempt lasts hours.
- **No outgoing trace headers.** The web UI and the server's requests to GitHub and gateways send none. Their spans reach no collector of the operator's, so a header would only point at spans that no backend holds.

## Considered options

- **A file exporter**: usine would maintain its rotation and a reader.
- **`OTEL_EXPORTER_OTLP_*` variables**: the configuration would no longer show where spans go.
- **The OpenTelemetry SDK**: a second tracing stack for one exporter.
