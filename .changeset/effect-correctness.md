---
"@usine/agents": patch
"@usine/cloudflare": minor
"@usine/durable": minor
"@usine/engine": minor
"@usine/executor": patch
"@usine/gateway": minor
"@usine/github": minor
"@usine/orchestrator": patch
"@usine/server": patch
"create-usine": patch
---

Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.

Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
