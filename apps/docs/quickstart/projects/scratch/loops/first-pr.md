---
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
    !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
approval: required
agent: developer
---

Complete issue #{{ item.number }}: {{ item.title }}.

First remove `ready-for-agent` from the issue with `gh issue edit`.
Create a branch, make the requested README change, commit it, and push it.
Open a non-draft pull request whose body includes `Closes #{{ item.number }}`.
Do not merge it. Return the pull request URL.
