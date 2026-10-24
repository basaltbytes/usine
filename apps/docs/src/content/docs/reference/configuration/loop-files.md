---
title: Loop files
description: The frontmatter fields of a loop file, the prompt template in its body, and what happens to a file that fails validation.
sidebar:
  order: 2
---

A loop is one Markdown file in `loops/`. The file name without `.md` is the loop's name and identity: renaming the file removes the old loop and creates a new one, and deleting it removes the loop. The YAML frontmatter declares the trigger, the selector, and the agent. The body is the prompt template for the agent's task. usine has no built-in loops.

The orchestrator reads every `.md` file directly in `loops/`, in name order, at startup and at each [reload](/reference/configuration/cli/#reload). It ignores other files. If `loops/` or `agents/` is missing, the instance doesn't load.

The schema is [`LoopFrontmatter`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L31) in `packages/config/src/parser.ts`, which produces a [`LoopFile`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/loop.ts#L25).

## Example

```markdown title="loops/start-dev.md"
---
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
    !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
selector:
  repos: [acme/widgets]
approval: required
step: implement
agent: developer
max_cycles: 3
---
Use the repository's `tackle-issue` skill to complete issue #{{ item.number }}: {{ item.title }}.

Before editing, remove `ready-for-agent` from the issue and add `agent-in-progress`. Complete the issue through a non-draft pull request whose body closes the issue. Do not merge it. Once the pull request is ready, remove `agent-in-progress` from the issue and add `ready-for-review` to the pull request.

If work cannot continue, add a comment to the issue that states the exact blocker. Do not add a workaround that changes the issue's scope.
```

## File format

The file starts with a `---` line. The YAML frontmatter runs to the next `---` line, and the body starts after it ([`splitMarkdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/frontmatter.ts#L24)). LF and CRLF line endings both work.

The file name must be kebab-case, such as `review-pr.md`.

## Frontmatter fields

Keys are snake_case. Unknown keys at any level and duplicate keys are errors.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger` | [trigger](#trigger) | required | The loop's stream and the condition that selects items. |
| `selector` | [selector](#selector) | every managed repository | The repositories that the loop applies to. |
| `approval` | `none`, `required` | `none` | Whether each new run waits for the operator's approval. |
| `step` | string | `run` | The name of the run's single step. |
| `agent` | string | required | The agent that does the loop's runs: the name of a file in `agents/`, without `.md`. |
| `max_cycles` | integer ≥ 1 | `3` | The loop's cycle budget per item. |
| `permissions` | `write`, `read` | `write` | What the loop's attempts can do to their repository. |
| `priority` | integer ≥ 1 | none | Ranks the loop's runs for a free worker slot above runs that lane order ranks. Higher goes first. |

### `trigger`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `on` | `issue`, `pr`, `schedule` | required | The stream: issues (not pull requests), pull requests, or the clock. |
| `if` | CEL expression | required | Selection condition that must evaluate to a boolean. See [Expressions](/reference/configuration/expressions/). |
| `cron` | string | required for `schedule` | Five-field cron expression. Rejected for `issue` and `pr`. |
| `tz` | string | `UTC` | IANA time zone for the cron, such as `Europe/Paris`. `schedule` only. |

The trigger classes are [`IssueTrigger`, `PullRequestTrigger`, and `ScheduleTrigger`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/trigger.ts#L27).

`if` is a string. An unquoted `true` or `false` counts as the CEL literal, so `if: true` selects every item. Quote any other value that YAML doesn't read as a string, such as a number, or the parser rejects it with `Expected a CEL expression. Quote the value so that YAML reads it as a string.`. Split a long condition with a folded block scalar (`>-`).

#### `on: issue` and `on: pr`

Every `settings.poll_interval` seconds, usine lists the issues and pull requests that changed in each selected repository, fetches each one's payload slice, and evaluates `if` against it ([`evaluateItem`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/polling/loop-evaluation.ts#L52)). It also fetches every open pull request, because GitHub can change mergeability without updating the pull request. A board move queues a fetch of its item.

- If `if` is true, usine renders the body and submits an event, deduplicated by the loop, the repository, the item number, and a hash of the payload without its timestamps. The same content opens no second run; a new run needs a change, such as a label, a comment, or a commit.
- If `if` is false, usine revokes the loop's runs for that item that no attempt has started. A running attempt finishes.
- Before a queued run opens, the engine evaluates `if` again on a fresh snapshot of the item. If that check fails or takes more than five seconds, the run opens anyway ([`triggerConditionLayer`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-condition.ts#L23)).

An attempt for an `issue` loop starts detached at the latest commit of the default branch. An attempt for a `pr` loop starts detached at the pull request's head commit, `headRefOid`.

#### `on: schedule`

A schedule loop evaluates `if`, with `item.tick` set to the tick, once per tick for each selected repository ([`ScheduleTriggers`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/schedule-triggers.ts#L203)). Attempts start from the default branch. `max_cycles` doesn't apply.

- Each tick produces one event per repository, deduplicated by the loop, the repository, and the scheduled time.
- usine evaluates only the latest tick at or before the current time, so after downtime only the latest missed tick fires. A new schedule loop fires at startup for its latest past tick.
- If `if` is false for every repository, usine evaluates the same tick again at its next wake, at most 60 seconds later, until the next tick replaces it.

`cron` has five fields: minute, hour, day of month, month, and day of week. Effect's `Cron` module parses it, as the scheduler does ([`Cron`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/trigger.ts#L11)).

| Field | Values | Aliases |
| --- | --- | --- |
| minute | 0 to 59 | |
| hour | 0 to 23 | |
| day of month | 1 to 31 | |
| month | 1 to 12 | `jan` to `dec` |
| day of week | 0 to 7, where 0 and 7 are Sunday | `sun` to `sat` |

Each field accepts `*`, lists (`1,15`), ranges (`1-5`), and steps (`*/15`). If both day fields are restricted, a date matches either one. A six-field cron with seconds is rejected. Quote the value, because YAML reads a leading `*` as an alias.

In a daylight-saving gap, usine can't compute the cron boundaries, so the schedule logs an error and retries at its next wake. In the hour that repeats when clocks go back, the loop fires at both UTC instants.

```markdown title="loops/weekly-triage.md"
---
trigger:
  on: schedule
  cron: "0 9 * * mon"
  tz: Europe/Paris
  if: "true"
selector:
  tags: [web]
step: triage
agent: developer
---
List the open issues of {{ repo.name }} that carry no label. Comment on each one with a proposed label and a one-sentence reason. Do not change labels yourself.

This Run belongs to the Tick scheduled for {{ item.tick.scheduledAtLocal }}.
```

### `selector`

Limits the loop to some managed repositories ([`Selector`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/selector.ts#L6)). Without it, the loop applies to every repository in `usine.yaml`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `repos` | list of `owner/name` | none | Repositories by name. Each must be in the registry. Names match case-insensitively, as on GitHub. |
| `tags` | list of strings | none | Repositories that have any of these tags. At least one registry repository must have each tag. |

A selector must set `repos`, `tags`, or both, each a non-empty list without duplicates. With both, a repository must be in `repos` and have one of the `tags` ([`matchesSelector`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/selector.ts#L23)).

```yaml title="loops/review-pr.md"
selector:
  repos: [acme/widgets, acme/gadgets]
  tags: [web]
```

### `approval`

With `required`, each new run waits in `Waiting` until the operator approves it in the UI. usine records the approval as an event. With the default `none`, runs start without an approval ([`ApprovalRequirement`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/loop.ts#L9)). If the item changes while a run waits and still matches, usine opens a new waiting run for the new state and cancels the older one as superseded. If it no longer matches, usine revokes the waiting run.

### `step`

A non-empty string that sets the name of the run's single step ([`StepName`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/step/step.ts#L9)). It appears in attempt IDs (`<run>/<step>/<number>`) and logs, so describe the work, such as `implement` or `review`. The name identifies the step's stored result. Renaming the step creates a new step, and results under the old name stay there.

### `agent`

The kebab-case name of an [agent file](/reference/configuration/agent-files/). The agent must be in the roster. usine quarantines a loop that references a missing or invalid agent file, with the message `Unknown agent "<name>": agents/<name>.md is missing or invalid. Fix the agent file, or set agent to an existing agent.`

### `max_cycles`

The cycle budget: the number of runs that this loop can open on one item between operator resets ([`CycleLimit`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/cycle-budget.ts#L8)). The default is 3. Each loop counts separately, so three review and fix rounds allow three reviews and three fixes. A retry uses its run's reservation, and work canceled before its first attempt returns its reservation. Schedule loops ignore this field ([`triggerSubmission`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-submission.ts#L98)).

When a loop reaches its limit, its next matching event opens an ask instead of a run: **Cycle budget exhausted** in **Needs attention**, with the item, the loops involved, the admitted runs, and the completed rounds. While the ask is open, no loop opens a run on that item, including a finishing loop, but runs that have a reservation finish. Label changes and restarts don't reset the budget, and the ask stays visible even if the item no longer matches any loop. usine doesn't post the ask on GitHub ([#36](https://github.com/basaltbytes/usine/issues/36)).

**Reset cycle budget** starts a new budget and polls the repository again from the start ([`CycleBudget.admit`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/engine/src/cycle-budget/queries.ts#L84)). Only active loops that match the item then can open work. A paused loop stays paused.

```yaml title="loops/act-on-findings.md"
max_cycles: 5
```

### `permissions`

What the loop's attempts can do to their repository ([`LoopPermissions`](https://github.com/basaltbytes/usine/blob/main/packages/core/src/loop.ts)). The default, `write`, lets them push branches and open and update pull requests. Set `read` for a loop whose agent must not change the code, such as a review loop:

- The attempt's GitHub token has `contents: read`, so GitHub refuses a push, a merge, or a branch update with it. It keeps `pull_requests: write` and `issues: write`, so the agent can still post reviews and comments with `gh pr review`, `gh pr comment`, and `gh issue comment`, and change labels, which can trigger other loops ([`WORKER_TOKEN_PERMISSIONS`](https://github.com/basaltbytes/usine/blob/main/packages/github/src/access.ts)).
- The checkout has a pre-push hook, run instead of the repository's own hooks, that stops `git push` with `usine refused this push: the Loop <name> has permissions: read, so its Attempts cannot push to the repository.` The hook shows the agent the reason instead of GitHub's 403. It isn't a control: `git push --no-verify` skips it, and the token still blocks the push.
- An attempt that ends without success leaves no salvage branch, and usine removes its checkout.

usine records the level with each event, so a run keeps the level that its loop had when the event matched. A changed level applies to events after the next reload.

An exe.dev worker uses exe.dev's GitHub integration, which grants the access of exe.dev's own GitHub App and can't be narrowed to `read`. So it refuses a `read` loop's attempts before it attaches the integration: the attempt fails with a message that gives the worker and the loop, usine doesn't retry it, and the run appears in **Needs attention**. Run `read` loops on a local or SSH worker.

`read` limits the attempt's token, not other credentials on the worker:

- On the local worker, the agent runs as your Unix user and can push with your own credentials. See [Credentials that local attempts can read](/guides/add-a-worker/#credentials-that-local-attempts-can-read).
- [SSH workers](/guides/add-a-worker/#ssh-workers) have none of your credentials, and a worker behind a gateway has no GitHub token on disk.
- On an SSH worker, an attempt can read the token or caller token of another attempt that runs on the same machine at the same time ([#231](https://github.com/basaltbytes/usine/issues/231), [#243](https://github.com/basaltbytes/usine/issues/243)), including a `write` attempt.

```yaml title="loops/review-pr.md"
permissions: read
```

### `priority`

When every worker slot is taken, runs wait in a queue. A free slot goes to the first waiting run in this order ([`leaseOrder`](https://github.com/basaltbytes/usine/blob/main/packages/orchestrator/src/lease-order.ts)):

1. A run that reattaches an attempt still running on the worker with the free slot.
2. A run of a loop that sets `priority`, higher first.
3. A run with a lane position, later lane first. The position is the first lane, in the repository's [`lanes`](/reference/configuration/usine-yaml/#reposlanes) order, with a `label` source that matches a label the item had when the run's trigger matched. It's the lane that the board shows the run's card in while it runs.
4. Any other run, such as a schedule run or a run in a repository without `lanes`.

Runs at the same position keep the order in which their events arrived.

With lanes ordered as the pipeline runs, later stages go first without any `priority`. In this `usine.yaml`, a `review-pr` run on a pull request labeled `ready-for-review` goes before every `start-dev` run on an issue labeled `ready-for-agent`, even one whose event arrived earlier:

```yaml title="usine.yaml"
repos:
  - name: acme/widgets
    lanes:
      - name: Ready
        sources: [{ label: ready-for-agent }]
      - name: Review
        sources: [{ label: ready-for-review }]
      - name: Merge
        sources: [{ label: ready-to-merge }]
```

Set `priority` for a loop that lane order doesn't rank, or ranks wrong. A loop with `priority` goes before every lane, so to order loops by hand, set `priority` on each of them.

```yaml title="loops/rebase-pr.md"
priority: 1
```

The scheduler reads the loop file and the lanes when a run starts waiting, so a reload doesn't reorder runs that already wait. **Overview** shows a waiting run as `Waiting for a free worker slot, behind 2 runs`. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource` (`priority`, `lane`, or `none`), `position`, and `passed`: the number of waiting runs whose events arrived earlier.

## Prompt template

Everything after the closing `---` line is the prompt template, and it must not be blank. When a trigger matches, usine renders it into the run's task. You can change a failed run's task later with **Edit and retry**.

### Interpolation syntax

`{{ expression }}` inserts the value of a CEL expression ([`interpolations`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L126)):

- An interpolation runs from `{{` to the next `}}`. usine trims the whitespace around the expression, which must not be blank.
- An `{{` without a closing `}}` is an error. There's no escape for a literal `{{`, and a `}}` in a CEL string ends the interpolation early.
- The expression can use the same [variables](/reference/configuration/expressions/#variables) as `if`.
- The expression must produce a scalar: `string`, `int`, `uint`, `double`, `bool`, or `null`. A list, a map, or an object fails validation.

Values render as text: integers as decimal digits, booleans as `true` or `false`, and doubles in JavaScript number form ([`render`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L155)). To insert a list, reduce it to a string:

```markdown title="loops/start-dev.md"
Labels on this issue: {{ item.labels.nodes.map(label, label.name).join(", ") }}
```

### Render failures

An interpolation that type-checks can still fail at render time, for example on a [null field](/reference/configuration/expressions/#fields-that-can-be-null). Test the object with `!= null`, or use [optional selection](/reference/configuration/expressions/#optional-values) with an `orValue` fallback. Both lines render `none` on an issue without a milestone:

```markdown title="loops/plan-milestone.md"
Milestone: {{ item.milestone != null ? item.milestone.title : "none" }}
Milestone: {{ item.?milestone.?title.orValue("none") }}
```

If rendering fails:

- For `issue` and `pr` loops, usine submits no event for that loop and item, and continues with the others. The poll cursor still advances. **Needs attention** shows the failure with the loop, the item, and the interpolation while it lasts, and usine logs `Loop evaluation failed on an Item` once per loop, item, and content hash. usine evaluates the item again when it changes, and on the first poll after a restart or a reload.
- For `schedule` loops, the tick fails for that repository, and usine evaluates it again at the next wake.

### Agent prompt

The attempt's Pi parent receives the task in instructions that usine assembles ([`assemblePrompt`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/prompt.ts#L58)):

1. The repository name, the event's payload snapshot as JSON, and, on a retry, the salvage branch that the attempt resumes from.
2. The agent's persona.
3. The rendered task.
4. Fixed instructions: run checks in the foreground, push before finishing, and start the final answer with `[usine:blocked]` to report a blocker or `[usine:question]` to ask the operator for a decision.
5. Fixed GitHub instructions: submit pull request reviews as `COMMENT` only, and end every comment, issue, pull request, and review with `— usine agent: <agent>`.

The task doesn't need to repeat payload fields or these rules. Interpolate values that the task states directly, such as the head commit to verify.

## Validation and quarantine

usine validates each loop file separately. A file that fails a check is quarantined: the loop opens no runs, and the other loops still load ([`InstanceFolder.load`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/instance-folder.ts#L93)). The checks run in this order, and the first failure sets the stage:

| Stage | Checks | Example message |
| --- | --- | --- |
| `schema` | The file name ends in `.md` and is kebab-case. | `Expected a kebab-case file name` |
| `read` | The file can be read. | |
| `frontmatter` | Opening and closing `---` lines. | `Expected the file to start with a YAML frontmatter delimiter (---)` |
| `yaml` | YAML syntax, no duplicate keys, no parser warnings. | |
| `schema` | Frontmatter keys and values, including a valid `cron` and IANA `tz`, and a non-blank body. | `Expected no excess property at ["trigger"]["cron"]` |
| `expression` | `if` type-checks as a boolean, and each interpolation is closed and type-checks as a scalar. | `No such key: nmae` |
| `reference` | The agent is in the roster, and the selected repositories and tags exist in `usine.yaml`. | `Unknown tags in selector.tags: "mobile". Add them to a repository's tags in usine.yaml.` |

At startup and at each reload, usine logs each quarantined loop as a warning, `Loop quarantined; it opens no Runs until its file is fixed`, with its file, stage, and message, and lists it in **Needs attention** as **Loop file not loaded**. Fix the file and [reload](/reference/configuration/cli/#reload).

Two checks only log a warning: a label name in `if` ([label declarations](/reference/configuration/expressions/#label-declarations)) or in a [lane](/reference/configuration/usine-yaml/#reposlanes) that `usine.yaml` doesn't declare.

## More examples

A pull request loop that reviews the head commit:

```markdown title="loops/review-pr.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" &&
    !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "ready-for-review") &&
    !item.labels.nodes.exists(label, label.name == "review-passed") &&
    !item.labels.nodes.exists(label, label.name == "ready-to-merge")
selector:
  tags: [web]
step: review
agent: reviewer
permissions: read
---
Review pull request #{{ item.number }} at commit {{ item.headRefOid }} with the repository's `code-review` skill.

Before reading the diff, fetch `refs/pull/{{ item.number }}/head`, verify that it resolves to {{ item.headRefOid }}, and check out that commit. Remove `ready-for-review` from the pull request before starting the review.

Post the review on GitHub. If you find any actionable issue, explain it with file and line references and add `agent-review-findings` to the pull request. If there are no actionable findings, post a short review result, make sure `agent-review-findings` is absent, and add `review-passed`. Do not edit the branch or merge the pull request.
```

A pull request loop that fixes the findings of a review. Its trigger doesn't count reviews: `max_cycles` limits the review and fix rounds on each pull request. When a loop has used its limit, usine opens an ask instead of another run. See [Write review and fix loops](/guides/review-fix-loops/):

```markdown title="loops/act-on-findings.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" &&
    !item.isDraft &&
    item.labels.nodes.exists(label, label.name == "agent-review-findings")
selector:
  repos: [acme/widgets]
step: act-on-findings
agent: developer
max_cycles: 3
---
Address the review findings on pull request #{{ item.number }}. Do not merge the pull request.

Fetch `refs/pull/{{ item.number }}/head`, verify that it resolves to {{ item.headRefOid }}, and check out the pull request branch `{{ item.headRefName }}` before editing.

Read every review comment signed `usine agent: reviewer`. Fix each finding in the branch, run the required checks, commit the changes, and push them to `{{ item.headRefName }}`. Reply to each finding with what changed or why it was left as is. Then add `ready-for-review` and remove `agent-review-findings` and `review-passed`, so the new commit gets another review.

If you can't complete the fix, leave `agent-review-findings` on the pull request and comment with the blocker.
```
