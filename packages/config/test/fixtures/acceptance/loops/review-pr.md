---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" &&
    !item.isDraft &&
    !item.reviews.nodes.exists(review,
      review.author != null && review.author.login == "usine-reviewer" &&
      review.commit != null && review.commit.oid == item.headRefOid)
agent: reviewer
step: review
---
Review PR #{{ item.number }} at {{ item.headRefOid }}.
