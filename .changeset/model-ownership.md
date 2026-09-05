---
"@usine/expression": minor
"@usine/config": patch
"@usine/github": patch
"@usine/orchestrator": patch
---

Import expression schemas, environment descriptors, and typed errors from
`@usine/expression/expression-engine`. This replaces the `/model` entry point;
update existing `/model` imports to `/expression-engine`.

Organize GitHub authentication, access, polling, and operator view contracts by
responsibility while preserving their existing public entry points and schemas.
