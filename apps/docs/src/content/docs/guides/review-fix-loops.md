---
title: Write review and fix loops
description: Write review, fix, and finishing loops whose rounds on one item stop at the cycle budget until you reset it.
sidebar:
  order: 4
---

A review loop and a fix loop can pass a pull request back and forth. Each loop's [`max_cycles`](/reference/configuration/loop-files/#max_cycles) (default 3) limits its runs on one item. When a loop reaches it, usine waits for you in **Needs attention** instead of opening another run, and you inspect the item and select **Reset cycle budget**. So the triggers don't need to count reviews.

## Review outcomes

Agents share the GitHub App's identity, which can't approve its own PR. So reviewers submit a `COMMENT` review on the reviewed head commit and set outcome labels:

| Outcome             | Add                     | Remove                                 |
| ------------------- | ----------------------- | -------------------------------------- |
| Actionable findings | `agent-review-findings` | `review-passed`, `ready-for-review`    |
| Clean review        | `review-passed`         | `agent-review-findings`, `ready-for-review` |
| Fix pushed          | `ready-for-review`      | `agent-review-findings`, `review-passed` |

Tell the reviewer to check that the PR still has the reviewed head before it posts or relabels, and to leave the PR queued for a new review if the head changed. A success label doesn't satisfy GitHub's required-review rule: you give any required approval and merge.

Set [`permissions: read`](/reference/configuration/loop-files/#permissions) on review loops so that the reviewer can't push to the branch. Tell the reviewer that if it breaks a rule, it reports its findings on the required commit and doesn't retry on a later head.

## Example loops

Declare `ready-for-review`, `agent-review-findings`, `review-passed`, and `ready-to-merge` in `labels`, and define the `reviewer` and `developer` agents. Add a `selector` if some repositories shouldn't use these loops.

```markdown title="loops/review-pr.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "ready-for-review")
approval: none
max_cycles: 3
permissions: read
step: review
agent: reviewer
---
Review PR #{{ item.number }} at {{ item.headRefOid }}. Fetch and check out
that exact head before reviewing. Remove ready-for-review when starting.
Submit a COMMENT review at that commit, with file and line references for
findings. Verify the head again before posting. If it changed, restore
ready-for-review and stop. Apply review outcome labels:
findings add agent-review-findings and remove review-passed; a clean review
adds review-passed and removes agent-review-findings. Do not merge.
```

The attempt starts at the head commit that the event recorded, `headRefOid`. The second head check detects a push during the review.

`loops/act-on-findings.md` uses `agent: developer`, `max_cycles: 3`, and this trigger:

```yaml title="loops/act-on-findings.md"
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

Its prompt tells the agent to check out `{{ item.headRefName }}`, fix the findings, run the checks, push, and apply the "Fix pushed" labels. If the agent can't fix them, it leaves the findings visible. A finding that needs your decision becomes a question, which costs one attempt and one round, not three ([Answer a question](/guides/operate-runs/#answer-a-question)).

`loops/finish-pr.md` runs only after a clean review:

```yaml title="loops/finish-pr.md"
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "review-passed")
```

Its prompt tells the agent to remove `review-passed`, run the finishing checks, and add `ready-to-merge` on success. You review and merge.

## Upgrade triggers that count reviews

If your triggers count reviews in CEL, remove the counts from the fix and finishing triggers, including any branch that starts finishing at three reviews: usine now waits for you when the budget runs out. After the database upgrade, existing completed runs count toward the first allowance, and the limit applies to queued item events when usine admits them.

See [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) for the persistence and identity decisions, and [GitHub's rules for required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).
