---
"@usine/server": patch
---

Log lines start with an ISO 8601 timestamp in UTC, such as `[2026-10-27T02:25:13.123Z]`, instead of the local time of day ([#603](https://github.com/basaltbytes/usine/issues/603)). The local time had no date or offset and depended on the time zone that the process resolved, so after the change from summer time on 2026-10-25, a long-running orchestrator's log read one hour ahead of the machine's clock. Span events still go to the tracer.
