---
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "ready") &&
    !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
selector:
  repos: [basaltbytes/usine]
  tags: [active]
approval: required
step: implement
agent: developer
---
Implement issue #{{ item.number }}: {{ item.title }}
