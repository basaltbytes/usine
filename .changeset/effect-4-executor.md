---
"@usine/executor": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). `WorkerCredential.value` still keeps the `Redacted` token that the `CredentialProvider` issued, so releasing an attempt's checkout wipes that token, and `Redacted.value` on it throws. Effect 4.0's `Schema.Redacted` would store a copy, which left the issued token readable after the release.
