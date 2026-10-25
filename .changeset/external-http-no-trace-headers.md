---
"@usine/orchestrator": patch
---

The orchestrator's requests to GitHub and to the gateways' admin APIs no longer send `traceparent` and `b3` headers. Neither service joins usine's traces, so the headers only exposed trace IDs. Each request still has a client span.
