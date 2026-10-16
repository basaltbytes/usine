---
title: Bounded review and fix Loops
description: Write review, fix, and finishing Loops whose rounds on one Item stop at the cycle budget until you reset it.
sidebar:
  order: 4
---

Each issue or pull request has a durable cycle budget. A Loop's `max_cycles`
limits how many Runs it may open on that Item between operator resets; the default
is three. Three review/fix rounds allow three reviews and three fixes. Attempt
retries use the same reservation, and work canceled before its first Attempt
returns its reservation. Schedule Loops are exempt.

The next admission beyond a Loop's limit opens an Ask in **Needs you**. It shows
the Item, participating Loops, admitted Runs, and completed rounds. The Ask blocks
further Runs on that Item across all Loops, including a finishing Loop. Runs that
already hold reservations may finish. Labels and process restarts do not reset it.

Use **Reset cycle budget** after inspecting the Item. This grants another allowance
and requests fresh polling; only currently matching, active Loops can open work.
A paused Loop stays paused. The Ask remains visible even when the Item's labels no
longer match any Loop. GitHub notifications and answers are tracked in
[#36](https://github.com/basaltbytes/usine/issues/36).

## Review outcomes

Agents using one GitHub App share its author identity. GitHub does not allow that
identity to approve its own PR. Submit a `COMMENT` review tied to the reviewed head
commit and use explicit outcome labels:

| Outcome | Add | Remove |
| --- | --- | --- |
| Actionable findings | `agent-review-findings` | `review-passed`, `ready-for-review` |
| Clean review | `review-passed` | `agent-review-findings`, `ready-for-review` |
| Fix pushed | `ready-for-review` | `agent-review-findings`, `review-passed` |

Before posting a result or changing outcome labels, verify that the PR still has
the reviewed head. If it changed, leave it queued for a fresh review. A success
label records an agent's finding; it does not satisfy GitHub's required-review
rule. The operator supplies any required independent approval and merges.

## Authored example

Declare `ready-for-review`, `agent-review-findings`, `review-passed`, and
`ready-to-merge` in `usine.yaml`'s `labels` list, and define the `reviewer` and
`developer` Agents. Scope these Loops with a `selector` when the instance manages
repositories that should not participate.

`loops/review-pr.md`:

```markdown
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

`loops/act-on-findings.md` uses `agent: developer`, `max_cycles: 3`, and this trigger:

```yaml
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

Its prompt fixes the findings on the PR branch, runs the repository checks, pushes,
and applies the “Fix pushed” labels. It must leave findings visible when it cannot
complete the fix.

`loops/finish-pr.md` runs only after a clean review:

```yaml
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "review-passed")
```

Its prompt removes `review-passed`, performs the finishing checks, and sets
`ready-to-merge` on success for operator review. It does not merge automatically.

When upgrading an instance that counts reviewer reviews in CEL, remove those
counts from both the fix and finishing triggers. In particular, remove the branch
that starts finishing when the count reaches three: exhaustion now stops for an
operator decision. Existing completed Runs count toward the initial allowance after the database
upgrade; queued Item Events are subject to the same limit when admitted.

See [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) for persistence
and identity decisions, and [GitHub's review rules](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
for required approvals.
