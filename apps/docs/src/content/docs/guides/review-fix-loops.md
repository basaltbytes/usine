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

## Conflicts and CI

GitHub does not run `pull_request` workflows for a conflicting pull request. Before reviewing or pushing, query the live `headRefOid`, `baseRefName`, and `mergeable` with `gh pr view`. If mergeability is `UNKNOWN`, wait briefly and query again.

A read-only reviewer returns a `COMMENT` finding on the expected head that requests a merge from the base branch, adds `agent-review-findings`, and removes `review-passed` and `ready-for-review`. It reviews the diff only after a writer resolves the conflict and CI passes on the resulting head. It checks mergeability again before posting a clean review, because the base can change during review.

Fixing and finishing agents fetch and merge the actual base branch when the PR conflicts, resolve conflicts within the issue and review findings, rerun the repository gate, and push. They wait for CI on the pushed head before changing outcome labels. If a push has no checks, they recheck mergeability and repeat recovery if the base changed again. An empty checks list alone is not a blocker, and manually dispatching CI does not repair the conflict. If resolution needs a decision the issue and findings do not cover, the agent posts the exact conflict, question, and options on the PR and returns `[usine:question]` with the outcome labels unchanged.

Keep `rebase-pr` limited to conflicting PRs labeled `ready-to-merge`. Adding `ready-for-review` would allow both the rebase and review loops to match the same item. The reviewer's conflict finding gives the existing fix loop responsibility for recovery; the finishing agent handles conflicts after a clean review. This keeps the review loop read-only and avoids spending a separate rebase round before review.

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
Before posting any review or changing outcome labels, verify the head
again. If it changed, restore ready-for-review and stop.
Check live mergeable before reading the diff and again before posting a
clean review; retry UNKNOWN. For CONFLICTING, return a COMMENT finding on
the expected head requesting a merge from the base branch and CI on the
new head. Apply the findings labels below and stop without reviewing the
diff. Review a resolved PR only after CI passes on the expected head.
Submit a COMMENT review at that commit, with file and line references for
findings. Apply review outcome labels:
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

Use the complete [fixing prompt](/reference/configuration/loop-files/#more-examples), including the mergeability check before pushing and the CI watch before applying the "Fix pushed" labels. If the agent can't fix a finding, it leaves it visible. A finding that needs your decision becomes a question, which costs one attempt and one round, not three ([Answer a question](/guides/operate-runs/#answer-a-question)).

`loops/finish-pr.md` runs only after a clean review:

```markdown title="loops/finish-pr.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" && !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "review-passed")
approval: none
step: finish
agent: developer
---
Finish PR #{{ item.number }} using the repository's finish-pr skill.
Fetch and verify {{ item.headRefOid }}, then check out {{ item.headRefName }}.
If the head changed, report the mismatch and stop before editing.
Resolve the findings and inspect the final diff. Before pushing, query
live mergeable and baseRefName; retry UNKNOWN. For CONFLICTING, fetch and
merge the base branch, resolve conflicts within the issue and findings,
then run the gate, commit, and push. If resolution needs an operator
decision, post the exact conflict, question, and options on the PR, leave
outcome labels unchanged, and return [usine:question] on the first line.
Wait for CI on the pushed head in the foreground. If no checks appear,
recheck mergeability and repeat recovery for a new conflict. An empty
checks list alone is not a blocker; inspect workflow triggers and runs.
After CI passes, verify the PR still has that head, record the result,
remove review-passed and agent-review-findings, and add ready-to-merge.
Do not merge the pull request.
```

The finishing agent changes outcome labels only after CI passes on the final head. You review and merge.

## Upgrade triggers that count reviews

If your triggers count reviews in CEL, remove the counts from the fix and finishing triggers, including any branch that starts finishing at three reviews: usine now waits for you when the budget runs out. After the database upgrade, existing completed runs count toward the first allowance, and the limit applies to queued item events when usine admits them.

See [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) for the persistence and identity decisions, and [GitHub's rules for required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).
