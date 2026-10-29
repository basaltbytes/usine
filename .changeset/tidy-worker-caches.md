---
"@usine/executor": patch
---

Share a persistent Turborepo cache between attempt containers alongside the pnpm store. Derive each container's CPU limit from all host CPUs divided by `max_concurrent_attempts`, and pin Node.js 22 for the attempt image and new worker machines.
