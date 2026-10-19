---
"@usine/gateway": patch
---

The forward proxy logs a tunnel the client closes before sending any byte at info level as `The client abandoned a tunnel before sending anything`, instead of a `not-tls` refusal at warning level. Bytes that are not a TLS ClientHello, or a ClientHello cut short, are still refused as `not-tls`.
