---
trigger:
  on: issue
  if: item.labels.nodes.exists(label, label.nmae == "ready")
agent: developer
---
This loop is intentionally quarantined without blocking its siblings.
