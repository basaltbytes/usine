---
title: Connect review and fix loops
description: Route pull requests between review and fixes, with CI completion handled by usine.
---

Connect a review loop and a fix loop using GitHub labels, and let usine wait for CI after fixes.

## Prerequisites

Instance admin access, a project, `reviewer` and `developer` agents, repository CI, and declared labels `ready-for-review`, `agent-review-findings`, and `review-passed`. The App needs **Actions: read-only** for failed job logs.

## Procedure

1. Create a `review-pr` loop for the project with stream `pr`, agent `reviewer`, and permissions `read`. Use this condition:

   ```cel
   item.state == "OPEN" && !item.isDraft &&
   item.labels.nodes.exists(label, label.name == "ready-for-review")
   ```

2. In the review task, require the agent to fetch and verify `{{ item.headRefOid }}`, review that commit, and check the live head again before posting. Require a `COMMENT` review and these outcomes:

   | Result | Add | Remove |
   | --- | --- | --- |
   | Findings | `agent-review-findings` | `review-passed`, `ready-for-review` |
   | Clean review | `review-passed` | `agent-review-findings`, `ready-for-review` |

   The App identity is shared, so an agent review does not provide an independent GitHub approval. Require the reviewer to report merge conflicts as findings and leave resolution to a writer.

3. Create an `act-on-findings` loop with stream `pr`, agent `developer`, and permissions `write`. Its condition selects open, non-draft pull requests labeled `agent-review-findings`. Require its task to check out `{{ item.headRefName }}`, fix each finding, check live mergeability, merge the base branch if needed, run local checks, and push. A conflict requiring an operator decision becomes `[usine:question]` on the pull request.
4. Set the fix loop's CI policy to `fix_loop` equal to `widgets/act-on-findings` and `timeout_seconds` equal to `1800`, using your project ID. Use **Edit as text** for fields unavailable in the form; [Import and export format](/reference/configuration/import-export/#loop-markdown) describes the editor syntax. Keep a finite `max_cycles`, such as `3`, on both loops.
5. Require the fix agent to end after pushing with the following handoff, substituting the actual pull request and full pushed SHA. It must leave completion labels for usine:

   ```text
   [usine:awaiting-ci]
   {"pull_request":123,"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fix_loop":"widgets/act-on-findings","timeout_seconds":1800,"on_green":[{"item":123,"add":["ready-for-review"],"remove":["agent-review-findings","review-passed"]}]}
   ```

6. Save and resume both loops. Add `ready-for-review` to a test pull request with passing checks.

## Check the result

A finding starts the fix loop. After its push, the agent session ends and frees its worker slot while the run shows **Waiting for CI**. Green checks on the recorded head apply the completion labels and start review again. Failed checks start the configured fix loop with bounded evidence; inherited completion actions continue through subsequent fixes.

## CI outcomes

The handoff must match the harvested pull request and pushed head. The stored policy determines the timeout and fix loop. A plain success from a loop with a CI policy also waits, with no additional label actions. A newer push cancels the old wait. Restarts resume stored CI waits without an agent.

Missing checks remain pending until the deadline; a timeout appears in **Needs attention**. When the recorded head has no checks and GitHub reports `CONFLICTING`, usine starts the configured fix loop with instructions to merge the base branch, resolve conflicts, run local checks, and push. The fix inherits pending completion actions. Mergeability `UNKNOWN` continues waiting.

The fix loop must be active, use the pull request stream, and select the repository. Its approval and cycle budget still apply. Accepted CI fixes close their source run as **Handed off** and link to the fix run. An exhausted cycle budget requires an operator reset. Loops without a CI policy require their agents to wait for checks before applying completion labels.

GitHub does not run pull request workflows on conflicting branches. Writer tasks must resolve the conflict and push a checked tree. A clean agent review leaves any required independent approval and merge to you.
