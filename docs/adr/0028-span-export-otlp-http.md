# Spans export over OTLP/HTTP when usine.yaml has a tracing block

`usine up` exports its spans with the OTLP tracer that ships in `effect` (`effect/unstable/observability`), as protobuf over HTTP to the `otlp_url` of a `tracing` block in `usine.yaml` ([#279](https://github.com/basaltbytes/usine/issues/279)). Without the block, it installs no exporter, and spans aren't exported, as before. The server builds the tracer after the instance folder loads and before the runtime, and provides it to everything that follows, so every runtime span is exported and the exporter flushes after the runtime closes. The tracer posts with the fetch HTTP client, so it needs no Node adapter.

OTLP is the vendor-neutral protocol that the OpenTelemetry Collector and most tracing backends accept, so one exporter reaches any of them through a collector, and `effect` already contains it, so usine adds no dependency. Effect's exporter speaks only HTTP. Protobuf is the default OTLP/HTTP encoding.

Export is off by default because it needs a collector that the operator runs, and because spans carry repository names, URLs, instance paths, and SQL text: nothing leaves the process until the operator names where it goes. A default URL would also log failed exports on every machine without a collector.

The setting is in `usine.yaml` because the instance folder is the committed, reproducible description of a factory, engine version included ([ADR 0019](./0019-npm-instance-pinned-first-run-onboarding.md)), and where its spans go is part of that deployment. `service_name` tells instances apart in a shared collector. The block is at the top level, not under `settings`: a reload applies `settings` to new work, but the tracer wraps the whole process once, so a changed `tracing` block needs a restart, like `webhooks`.

## Considered options

- **A file exporter** (JSON lines under `.usine/`): no collector to run, but usine would maintain the exporter, its rotation, and a way to read the file. Effect has none.
- **`OTEL_EXPORTER_OTLP_*` environment variables** (Effect's `OtlpTracer.layerFromConfig`): the OpenTelemetry convention, but the instance folder would no longer say where its spans go, and a reload couldn't detect a change.
- **`@effect/opentelemetry` with the OpenTelemetry SDK**: adds sampling, gRPC, and SDK processors, at the cost of a second tracing stack and its dependency tree for one exporter.
- **Vendor exporters**: a collector translates OTLP for any vendor.
- **Authentication headers in `usine.yaml`**: would put backend credentials in a committed file. A collector next to `usine up` holds them instead, so `otlp_url` rejects a username, password, or query string, where hosted collectors put tokens.
- **Headers from the `.usine/` secrets file**: keeps credentials out of git, but adds a second secret store format and its loading for what a local collector already does.

## Consequences

- Only spans are exported. Logs written inside a span reach the collector as span events; OTLP logs and metrics would extend the same block.
- `Server.serve` isn't a span: a span around the server, which never returns, would put every HTTP request in one trace.
- Each Run is a trace of its own. Its root span, `RunDriver.drive`, links to the span that launched the Run, such as a poll cycle or an approval request, so a trace holds one Run, even with an hours-long Attempt, and a poll cycle's trace ends with the cycle ([#508](https://github.com/basaltbytes/usine/issues/508)).
- The web UI sends no trace headers. Its spans reach no collector, so a header would give each request span a parent that no backend has. The server still accepts trace headers from other clients, such as a proxy that exports its own spans.
- The orchestrator's requests to GitHub and to the gateways' admin APIs send no trace headers either ([#520](https://github.com/basaltbytes/usine/issues/520)). Neither service exports spans to the operator's collector, so `traceparent` and `b3` would only hand usine's trace IDs to a third party. Each request still has a client span in the trace that sent it.
- A failed export request logs a warning. A failed export, after up to three retries, drops the buffered spans and pauses export for 60 seconds. Export never fails the orchestrator, and shutdown waits at most 3 seconds for the last batch.
- `OTEL_RESOURCE_ATTRIBUTES` in the environment of `usine up` adds resource attributes, the convention that collectors and SDKs share. `service_name` and the installed `@usine/server` version take precedence over it. A malformed value stops `usine up` from starting with a message that names the key, as a malformed `USINE_PORT` does; Effect's resource would end the process with a defect instead.
