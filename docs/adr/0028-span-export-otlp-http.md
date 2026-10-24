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
- **Authentication headers in `usine.yaml`**: would put backend credentials in a committed file. A collector next to `usine up` holds them instead.

## Consequences

- Only spans are exported. Logs written inside a span reach the collector as span events; OTLP logs and metrics would extend the same block.
- `Server.serve` isn't a span: a span around the server, which never returns, would put every HTTP request in one trace.
- A Run's spans are in the trace of the poll cycle that submitted it.
- A failed export request logs a warning. A failed export, after up to three retries, drops the buffered spans and pauses export for 60 seconds. Export never fails the orchestrator, and shutdown waits at most 3 seconds for the last batch.
- `OTEL_RESOURCE_ATTRIBUTES` in the environment of `usine up` adds resource attributes, because Effect's resource reads it. `service_name` and the installed `@usine/server` version take precedence over it.
