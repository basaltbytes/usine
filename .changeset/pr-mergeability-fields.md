---
"@usine/github": minor
"@usine/config": minor
"@usine/orchestrator": minor
"@usine/web": patch
---

Expose `mergeable` and `mergeStateStatus` on the pull request payload so `pr` trigger expressions and prompts can react to a conflicting branch, and mark conflicting pull requests on their board card.

Refresh known open pull requests on every poll, including unchanged issue-feed responses, so base changes and delayed mergeability computation update their Board and trigger Loops.
