---
"@usine/github": patch
"@usine/server": patch
---

Request Workflows write permission for write-access attempts so they can push changes under `.github/workflows/`. The GitHub App setup requests the permission, and installation checks report a missing grant. Existing App installations must accept the permission update. Read-access tokens continue to omit Workflows.
