---
"@usine/server": minor
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
---

Require a member session or instance token for operator API requests, including requests from loopback. Add GitHub browser and device sign-in, one-time setup links, local admin tokens, member management, token revocation, and browser CSRF checks. Attribute operator actions and configuration revisions to the signed-in member. Convert stored GitHub ask approvals to the UI channel while preserving their approvers.

Existing instances must configure GitHub App user authorization to use GitHub sign-in. Run `usine sign-in-link` on the instance machine for access before those settings are configured.
