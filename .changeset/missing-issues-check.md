---
"@usine/github": patch
---

`GitHubPolling.missingIssues(repository, numbers)` returns the issue numbers the repository no longer has, asking GitHub in one GraphQL request per 50 numbers.
