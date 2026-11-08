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

Set the review loop's `outcome_labels` in its text editor to its two verdict labels:

```yaml
outcome_labels: [review-passed, agent-review-findings]
```

Replace `review-passed` with `ready-to-merge` if that is your loop's success label. usine verifies that the pull request has at least one configured label when the agent completes. If neither is present, the attempt and run fail in **Needs attention** with a missing-outcome diagnostic. A success message alone cannot satisfy this requirement. Existing loops use an empty list until you configure their verdict labels.

## Check the result

A finding starts the fix loop. After its push, the agent session ends and frees its worker slot while the run shows **Waiting for CI**. Green checks on the recorded head apply the completion labels and start review again. Failed checks start the configured fix loop with bounded evidence; inherited completion actions continue through subsequent fixes.

For failed GitHub Actions checks, the fix attempt receives the failed job names and a bounded excerpt of failed-step logs. If the run archive is unavailable while other jobs are running, usine reads the completed job's log. If those logs are unavailable, it uses the check output.

## CI outcomes

The handoff must match the pull request number and the checkout's pushed head. usine verifies that the pull request's source branch on origin points at that head, so a delayed pull request API update does not reject a valid push. When the PR head lags behind its branch, CI remains pending until the PR catches up; checks on the older head cannot complete the wait. An unverified handoff records a retryable infrastructure failure. The stored policy determines the timeout and fix loop. A plain success from a loop with a CI policy also waits, with no additional label actions. A newer push cancels the old wait. Restarts resume stored CI waits without an agent.

Missing checks remain pending until the deadline. A timeout appears in **Needs attention** as an infrastructure failure, with pending job names and elapsed running times when GitHub provides them. With **Actions: read-only** access, the diagnostic also includes each job's duration in the last successful workflow run. The timeout leaves completion labels unchanged and requires operator attention. When the recorded head has no checks and GitHub reports `CONFLICTING`, usine starts the configured fix loop with instructions to merge the base branch, resolve conflicts, run local checks, and push. The fix inherits pending completion actions. Mergeability `UNKNOWN` continues waiting.

The fix loop must be active, use the pull request stream, and select the repository. Its recorded approval requirement and cycle budget apply. A queued CI fix remains eligible while the pull request is open at the recorded head and has failed checks or a merge conflict with no checks. If GitHub temporarily reports mergeability as `UNKNOWN` with no checks during admission, the queued fix remains eligible. A GitHub read error or a five-second recheck timeout also permits admission using the saved event. Accepted CI fixes close their source run as **Handed off** and link to the fix run.

An exhausted cycle budget requires an operator reset in the overview. After the reset, the next poll admits the blocked CI fix when its head and CI recheck allows it, even when the previous run removed `agent-review-findings`. The fix retains its task, failure diagnostics, and completion actions across restarts. It also uses the approval decision, agent, model, parent model, permissions, CI policy, and `max_cycles` saved when the CI fix event was created. Changing `approval` to `required` before resetting does not add an approval gate to that saved event. Review the saved settings before resetting; fresh trigger events use the current loop configuration.

CI fixes bypass the fix loop's `if:` expression. On an open pull request, a trigger mismatch preserves queued CI fixes and runs that have not started an attempt only for the same head with failed checks, or with no checks and mergeability `CONFLICTING` or `UNKNOWN`. Removing a trigger label, converting the pull request to draft, or adding a label excluded by `if:` does not stop these fixes. On that poll, a newer push or checks that stop failing causes revocation. When `if:` rejects a closed or merged pull request, polling revokes all its queued events and unstarted runs; missing pull requests also revoke both. Started attempts continue.

Open cycle-budget asks and operator suppressions keep queued CI fixes waiting until they are cleared. A trigger mismatch clears the loop's suppression, including one caused by an unanswered operator question, so a subsequent reconciliation can admit the saved fix. Pause the fix loop to keep queued fixes waiting regardless of labels or `if:` changes; they become eligible again after the loop resumes. Loops without a CI policy require their agents to wait for checks before applying completion labels.

GitHub does not run pull request workflows on conflicting branches. Writer tasks must resolve the conflict and push a checked tree. A clean agent review leaves any required independent approval and merge to you.
