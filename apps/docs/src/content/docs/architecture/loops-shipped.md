---
title: "The dogfood instance's Loops"
description: "The five Loops and three Agents of the dogfood instance, with their labels."
sidebar:
  order: 6
---

:::note
This page describes commit `c56246f` of basaltbytes/usine and the dogfood instance as they were on 2026-10-16.
:::
usine has no built-in Loop. The engine runs whatever `loops/*.md` the instance folder contains ([ADR 0001](https://github.com/basaltbytes/usine/blob/main/docs/adr/0001-loops-live-in-the-instance-repo.md)). This repository has Loop files only as parser test fixtures (`packages/config/test/fixtures/acceptance/loops/`) and as an example in [`docs/guides/review-fix-loops.md`](https://github.com/basaltbytes/usine/blob/main/docs/guides/review-fix-loops.md). The Loops below are those of the dogfood instance at `~/Code/usine-factory`, read on 2026-10-16 and not changed. That folder is outside this repository, so its files can differ from this page after that date.

## The instance

`~/Code/usine-factory/usine.yaml` registers one repository, `basaltbytes/usine` with tag `dogfood`, and maps its Board lanes to labels: Ready (`ready-for-agent`), In progress (`agent-in-progress`), Review (`ready-for-review`), Findings (`agent-review-findings`), Passed (`review-passed`), Merge (`ready-to-merge`), Pull requests (state `pr-open`), and Done (states `pr-merged`, `pr-closed`, `issue-closed`). It has no `labels` list, so the orchestrator creates no label and logs a warning for each lane and trigger label it does not declare (`packages/config/src/parser.ts:256`).

Settings: `poll_interval: 60`, `parent_model: openai-codex/gpt-5.6-terra` (the ChatGPT plan pool), `parent_effort: medium`, no ceilings. One Worker, `usine-worker-1`, of kind `ssh` with `max_concurrent_attempts: 1`, behind the Gateway with domain `gw.internal` and the admin API on the local forward `http://127.0.0.1:7070`. Webhooks are off and the operator login is `PhilDL`.

| Agent | Harness | Model | Effort | Persona in short |
| --- | --- | --- | --- | --- |
| `developer` | codex | `gpt-6-astra` | medium | One task at a time; when a tool called `subagent` exists, delegate the whole task to it once; run the required checks; record blockers. |
| `reviewer` | codex | `gpt-6-astra` | high | Delegate the whole review to one child; grade each observation P0 to P3; only P0, P1, and P2 are findings, with file and line references; P3 goes in one ungraded comment. |
| `finisher` | claude | `claude-fable-5-1` | xhigh | Finish one pull request with the repository's `finish-pr` skill, inside the PR's scope, without merging; delegate the whole task to one child. |

## The Loops

Every Loop has `selector: { repos: [basaltbytes/usine] }` and no `max_cycles`, so each may open three Runs per Item between resets ([`run-lifecycle.md`](/architecture/run-lifecycle/)). The engine changes no label itself: every label change below is an instruction in the Loop's prompt, which the agent performs with `gh`.

| Loop | Stream | Fires when | Approval | Step | Agent |
| --- | --- | --- | --- | --- | --- |
| `start-dev` | issue | open, has `ready-for-agent`, and no open pull request in `closedByPullRequestsReferences` | `required` | `implement` | developer |
| `review-pr` | pr | open, not draft, has `ready-for-review`, has neither `review-passed` nor `ready-to-merge` | `none` | `review` | reviewer |
| `act-on-findings` | pr | open, has `agent-review-findings`, fewer than three reviews whose body contains `usine agent: reviewer` | `none` | `act-on-findings` | developer |
| `finish-pr` | pr | open, not draft, no `ready-to-merge`, and either `review-passed` or `agent-review-findings` with three or more reviewer reviews | `none` | `finish` | finisher |
| `rebase-pr` | pr | open, not draft, `mergeable == "CONFLICTING"`, has `ready-to-merge` | `none` | `rebase` | finisher |

### start-dev

The task asks the developer to complete issue #N with the repository's `tackle-issue` skill. Before editing, it removes `ready-for-agent` from the issue and adds `agent-in-progress`. It opens a non-draft pull request whose body closes the issue and does not merge it. When the pull request is ready, it removes `agent-in-progress` and adds `ready-for-review` to the pull request. A blocker becomes a comment on the issue. This is the only Loop with `approval: required`: each Run waits in `Waiting` until the operator approves it in the Run drawer, which is how the instance's README says to start work.

### review-pr

The reviewer removes `ready-for-review`, reviews the pull request with the repository's `code-review` skill, and posts the review. With actionable findings it adds `agent-review-findings`. Without, it makes sure `agent-review-findings` is absent and adds `review-passed`. It must not edit the branch; #226 records one review Run that pushed a commit anyway.

The prompt says the Attempt starts from the default branch, and `act-on-findings` has the same sentence. In the code, the checkout of a pr Run is the pull request's head commit (`packages/orchestrator/src/polling/loop-evaluation.ts:78`), so the prompt's fetch of `refs/pull/<n>/head` and its check against `headRefOid` end at the commit already checked out.

### act-on-findings

The developer removes `agent-review-findings`, checks out the pull request branch after the same head check, and fixes each finding graded P0, P1, or P2 in reviews signed `usine agent: reviewer`. It runs the checks, pushes to the branch, replies to each finding, and adds `ready-for-review`, which sends the pull request back to `review-pr`. #241 records that an Attempt that ends on an operator question is repeated until the cycle budget is spent.

### finish-pr

The finisher runs the repository's `finish-pr` skill on the current head. When the branch is green and pushed and the outcome is recorded, it removes `review-passed` and `agent-review-findings` and adds `ready-to-merge`. On a blocker it records the blocker and leaves the labels. #242 records that a `finish-pr` commit on the local Worker was authored as the operator rather than the App.

### rebase-pr

When GitHub reports a `ready-to-merge` pull request as conflicting, the finisher merges `origin/<base>` into the branch and resolves the conflicts within the pull request's scope. It then runs `pnpm check && pnpm test && pnpm format:check && pnpm lint && pnpm knip`, pushes, and posts a `COMMENT` review that says what conflicted. It leaves `ready-to-merge`, unless a conflict needs a design decision, in which case it records the blocker and removes `ready-to-merge`.

## One Loop file in full

`~/Code/usine-factory/loops/start-dev.md` as read on 2026-10-16:

```markdown
---
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
    !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
selector:
  repos: [basaltbytes/usine]
approval: required
step: implement
agent: developer
---
Use the repository's `tackle-issue` skill to complete issue #{{ item.number }}: {{ item.title }}.

Before editing, remove `ready-for-agent` from the issue and add `agent-in-progress`. Complete the issue through a non-draft pull request whose body closes the issue. Do not merge it. Once the pull request is ready, remove `agent-in-progress` from the issue and add `ready-for-review` to the pull request.

If work cannot continue, add a comment to the issue that states the exact blocker. Do not add a workaround that changes the issue's scope.
```

## Label flow

```
issue: ready-for-agent
  |  start-dev, after the operator approves the Run
  v
issue: agent-in-progress, then a PR that closes the issue
  |
  v
PR: ready-for-review <----------------------------+
  |  review-pr                                    |
  |                                               |
  +--> findings: agent-review-findings            |
  |      |                                        |
  |      +-- fewer than 3 reviewer reviews:       |
  |      |   act-on-findings fixes and pushes ----+
  |      |
  |      +-- 3 or more reviewer reviews --+
  |                                       |
  +--> no findings: review-passed --------+
                                          |
                                          v
      finish-pr: adds ready-to-merge, removes review-passed and agent-review-findings
                                          |
                                          v
      PR: ready-to-merge --(GitHub reports CONFLICTING)--> rebase-pr, keeps the label
                                          |
                                          v
      the operator merges; no Loop merges
```

## Where the Loops differ from the guide

The guide and [ADR 0022](https://github.com/basaltbytes/usine/blob/main/docs/adr/0022-item-cycle-budgets-and-comment-reviews.md) say to drop the CEL review counts from fix and finishing Loops, since the cycle budget bounds the rounds. `act-on-findings` (`< 3`) and `finish-pr` (`>= 3`) still count reviewer reviews in `if:`. The count reads the `reviews(last: 20)` connection of the payload slice (`packages/github/src/polling/queries.ts:84`), and matches the signature line, ending in `usine agent: reviewer`, that `githubSignature` asks every agent to add (`packages/agents/src/prompt.ts:28`).
