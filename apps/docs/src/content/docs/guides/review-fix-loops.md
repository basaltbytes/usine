---
title: Connect review and fix loops
description: Route pull requests between review and fixes, with CI completion handled by usine.
---

Connect a review loop and a fix loop using GitHub labels, and let usine wait for CI after fixes.

## Prerequisites

Instance admin access, a project, `reviewer` and `developer` agents, repository CI, and declared labels `ready-for-review`, `agent-review-findings`, and `review-passed`. The App needs **Actions: read-only** for failed job logs and for workflow runs on private repositories. usine doesn't rerun workflows, so the App doesn't need **Actions: read and write**.

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

Replace `review-passed` with `ready-to-merge` if that is your loop's success label. usine verifies that the review attempt added one of the configured labels to the pull request. The label counts even after the fix loop removes `agent-review-findings` to start its run; a verdict label left from an earlier review doesn't count. If the attempt added neither label, the attempt and run fail in **Needs attention** with a missing-outcome diagnostic. A success message alone cannot satisfy this requirement. Existing loops use an empty list until you configure their verdict labels.

If your review task restores `ready-for-review` and stops without a verdict when the head changes during the review, list the trigger label too. Otherwise that run fails in **Needs attention**, even though the next review picks up the new head:

```yaml
outcome_labels: [review-passed, agent-review-findings, ready-for-review]
```

Leave the fix loop's `outcome_labels` empty. Its handoff adds `ready-for-review` through `on_green` after CI passes, but usine checks outcome labels when the agent ends, before the CI wait starts.

## Check the result

A finding starts the fix loop. After its push, the agent session ends and frees its worker slot while the run shows **Waiting for CI**. Green checks on the recorded head apply the completion labels and start review again. Failed checks start the configured fix loop with bounded evidence; inherited completion actions continue through subsequent fixes.

For failed GitHub Actions checks, the fix attempt receives the failed job names and a bounded excerpt of failed-step logs. If the run archive is unavailable while other jobs are running, usine reads the completed job's log. If those logs are unavailable, it uses the check output.

## CI outcomes

The handoff must match the pull request number and the checkout's pushed head, and the pull request must be open. usine verifies that the pull request's source branch on origin points at that head, so a delayed pull request API update does not reject a valid push. A repository that was renamed still matches, because usine compares repository IDs. Other open pull requests from the same repository at that head stay in the attempt's results. When the PR head lags behind its branch, CI remains pending until the PR catches up; checks on the older head cannot complete the wait. A plain success from a loop with a CI policy also waits, with no additional label actions; usine verifies the open pull request of the checkout's branch the same way. An unchanged detached checkout from a branch or tag revision fails as an agent failure, so CI cannot complete the attempt through an unrelated pull request. For a changed detached checkout or a fixed commit revision, usine queries branches on origin that point at the checkout's head. If only pull request refs point at that head, usine reads those pull requests by number and keeps the open ones whose head on GitHub is the checkout's head. When one candidate can't be read, usine uses the open pull requests of the others. If verification fails, the attempt fails with the reason in its message. A head that differs from the checkout, a pull request that doesn't exist, is closed or merged, or comes from another repository, and a branch that isn't at the pushed head are agent failures. The message says whether the pull request is closed or merged. A GitHub read that still fails or returns invalid output after two retries, a failed `git` read, and verification that takes longer than 10 seconds are retryable infrastructure failures. The stored policy determines the timeout and fix loop. A newer push cancels the old wait. When a person merges or closes the pull request before CI passes, the wait ends at once with no completion labels and no fix, and the run isn't an agent failure. A merged pull request ends the wait as passed. A pull request closed without a merge cancels the run, which isn't retried and counts as canceled in statistics. Reopening the pull request doesn't restart the wait; the loop's trigger starts a new run. If CI on a merged pull request's head is green when usine sees it, for example because the operator merged it between two polls, the wait passes and applies its completion labels. A newer push to a closed pull request's branch cancels the wait as superseded. Restarts resume stored CI waits without an agent.

Missing checks remain pending until the deadline. A timeout appears in **Needs attention** as an infrastructure failure. At the deadline, usine first reads the latest run of each workflow on the recorded head. When GitHub Actions left a workflow run `queued` or `in_progress`, such as during an Actions stall that keeps new runs queued with no jobs, the message says that Actions didn't finish the run and names each run with its status, ID, and link. It gives the two ways out: push a commit to start new runs, or rerun the named runs once GitHub allows it. In either case, the message lists pending job names and elapsed running times when GitHub provides them, so you can tell a stalled run from a slow or hung job. Running jobs come first; the diagnostic lists up to ten jobs and states how many more are pending. When no check run is pending, it lists pending legacy commit statuses instead. With **Actions: read-only** access, the diagnostic also includes each running job's duration in the last successful run of the same workflow and event. A slow or rate-limited duration lookup omits the remaining durations and keeps the job list. The timeout leaves completion labels unchanged, isn't retried automatically, and requires operator attention. When the recorded head has no checks and GitHub reports `CONFLICTING`, usine starts the configured fix loop with instructions to merge the base branch, resolve conflicts, run local checks, and push. The fix inherits pending completion actions. Mergeability `UNKNOWN` continues waiting.

