---
"@usine/durable": patch
"@usine/server": patch
---

Install Pi's HTTP dispatcher before opening the first parent harness. Server requests use proxy-aware HTTP/1.1 connections with five-minute stream timeouts, and interrupted response streams reject without an unhandled dispatcher error terminating the process.
