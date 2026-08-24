---
trigger:
  on: pr
  if: >-
    item.reviewThreads.nodes.exists(thread, !thread.isResolved) ||
    item.reviewDecision == "CHANGES_REQUESTED"
agent: developer
---
Act on the unresolved review findings for PR #{{ item.number }}.
