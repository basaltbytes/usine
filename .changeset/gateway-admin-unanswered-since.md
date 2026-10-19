---
"@usine/executor": patch
---

A Gateway admin request that gets no answer through an open forward fails with a message that says since when the admin API has answered no request, `the admin API through <gateway> has not answered since <time>: no answer (TransportError)`, and the retry warning has `unansweredSince`. The time is kept per Gateway and cleared by the next answered request, so a stopped `usine-gateway` service no longer logs the same warning every 30 seconds with no start time.
