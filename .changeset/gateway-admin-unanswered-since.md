---
"@usine/executor": patch
---

A gateway admin request that gets no answer through an open forward fails with `the admin API through <gateway> has not answered since <time>: no answer (TransportError)`, and the retry warning includes `unansweredSince`. The next answered request clears the time.
