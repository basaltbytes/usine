---
"@usine/core": patch
---

`harvestFacts` asks the remote with `git ls-remote origin` whether a branch or pull request ref points at an Attempt's new final commit before it asks GitHub for that commit's pull requests. A commit that was never pushed has none, so it is recorded with no pull request and a debug log line, instead of the HTTP 422 from GitHub and two warnings. Other discovery failures still log a warning.
