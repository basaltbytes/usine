---
title: Expressions
description: The CEL dialect of Loop conditions and prompt interpolation, the item and repo variables for each trigger, and the functions and macros available.
sidebar:
  order: 4
---

Loop files use expressions in two places:

- `trigger.if` selects Items. It must produce a `bool`.
- Each `{{ ... }}` in the Loop body inserts a value into the task. It must produce a scalar: `string`, `int`, `uint`, `double`, `bool`, or `null`.

Expressions use [CEL](https://github.com/google/cel-spec), the Common Expression Language. The `@usine/expression` package evaluates them with [`@marcbachmann/cel-js`](https://www.npmjs.com/package/@marcbachmann/cel-js) 8.0.0 ([`marcbachmann-cel.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/expression/src/marcbachmann-cel.ts#L245)).

The environment is typed. When a Loop file loads, usine type-checks every expression against the variables of its trigger's Stream, and quarantines the Loop on an unknown field, a type mismatch, or a wrong result type. Evaluation happens later, against each Item's payload or each Tick.

## Variables

Every expression can use two variables, `repo` and `item`. Their types come from the payload slices in [`payload-slices.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/payload-slices.ts#L173), and the values come from GitHub's GraphQL API with GitHub's field names ([`queries.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/polling/queries.ts#L1)).

### `repo`

The managed repository the Item or Tick belongs to ([`repositoryContext`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/payload-slices.ts#L244)).

| Field | Type | Description |
| --- | --- | --- |
| `repo.name` | string | The full `owner/name`, as written in `usine.yaml`. |
| `repo.owner` | string | The owner part of the name. |
| `repo.url` | string | `https://github.com/<owner>/<name>`. |

### `item` for `on: issue`

The issue payload slice ([`IssuePayload`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/polling/payload.ts#L48)). A field marked nullable can be `null` on a given Item; see [fields that can be null](#fields-that-can-be-null).

| Field | Type | Nullable | Description |
| --- | --- | --- | --- |
| `number` | int | | The issue number. |
| `title` | string | | |
| `body` | string | | The Markdown body. |
| `url` | string | | |
| `state` | string | | `OPEN` or `CLOSED`. |
| `stateReason` | string | yes | GitHub's state reason, such as `COMPLETED` or `NOT_PLANNED`. |
| `createdAt` | string | | ISO 8601 UTC timestamp. Convert with `timestamp()` to compare. |
| `updatedAt` | string | | ISO 8601 UTC timestamp. |
| `closedAt` | string | yes | ISO 8601 UTC timestamp. |
| `author.login` | string | `author` | `author` is null for a deleted account. |
| `issueType.name` | string | `issueType` | `issueType` is null when the issue has no type. |
| `milestone.title` | string | `milestone` | `milestone` is null when the issue has no milestone. |
| `labels.totalCount` | int | | |
| `labels.nodes[].name` | string | | The first 50 labels. |
| `assignees.totalCount` | int | | |
| `assignees.nodes[].login` | string | | The first 10 assignees. |
| `comments.totalCount` | int | | |
| `comments.nodes[]` | list | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closedByPullRequestsReferences.totalCount` | int | | |
| `closedByPullRequestsReferences.nodes[]` | list | | The first 10 pull requests that close the issue, closed ones included: `number`, `state`, `isDraft`, `url`. |

### `item` for `on: pr`

The pull-request payload slice ([`PullRequestPayload`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/polling/payload.ts#L97)).

| Field | Type | Nullable | Description |
| --- | --- | --- | --- |
| `number` | int | | The pull request number. |
| `title` | string | | |
| `body` | string | | |
| `url` | string | | |
| `state` | string | | `OPEN`, `CLOSED`, or `MERGED`. |
| `isDraft` | bool | | |
| `merged` | bool | | |
| `createdAt` | string | | ISO 8601 UTC timestamp. |
| `updatedAt` | string | | ISO 8601 UTC timestamp. |
| `mergedAt` | string | yes | ISO 8601 UTC timestamp. |
| `author.login` | string | `author` | `author` is null for a deleted account. |
| `baseRefName` | string | | The target branch. |
| `headRefName` | string | | The source branch. |
| `headRefOid` | string | | The head commit SHA. Attempts of `pr` Loops start from this commit. |
| `additions` | int | | |
| `deletions` | int | | |
| `changedFiles` | int | | |
| `reviewDecision` | string | yes | `APPROVED`, `CHANGES_REQUESTED`, or `REVIEW_REQUIRED`; null when the branch requires no review. |
| `mergeable` | string | | `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`. GitHub computes it lazily, so the first poll after the base branch changes can return `UNKNOWN`. |
| `mergeStateStatus` | string | | GitHub's merge state, such as `CLEAN`, `BLOCKED`, `BEHIND`, or `DIRTY`. |
| `statusCheckRollup.state` | string | `statusCheckRollup` | The combined check state, such as `SUCCESS`, `FAILURE`, or `PENDING`. `statusCheckRollup` is null when the head commit has no checks. |
| `labels.totalCount` | int | | |
| `labels.nodes[].name` | string | | The first 50 labels. |
| `reviewRequests.totalCount` | int | | |
| `reviewRequests.nodes[].requestedReviewer.login` | string | see below | The first 10 review requests. |
| `reviews.totalCount` | int | | |
| `reviews.nodes[]` | list | | The last 20 reviews: `author.login` (`author` nullable), `state`, `body`, `submittedAt` (nullable), `commit.oid` (`commit` nullable). |
| `reviewThreads.totalCount` | int | | |
| `reviewThreads.nodes[]` | list | | The first 50 threads: `isResolved`, `isOutdated`, `path`, and `comments` with `totalCount` and the first 10 `nodes`, each with `author.login` (`author` nullable) and `body`. |
| `comments.totalCount` | int | | |
| `comments.nodes[]` | list | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closingIssuesReferences.totalCount` | int | | |
| `closingIssuesReferences.nodes[]` | list | | The first 10 issues the pull request closes: `number`, `state`. |

`requestedReviewer` is null when the reviewer is a deleted account. A team review request has no `login`, so `login` reads as `null`.

### `item` for `on: schedule`

A schedule has no GitHub Item. `item` contains the Tick ([`tickPayload`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/schedule-triggers.ts#L193)).

| Field | Type | Description |
| --- | --- | --- |
| `item.tick.scheduledAt` | string | The time the Tick was scheduled for, in UTC, such as `2026-10-19T07:00:00.000Z`. |
| `item.tick.scheduledAtLocal` | string | The same instant in the trigger's time zone, such as `2026-10-19T09:00:00.000+02:00[Europe/Paris]`. |
| `item.tick.cron` | string | The trigger's `cron`. |
| `item.tick.tz` | string | The trigger's `tz`. |

## Fields that can be null

The CEL environment declares the fields marked nullable above as nullable ([`payload-slices.ts`](https://github.com/basaltbytes/usine/blob/main/packages/config/src/payload-slices.ts)). On an Item where such a field is null:

- Comparing it with a value gives `false`: `item.reviewDecision == "APPROVED"` is `false` when the branch requires no review.
- Comparing it with `null` tells whether GitHub has a value, in either order: `item.milestone != null`, `null == item.author`.
- Reading a field below a null object fails evaluation: `item.milestone.title == "v1"` fails with `No such key: title` on an issue without a milestone. Test the object first: `item.milestone != null && item.milestone.title == "v1"`. CEL's `&&` returns `false` when either side is `false`, even if the other side fails.
- `has(item.milestone.title)` is `false`. `has(item.milestone)` is `true`, because the field exists even when its value is null; test the value with `!= null`.

Fields below a nullable object keep their types, so a misspelled `item.milestone.titel` still stops the Loop from loading.

```yaml title="loops/plan-milestone.md"
trigger:
  on: issue
  if: item.milestone != null && item.milestone.title == "v1"
```

In the body, `{{ item.milestone != null ? item.milestone.title : "no milestone" }}` renders on every issue. A null value renders as `null`.

## What happens when evaluation fails

A failure at evaluation time doesn't quarantine the Loop, because the file already passed its checks:

- **`if` of an `issue` or `pr` Loop.** The failure applies to that Loop on that Item only. usine opens no Run for them and leaves the Item's queued Runs as they are; the Item's other Loops, the repository's other Items, and the poll cursor go on. **Needs you** shows the failure with the Loop and the Item for as long as the Loop fails on that Item, and usine logs it once per Loop, Item, and content hash ([`evaluation-failures.ts`](https://github.com/basaltbytes/usine/blob/main/packages/orchestrator/src/polling/evaluation-failures.ts)). The first poll after a restart or a reload fetches the failing Items again, so a fixed Loop evaluates them without waiting for them to change.
- **`if` of a `schedule` Loop.** The Tick fails for that repository, and usine evaluates it again at the next wake.
- **The re-check before a queued Run opens.** usine logs a warning and the Run opens as if the check had passed ([`TriggerCondition.recheck`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-condition.ts#L87)).
- **A `{{ ... }}` interpolation.** See [when rendering fails](/reference/configuration/loop-files/#when-rendering-fails).

## Language

The environment registers only the types and variables above. It enables no optional syntax and adds no functions to cel-js's standard set.

### Operators

- Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`. You can compare an `int` with a `double`.
- Logic: `&&`, `||`, `!`, and the conditional `condition ? a : b`.
- Arithmetic: `+`, `-`, `*`, `/`, `%`. `+` also concatenates strings and lists.
- Membership: `value in list`.
- Literals: integers, doubles, strings in `"..."` or `'...'`, `true`, `false`, `null`, lists `[...]`, and maps `{...}`. A list or map literal must contain values of one type.

### Macros

| Macro | Result | Example |
| --- | --- | --- |
| `list.exists(x, predicate)` | bool | `item.labels.nodes.exists(label, label.name == "ready")` |
| `list.all(x, predicate)` | bool | `item.reviewThreads.nodes.all(t, t.isResolved)` |
| `list.exists_one(x, predicate)` | bool | `item.assignees.nodes.exists_one(a, a.login == "octocat")` |
| `list.filter(x, predicate)` | list | `item.reviews.nodes.filter(r, r.state == "COMMENTED")` |
| `list.map(x, expression)` | list | `item.labels.nodes.map(label, label.name)` |
| `list.map(x, predicate, expression)` | list | `item.reviews.nodes.map(r, r.state == "COMMENTED", r.body)` |
| `has(object.field)` | bool | `false` when `object` is null; see above. |
| `cel.bind(name, value, expression)` | any | `cel.bind(n, size(item.labels.nodes), n > 0 && n < 5)` |

### Functions

| Function | Description |
| --- | --- |
| `size(x)`, `x.size()` | Length of a string, list, or map. |
| `s.contains(t)`, `s.startsWith(t)`, `s.endsWith(t)` | Substring tests. |
| `s.matches(re)` | Regular expression test, in JavaScript `RegExp` syntax. Inline flags such as `(?i)` aren't supported; write `[Cc][Ss][Vv]` or lowercase first. |
| `s.lowerAscii()`, `s.upperAscii()`, `s.trim()` | Case and whitespace. |
| `s.indexOf(t)`, `s.lastIndexOf(t)`, `s.substring(start, end)` | Positions and slices; indexes start at 0. |
| `s.split(separator)` | List of strings. |
| `list.join()`, `list.join(separator)` | Joins a list of strings. |
| `string(x)`, `int(x)`, `uint(x)`, `double(x)`, `bool(x)`, `bytes(x)`, `dyn(x)` | Conversions. |
| `type(x)` | The type of a value. |
| `timestamp(s)` | Parses an ISO 8601 string, such as `item.updatedAt`. |
| `duration(s)` | Parses a duration such as `"72h"`, `"30m"`, or `"1h30m"`. |
| `t.getFullYear()`, `t.getMonth()`, `t.getDate()`, `t.getDayOfMonth()`, `t.getDayOfWeek()`, `t.getDayOfYear()`, `t.getHours()`, `t.getMinutes()`, `t.getSeconds()`, `t.getMilliseconds()` | Parts of a timestamp, in UTC, or in the time zone passed as argument. `getMonth` and `getDayOfMonth` start at 0, `getDate` at 1, and `getDayOfWeek` is 0 on Sunday. |
| `d.getHours()`, `d.getMinutes()`, `d.getSeconds()`, `d.getMilliseconds()` | Parts of a duration. |

Subtracting two timestamps gives a duration, and you can compare two durations. No function returns the current time. A schedule Loop can use `item.tick.scheduledAt` instead.

## Label declarations

When an instance loads, usine collects the string literals that a Loop's `if` compares with the `name` of a value under `item.labels`, through `==`, `!=`, `in`, and the `exists`, `all`, `exists_one`, `filter`, and `map` macros ([`relatedStringLiterals`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/expression/src/marcbachmann-cel.ts#L225)). A literal that isn't declared under `labels` in `usine.yaml` produces the warning `Loop trigger references an undeclared GitHub label`, and the Loop still loads.

## Examples from real Loops

An issue is ready and no open pull request closes it yet:

```yaml title="loops/start-dev.md"
if: >-
  item.state == "OPEN" &&
  item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
  !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
```

A pull request is ready for review and no outcome label is present:

```yaml title="loops/review-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "ready-for-review") &&
  !item.labels.nodes.exists(label, label.name == "review-passed") &&
  !item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A review left findings to fix. The condition doesn't count reviews: the Loop's `max_cycles` limits the review and fix rounds on each pull request ([Bounded review and fix Loops](/guides/review-fix-loops/)):

```yaml title="loops/act-on-findings.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

A review passed:

```yaml title="loops/finish-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "review-passed")
```

A pull request marked for merge has a conflicting branch:

```yaml title="loops/rebase-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.mergeable == "CONFLICTING" &&
  item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A schedule that skips weekends in its own time zone:

```yaml title="loops/daily-digest.md"
if: >-
  timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 0 &&
  timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 6
```

Prompt interpolations from the same Loops:

```markdown title="loops/rebase-pr.md"
Pull request #{{ item.number }} is marked `ready-to-merge` but GitHub reports its branch `{{ item.headRefName }}` as conflicting with `{{ item.baseRefName }}`.
```