Before it applies completion labels or starts a fix, usine reads the latest run of each workflow on the recorded head. GitHub Actions sometimes creates only some of a run's jobs, or leaves some jobs queued, and still concludes the run `failure`. A run that ended this way didn't run CI in full, and its wait ends in **Needs attention** as an infrastructure failure in either of these cases:

- The run concluded `failure` or `cancelled` with no failed job.
- The run's only failed job failed while other jobs of the run were still queued. This covers a gate job, such as a job that `needs` the others and checks their results, which fails because the jobs it needs never ran.

The message names each workflow run with its ID and link, and the failed job with the jobs that didn't finish. usine applies no completion labels and starts no fix, because a developer can't repair an Actions scheduling failure. Rerun the named workflow runs once GitHub allows it, for example with `gh run rerun <id>`, or push a commit to start new ones. While a run is still going, a lone failed job beside queued jobs keeps the wait pending, because the queued jobs can still start; if they're still queued at the CI deadline, the wait ends the same way. Any other failed job or failed commit status on the same head starts the configured fix loop right away, even while other workflow runs on the head are still running. usine matches the failed job by its Actions job ID, so a failed job with the same name in another workflow run still starts the fix loop. A failed job from an earlier attempt of a workflow run that is running again, such as a rerun that hasn't created that job yet, keeps the wait pending. Without a failed job, a workflow run that hasn't concluded keeps the wait pending, even when its last job already finished and the checks read green, and the CI deadline still applies. When GitHub refuses the workflow-run read, usine uses the check state alone.

### Apply the completion labels after a rerun

A run whose CI wait ended because CI on its head didn't finish keeps the wait's completion labels. This covers a timeout with a workflow run that hadn't concluded and CI that ran only in part. The run's entry in **Needs attention** offers **Apply CI labels**. After you rerun the workflow runs and CI on the same head passes, select it. usine checks that the pull request is still at the recorded head, that its checks read green, and that every workflow run on that head concluded in full. It then applies the recorded label changes and marks the failure resolved. While CI on the head hasn't passed, usine applies no labels and the entry shows why. After a push to the pull request, the recorded head can't pass anymore; the loops' triggers handle the new head, so mark the failure resolved instead. A pull request closed without a merge gets no completion labels, as when it closes during the wait; mark the failure resolved instead. Members with operate access can apply the labels, and the operator API exposes the action as `POST /api/runs/{runId}/apply-ci-labels`.

Attempt tokens don't grant Actions write access, so agents can't rerun workflows. A task that finds missing or canceled CI jobs records the run IDs on the pull request as a blocker for the operator instead of attempting a rerun.

The fix loop must be active, use the pull request stream, and select the repository. Its approval requirement and cycle budget at the time the fix run opens apply. A queued CI fix remains eligible while the pull request is open at the recorded head and has failed checks or a merge conflict with no checks. If GitHub temporarily reports mergeability as `UNKNOWN` with no checks during admission, the queued fix remains eligible. A GitHub read error or a five-second recheck timeout keeps the fix queued, and the next reconciliation, within three minutes, rechecks it. Accepted CI fixes close their source run as **Handed off** and link to the fix run.

An exhausted cycle budget requires an operator reset in the overview. After the reset, the next poll admits the blocked CI fix when its head and CI recheck allows it, even when the previous run removed `agent-review-findings`. The fix retains its prompt, failure diagnostics, and completion actions across restarts. When its run opens, the fix takes the approval requirement, agent, models, permissions, CI policy, outcome labels, and `max_cycles` from the fix loop's current configuration. The generated CI handoff instructions also follow the current CI policy. Setting `approval: required` before the reset makes the fix wait for approval. Approval expressions use the payload saved with the CI fix event. The failed source run stays in **Needs attention** and links to the newest admitted fix run that has not been canceled or revoked.

CI fixes bypass the fix loop's `if:` expression. On an open pull request, a trigger mismatch preserves queued CI fixes and runs that have not started an attempt only for the same head with failed checks, or with no checks and mergeability `CONFLICTING` or `UNKNOWN`. Removing a trigger label, converting the pull request to draft, or adding a label excluded by `if:` does not stop these fixes. On that poll, a newer push or checks that stop failing causes revocation. When `if:` rejects a closed or merged pull request, polling revokes all its queued events and unstarted runs; missing pull requests also revoke both. Started attempts continue.

Open cycle-budget asks and operator suppressions keep queued CI fixes waiting until they are cleared. A trigger mismatch clears the loop's suppression, including one caused by an unanswered operator question, so a subsequent reconciliation can admit the saved fix. Pause the fix loop to keep queued fixes waiting regardless of labels or `if:` changes. Resuming the loop rechecks them right away. When a CI fix and a trigger match wait for the same loop and pull request, events are rechecked from newest to oldest. A CI fix that does not match is revoked on its own before the next event is rechecked. A trigger mismatch revokes the queued trigger matches together and preserves CI fixes for their own rechecks. The first matching event opens the next run and supersedes older events. A missing pull request revokes the entire queued group. Loops without a CI policy require their agents to wait for checks before applying completion labels.

GitHub does not run pull request workflows on conflicting branches. Writer tasks must resolve the conflict and push a checked tree. A clean agent review leaves any required independent approval and merge to you.
