---
"@usine/core": patch
---

`harvestFacts` runs `git ls-remote origin` to check whether a ref points at the attempt's new final commit before it asks GitHub for the commit's pull requests. An unpushed commit is recorded with no pull request and a debug log line, instead of an HTTP 422 and two warnings.
