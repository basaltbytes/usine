---
"@usine/core": minor
"@usine/durable": minor
"@usine/engine": minor
"@usine/server": minor
---

An attempt's channel no longer needs a Pi parent session to start. `Started.parentModel` is an `Option`: it names the selected Pi parent model, or is `None` for an attempt without a parent session, and a stored `Started` envelope without the key decodes as `None`. The durable relay sends `Started` once the attempt's task records `started` on its durable record, then the Worker notices kept before the start, then session events. A Pi-parent attempt sends the same envelopes in the same order as before. A `Started` without a model clears the attempt's recorded parent model, and the run page's attempt details show **No parent session**. In the operator API, the `parentModel` of a `Started` payload is `null` for an attempt without a parent session.
