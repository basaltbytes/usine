---
title: Loop files
description: The frontmatter fields of a Loop file, the prompt template in its body, and what happens to a file that fails validation.
sidebar:
  order: 2
---

A Loop is one Markdown file in the `loops/` folder of the instance folder. The filename without `.md` is the Loop's name and identity: renaming the file retires the Loop and creates a new one. The YAML frontmatter declares the trigger, the selector, and the Agent. The body is the prompt template that usine renders into the Agent's task.

The orchestrator reads every file ending in `.md` directly inside `loops/`, in name order, once at startup. It ignores other files. If the `loops/` or `agents/` folder is missing, the instance doesn't load.

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

The file starts with a line containing only `---`. The YAML frontmatter runs to the next line containing only `---`, and the body starts on the line after it ([`splitMarkdown`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/frontmatter.ts#L24)). LF and CRLF line endings both work.

The filename must be kebab-case: lowercase letters and digits separated by single hyphens, such as `review-pr.md`.

## Frontmatter fields

Keys are snake_case. An unknown key at any level is an error, as are duplicate keys.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger` | [trigger](#trigger) | required | The Loop's Stream and the condition that selects Items. |
| `selector` | [selector](#selector) | every managed repository | The repositories the Loop applies to. |
| `approval` | `none`, `required` | `none` | Whether each new Run waits for the operator's Approval. |
| `step` | string | `run` | The name of the Run's single Step. |
| `agent` | string | required | The Agent that owns the Loop's Runs: the name of a file in `agents/`, without `.md`. |
| `max_cycles` | integer ≥ 1 | `3` | The Loop's Cycle budget per Item. |

### `trigger`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `on` | `issue`, `pr`, `schedule` | required | The Stream: issues, pull requests, or the clock. |
| `if` | CEL expression | required | Selection condition that must evaluate to a boolean. See [Expressions](/reference/configuration/expressions/). |
| `cron` | string | required for `schedule` | Five-field cron expression. Rejected for `issue` and `pr`. |
| `tz` | string | `UTC` | IANA time zone the cron is evaluated in, such as `Europe/Paris`. `schedule` only. |

The trigger classes are [`IssueTrigger`, `PullRequestTrigger`, and `ScheduleTrigger`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/trigger.ts#L27).

`if` is a string. YAML reads an unquoted `true` as a boolean, which the parser rejects with `Expected string`. Write `if: "true"` for a Loop that selects every Item. Use a folded block scalar (`>-`) to split a long condition over several lines.

#### `on: issue` and `on: pr`

Each poll cycle, usine lists the issues and pull requests that changed in each selected repository, fetches each one's payload slice, and evaluates `if` against it ([`evaluateItem`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/polling/loop-evaluation.ts#L52)).

- When `if` is true, usine renders the body and submits an Event. The Event's dedup key is the Loop, the repository, the Item number, and a hash of the payload without its timestamp fields. The same Item content produces the same Event, so it opens no second Run.
- When `if` is false, usine revokes the Loop's Runs for that Item that no Attempt has started.
- Before a queued Run opens, the engine evaluates `if` again against a fresh snapshot of the Item. If that check fails or takes more than five seconds, the Run opens ([`triggerConditionLayer`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-condition.ts#L23)).

An Attempt for an `issue` Loop starts from the repository's default branch. An Attempt for a `pr` Loop starts from the pull request's head commit, `headRefOid`.

#### `on: schedule`

A schedule Loop fires once per Tick for each selected repository ([`ScheduleTriggers`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/schedule-triggers.ts#L203)). usine evaluates `if` with `item.tick` set to the Tick. Attempts start from the default branch.

- Each Tick produces one Event per repository, with a dedup key made of the Loop, the repository, and the scheduled time.
- usine evaluates only the latest Tick at or before the current time. After downtime, only the latest missed Tick fires. A new schedule Loop fires at startup for its latest past Tick.
- When `if` is false for every repository, usine evaluates the same Tick again at its next wake, at most 60 seconds later, until the next Tick replaces it.
- `max_cycles` doesn't apply to schedule Loops.

`cron` has five fields: minute, hour, day of month, month, day of week. Effect's `Cron` module parses it, the same parser the scheduler uses ([`Cron`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/trigger.ts#L11)).

| Field | Values | Aliases |
| --- | --- | --- |
| minute | 0 to 59 | |
| hour | 0 to 23 | |
| day of month | 1 to 31 | |
| month | 1 to 12 | `jan` to `dec` |
| day of week | 0 to 7, where 0 and 7 are Sunday | `sun` to `sat` |

Each field accepts `*`, lists (`1,15`), ranges (`1-5`), and step values (`*/15`). When both day fields are restricted, a date matches if either one matches. The parser rejects a six-field cron with seconds. Quote the value, because YAML reads a leading `*` as an alias.

usine can't compute the cron boundaries inside a daylight-saving gap, so the schedule logs an error and retries at its next wake. During the hour that repeats when clocks go back, one local time matches two UTC instants, and the Loop fires at both.

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

Limits the Loop to a subset of the managed repositories ([`Selector`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/selector.ts#L6)). Without a selector the Loop applies to every repository in `usine.yaml`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `repos` | list of `owner/name` | none | Repositories by name. Each must be in the registry. Names match case-insensitively, as on GitHub. |
| `tags` | list of strings | none | Repositories that have any of these tags. At least one registry repository must have each tag. |

A selector sets `repos`, `tags`, or both; an empty mapping is an error. Each list must be non-empty and free of duplicates. With both keys, a repository must be listed in `repos` and have one of the `tags` ([`matchesSelector`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/selector.ts#L23)).

```yaml title="loops/review-pr.md"
selector:
  repos: [acme/widgets, acme/gadgets]
  tags: [web]
```

### `approval`

With `required`, each new Run waits for the operator to approve it in the UI before its first Attempt. usine records the Approval as an Event. With the default `none`, Runs start without an Approval ([`ApprovalRequirement`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/loop.ts#L9)).

### `step`

A non-empty string that sets the name of the Run's single Step ([`StepName`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/step/step.ts#L9)). The name identifies the Step's stored result. Renaming the Step creates a new Step; results stored under the old name stay there.

### `agent`

The kebab-case name of an [Agent file](/reference/configuration/agent-files/). The Agent must be in the roster. usine quarantines a Loop that references a missing or invalid Agent file, with the message `Unknown agent: <name>`.

### `max_cycles`

The Cycle budget: the most Runs this Loop may open for one Item before the operator resets the Item ([`CycleLimit`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/cycle-budget.ts#L8)). When a Loop reaches its limit, the next matching Event opens no Run and the engine opens an Item-level Ask instead. While that Ask is open, no Loop opens a new Run for the Item; the operator's reset starts a new budget ([`CycleBudget.admit`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/engine/src/cycle-budget/queries.ts#L84)). The default is 3. Schedule Loops ignore this field ([`triggerSubmission`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-submission.ts#L98)).

```yaml title="loops/act-on-findings.md"
max_cycles: 5
```

## The body: prompt template

Everything after the closing `---` line is the prompt template. It must contain at least one non-whitespace character. When a trigger matches, usine renders the template into the Run's task.

### Interpolation syntax

`{{ expression }}` inserts the value of a CEL expression ([`interpolations`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L126)):

- An interpolation runs from `{{` to the next `}}`. Whitespace around the expression is trimmed, and the expression must not be blank.
- An `{{` without a closing `}}` is an error.
- There is no escape for a literal `{{`. A `}}` inside a CEL string literal ends the interpolation early.
- The expression can use the same variables as the Loop's `if`: `repo`, and `item` shaped by the trigger's Stream. See [Expressions](/reference/configuration/expressions/#variables).
- The expression must produce a scalar: `string`, `int`, `uint`, `double`, `bool`, or `null`. A list, a map, or an object fails validation when the file loads.

Values render as text: integers as decimal digits, booleans as `true` or `false`, doubles in JavaScript number form ([`render`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/parser.ts#L155)). To insert a list, reduce it to a string:

```markdown title="loops/start-dev.md"
Labels on this issue: {{ item.labels.nodes.map(label, label.name).join(", ") }}
```

### When rendering fails

usine type-checks every interpolation when the file loads, but a value can still fail at render time, for example a field that is `null` on this Item (see [null fields](/reference/configuration/expressions/#fields-that-can-be-null)).

- For `issue` and `pr` Loops, usine logs `Loop prompt rendering failed`, submits no Event for that Loop and Item, and continues with the other Loops. The poll cursor still advances, so usine doesn't evaluate the Item again until it changes.
- For `schedule` Loops, the Tick fails for that repository, and usine evaluates it again at the next wake.

### What the Agent receives

The rendered body is the task. The Attempt's Pi parent receives it inside instructions that usine assembles ([`assemblePrompt`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/agents/src/prompt.ts#L58)):

1. The repository name and the Event's full payload snapshot as JSON.
2. The Agent's persona, the body of its Agent file.
3. The rendered task.
4. Fixed instructions on completing the task and reporting a blocker.
5. Fixed GitHub instructions, including the signature `— usine agent: <agent>` that every comment and review must end with.

The template doesn't need to copy payload fields, because the Agent can read them from the snapshot. Use interpolation for values that the task states directly, such as the head commit to verify.

## Validation and quarantine

usine validates each Loop file separately. A file that fails any check is quarantined: usine leaves it out of the loaded instance, it opens no Runs, and the other Loops still load ([`InstanceFolder.load`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/instance-folder.ts#L93)). The checks run in this order, and the first failure sets the stage:

| Stage | Checks | Example message |
| --- | --- | --- |
| `schema` | The filename ends in `.md` and is kebab-case. | `Expected a kebab-case filename identity` |
| `read` | The file can be read. | |
| `frontmatter` | Opening and closing `---` lines. | `Expected the file to start with a YAML frontmatter delimiter (---)` |
| `yaml` | YAML syntax, no duplicate keys, no parser warnings. | |
| `schema` | Frontmatter keys and values; a non-blank body. | `Expected no excess property at ["trigger"]["cron"]` |
| `expression` | `if` type-checks as a boolean; each interpolation is closed and type-checks as a scalar. | `No such key: nmae` |
| `reference` | The Agent is in the roster; selected repositories and tags exist in `usine.yaml`. | `Unknown selector tags: mobile` |

:::caution
At this commit, `usine up` doesn't report quarantined Loops. The loader returns them with their stage and message, but usine doesn't log them, and the UI lists only loaded Loops. A Loop missing from the UI was quarantined. Fix the file and restart `usine up`.
:::

Two checks only log a warning. If `if` compares `item.labels` against a label name that isn't declared under `labels` in `usine.yaml`, usine logs `Loop trigger references an undeclared GitHub label` and still loads the Loop. The other check covers labels in Board Lanes; see [`repos[].lanes`](/reference/configuration/usine-yaml/#reposlanes).

## More examples

A pull-request Loop that reviews the head commit:

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
---
Review pull request #{{ item.number }} at commit {{ item.headRefOid }} with the repository's `code-review` skill.

Before reading the diff, fetch `refs/pull/{{ item.number }}/head`, verify that it resolves to {{ item.headRefOid }}, and check out that commit. Remove `ready-for-review` from the pull request before starting the review.

Post the review on GitHub. If you find any actionable issue, explain it with file and line references and add `agent-review-findings` to the pull request. If there are no actionable findings, post a short review result, make sure `agent-review-findings` is absent, and add `review-passed`. Do not edit the branch or merge the pull request.
```

A pull-request Loop that stops after three review rounds. It counts the reviews that contain the reviewer Agent's signature:

```markdown title="loops/act-on-findings.md"
---
trigger:
  on: pr
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "agent-review-findings") &&
    size(item.reviews.nodes.filter(review, review.body.contains("usine agent: reviewer"))) < 3
selector:
  repos: [acme/widgets]
step: act-on-findings
agent: developer
---
Address the review findings on pull request #{{ item.number }}. Do not merge the pull request.

First remove `agent-review-findings` from the pull request. Fetch `refs/pull/{{ item.number }}/head`, verify that it resolves to {{ item.headRefOid }}, and check out the pull request branch `{{ item.headRefName }}` before editing.

Read every review comment signed `usine agent: reviewer`. Fix each finding in the branch, run the required checks, commit the changes, and push them to `{{ item.headRefName }}`. Reply to each finding with what changed or why it was left as is, then add `ready-for-review` so the updated commit receives another review.
```
