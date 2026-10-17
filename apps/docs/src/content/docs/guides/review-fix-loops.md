---
title: Bounded review and fix Loops
description: Write review, fix, and finishing Loops whose rounds on one Item stop at the cycle budget until you reset it.
sidebar:
  order: 4
---

Each issue or pull request has a durable cycle budget. A Loop's `max_cycles` sets how many Runs it can open on that Item between operator resets; the default is three. Each Loop has its own count, so three review/fix rounds allow three reviews and three fixes. An Attempt retry uses the Run's existing reservation, and work canceled before its first Attempt gives its reservation back. Schedule Loops have no cycle budget.

When a Loop has used its limit, its next matching Event opens an Ask in **Needs you** instead of a Run. The Ask shows the Item, the Loops involved, the admitted Runs, and the completed rounds. While it's open, no Loop can open a Run on that Item, a finishing Loop included. Runs that already have a reservation can finish. Changing labels or restarting the process doesn't reset the budget.

After you inspect the Item, use **Reset cycle budget**. This starts a new allowance and requests a new poll; only active Loops that match the Item at that point can open work. A paused Loop stays paused. The Ask stays visible even when the Item's labels no longer match any Loop. Issue [#36](https://github.com/basaltbytes/usine/issues/36) tracks GitHub notifications and answers.

## Review outcomes

Agents that use the same GitHub App share its author identity, and GitHub doesn't allow that identity to approve its own PR. Submit a `COMMENT` review on the reviewed head commit, and use explicit outcome labels:

| Outcome             | Add                     | Remove                                 |
| ------------------- | ----------------------- | -------------------------------------- |
| Actionable findings | `agent-review-findings` | `review-passed`, `ready-for-review`    |
| Clean review        | `review-passed`         | `agent-review-findings`, `ready-for-review` |
| Fix pushed          | `ready-for-review`      | `agent-review-findings`, `review-passed` |

Before posting a result or changing outcome labels, verify that the PR still has the reviewed head. If the head changed, leave the PR queued for a new review. A success label records an Agent's result but doesn't satisfy GitHub's required-review rule. The operator gives any required independent approval and merges the PR.

## Authored example

Declare `ready-for-review`, `agent-review-findings`, `review-passed`, and `ready-to-merge` in `usine.yaml`'s `labels` list, and define the `reviewer` and `developer` Agents. Add a `selector` to these Loops if the instance manages repositories that shouldn't use them.

```markdown title="loops/review-pr.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "ready-for-review")
approval: none
max_cycles: 3
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

The Attempt of a pull request Run starts detached at the head commit that the Event recorded, so the review starts at `headRefOid`. The second head check detects a push made during the review.

`loops/act-on-findings.md` uses `agent: developer`, `max_cycles: 3`, and this trigger:

```yaml title="loops/act-on-findings.md"
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

Its prompt tells the Agent to check out the PR branch (`{{ item.headRefName }}`), fix the findings, run the repository checks, push, and apply the “Fix pushed” labels. If the Agent can't complete the fix, it must leave the findings visible.

`loops/finish-pr.md` runs only after a clean review:

```yaml title="loops/finish-pr.md"
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "review-passed")
```

Its prompt tells the Agent to remove `review-passed`, run the finishing checks, and add `ready-to-merge` on success so the operator can review the PR. The Agent doesn't merge it.

If you upgrade an instance whose triggers count reviewer reviews in CEL, remove those counts from both the fix and finishing triggers. In particular, remove the branch that starts finishing when the count reaches three: when the budget runs out, usine now waits for an operator decision. After the database upgrade, existing completed Runs count toward the first allowance, and the same limit applies to queued Item Events when usine admits them.

See [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) for persistence and identity decisions, and [GitHub's review rules](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews) for required approvals.
