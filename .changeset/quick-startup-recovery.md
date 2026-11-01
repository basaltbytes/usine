---
"@usine/server": patch
"@usine/engine": patch
"@usine/executor": patch
---

Serve the version endpoint before startup recovery so instances with long attempt histories pass upgrade health checks. Cache SSH checkout listings per connection, avoid connection records for finished attempts without checkouts, and log reconciliation progress at Info.
