---
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
"@usine/github": patch
---

Verify explicit CI handoffs against the pushed origin branch when GitHub's pull request head is stale. Keep CI pending until the PR head catches up, and classify unverified handoffs as retryable infrastructure failures.
