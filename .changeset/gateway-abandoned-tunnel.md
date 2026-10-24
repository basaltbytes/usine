---
"@usine/gateway": patch
---

The forward proxy logs a tunnel that the client closes before sending a byte at info level, as `The client abandoned a tunnel before sending anything`, instead of as a `not-tls` warning. Non-ClientHello or truncated bytes are still refused.
