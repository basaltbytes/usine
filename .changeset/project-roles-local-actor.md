---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Add project roles and revisioned role bindings, enforce API permissions, and filter project data by access. Add token permission ceilings and controls for bindings and token scopes. Attribute local API writes and configuration CLI revisions to local admin. Existing members retain instance admin access through a one-time migration.

Authorize run actions and cycle-budget resets against the repository’s current project, including after a repository moves. Refresh the configuration revision after writes and stale-revision failures so later writes use the current revision.
