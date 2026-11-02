---
title: Expressions
description: The CEL dialect of loop conditions and prompt interpolation, the item and repo variables for each trigger, and the functions and macros available.
sidebar:
  order: 4
---

Loops use [CEL](https://cel.dev) for selection, conditional approval, queue priority, and task interpolation. Conditions return booleans; priorities return integers; each `{{ ... }}` in a task returns a scalar. Edit expressions in the loop form or with `usine config edit loop <project>/<loop>`.

Before saving a revision, usine type-checks every expression against its stream's variables. An unknown field, a type mismatch, or a wrong result type rejects the edit or complete import; the stored configuration stays unchanged. Evaluation happens later, against each item's payload or tick.

## Variables

Expressions can use `repo` and `item`. Their types come from the payload slice for each stream. GitHub supplies item values with its GraphQL field names; the orchestrator supplies repository and tick values. These fields have no configurable defaults, shown as `—` in the tables.

### `repo`

The managed repository that the item or tick belongs to.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `repo.name` | string | — | The full `owner/name`, as registered in the stored configuration. |
| `repo.owner` | string | — | The owner part of the name. |
| `repo.url` | string | — | `https://github.com/<owner>/<name>`. |

### `item` for `on: issue`

The issue payload slice. A field marked nullable can be `null` on a given item. See [Fields that can be null](#fields-that-can-be-null).

| Field | Type | Default | Nullable | Description |
| --- | --- | --- | --- | --- |
| `number` | int | — | | The issue number. |
| `title` | string | — | | Item title. |
| `body` | string | — | | The Markdown body. |
| `url` | string | — | | Canonical GitHub item URL. |
| `state` | string | — | | `OPEN` or `CLOSED`. |
| `stateReason` | string | — | yes | GitHub's state reason, such as `COMPLETED` or `NOT_PLANNED`. |
| `createdAt` | string | — | | ISO 8601 UTC timestamp. Convert with `timestamp()` to compare. |
| `updatedAt` | string | — | | ISO 8601 UTC timestamp. |
| `closedAt` | string | — | yes | ISO 8601 UTC timestamp. |
| `author.login` | string | — | `author` | `author` is null for a deleted account. |
| `issueType.name` | string | — | `issueType` | `issueType` is null if the issue has no type. |
| `milestone.title` | string | — | `milestone` | `milestone` is null if the issue has no milestone. |
| `labels.totalCount` | int | — | | Number of labels. |
| `labels.nodes[].name` | string | — | | All current labels. Polling completes a truncated label connection. |
| `labelEvents` | map | — | | The last label-addition event for each current label with available history, indexed by label name. See [Label actors](#label-actors). |
| `labelEvents["name"].actor.login` | string | — | `actor` | The GitHub actor's login. For a GitHub App, this is the App slug without `[bot]`. |
| `labelEvents["name"].actor.type` | string | — | `actor` | GitHub's actor type, such as `Bot` or `User`. |
| `labelEvents["name"].createdAt` | string | — | | ISO 8601 UTC time of the last `LabeledEvent`. |
| `assignees.totalCount` | int | — | | Number of assignees. |
| `assignees.nodes[].login` | string | — | | The first 10 assignees. |
| `comments.totalCount` | int | — | | Number of comments. |
| `comments.nodes[]` | list | — | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closedByPullRequestsReferences.totalCount` | int | — | | Number of closing pull request references. |
| `closedByPullRequestsReferences.nodes[]` | list | — | | The first 10 pull requests that close the issue, including closed ones: `number`, `state`, `isDraft`, `url`. |

### `item` for `on: pr`

The pull-request payload slice.

| Field | Type | Default | Nullable | Description |
| --- | --- | --- | --- | --- |
| `number` | int | — | | The pull request number. |
| `title` | string | — | | Item title. |
| `body` | string | — | | Markdown item body. |
| `url` | string | — | | Canonical GitHub item URL. |
| `state` | string | — | | `OPEN`, `CLOSED`, or `MERGED`. |
| `isDraft` | bool | — | | Whether the pull request is a draft. |
| `merged` | bool | — | | Whether the pull request merged. |
| `createdAt` | string | — | | ISO 8601 UTC timestamp. |
| `updatedAt` | string | — | | ISO 8601 UTC timestamp. |
| `mergedAt` | string | — | yes | ISO 8601 UTC timestamp. |
| `author.login` | string | — | `author` | `author` is null for a deleted account. |
| `baseRefName` | string | — | | The target branch. |
| `headRefName` | string | — | | The source branch. |
| `headRefOid` | string | — | | The head commit SHA. Attempts of `pr` loops start from this commit. |
| `additions` | int | — | | Added lines in the diff. |
| `deletions` | int | — | | Removed lines in the diff. |
| `changedFiles` | int | — | | Changed files in the diff. |
| `reviewDecision` | string | — | yes | `APPROVED`, `CHANGES_REQUESTED`, or `REVIEW_REQUIRED`. Null if the branch requires no review. |
| `mergeable` | string | — | | `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`. GitHub computes it lazily, so the first poll after the base branch changes can return `UNKNOWN`. |
| `mergeStateStatus` | string | — | | GitHub's merge state, such as `CLEAN`, `BLOCKED`, `BEHIND`, or `DIRTY`. |
| `statusCheckRollup.state` | string | — | `statusCheckRollup` | The combined check state, such as `SUCCESS`, `FAILURE`, or `PENDING`. `statusCheckRollup` is null if the head commit has no checks. |
| `labels.totalCount` | int | — | | Number of labels. |
| `labels.nodes[].name` | string | — | | All current labels. Polling completes a truncated label connection. |
| `labelEvents` | map | — | | The last label-addition event for each current label with available history, indexed by label name. See [Label actors](#label-actors). |
| `labelEvents["name"].actor.login` | string | — | `actor` | The GitHub actor's login. For a GitHub App, this is the App slug without `[bot]`. |
| `labelEvents["name"].actor.type` | string | — | `actor` | GitHub's actor type, such as `Bot` or `User`. |
| `labelEvents["name"].createdAt` | string | — | | ISO 8601 UTC time of the last `LabeledEvent`. |
| `reviewRequests.totalCount` | int | — | | Number of review requests. |
| `reviewRequests.nodes[].requestedReviewer.login` | string | — | see below | The first 10 review requests. |
| `reviews.totalCount` | int | — | | Number of reviews. |
| `reviews.nodes[]` | list | — | | The last 20 reviews: `author.login` (`author` nullable), `state`, `body`, `submittedAt` (nullable), `commit.oid` (`commit` nullable). |
| `reviewThreads.totalCount` | int | — | | Number of review threads. |
| `reviewThreads.nodes[]` | list | — | | The first 50 threads: `isResolved`, `isOutdated`, `path`, and `comments` with `totalCount` and the first 10 `nodes`, each with `author.login` (`author` nullable) and `body`. |
| `comments.totalCount` | int | — | | Number of comments. |
| `comments.nodes[]` | list | — | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closingIssuesReferences.totalCount` | int | — | | Number of closing issue references. |
| `closingIssuesReferences.nodes[]` | list | — | | The first 10 issues that the pull request closes: `number`, `state`. |

`requestedReviewer` is null if the reviewer is a deleted account. A team review request has no `login`, so `login` reads as `null`.

### Label actors

Issue and pull request expressions can read `item.labelEvents["ready-for-agent"]`.
Only current labels appear in the map. Removing and reapplying a label replaces its
entry with the latest addition's actor and time. A deleted actor is `null`; a label
with no available history has no entry. Check membership with
`"ready-for-agent" in item.labelEvents` before indexing, then check `actor != null`
before reading its fields.

Polling fetches the last 100 `LabeledEvent` entries in the snapshot query. It reads
older pages only while current labels lack an event, up to ten pages in total. If
that limit prevents completing the map, the snapshot keeps the events found and
omits labels whose history is unavailable. The map's actor fields affect event
deduplication; timestamps do not.

The actor identifies the GitHub account that applied the label. An operator action
through the board uses the App's identity too.

### `item` for `on: schedule`

A schedule has no GitHub item. `item` contains the tick.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `item.tick.scheduledAt` | string | — | The time that the tick was scheduled for, in UTC, such as `2026-10-19T07:00:00.000Z`. |
| `item.tick.scheduledAtLocal` | string | — | The same instant in the trigger's time zone, such as `2026-10-19T09:00:00.000+02:00[Europe/Paris]`. |
| `item.tick.cron` | string | — | The trigger's `cron`. |
| `item.tick.tz` | string | — | The trigger's `tz`. |

## Fields that can be null

The fields marked nullable above are nullable in the CEL environment. When such a field is null:

- Comparing it with a value gives `false`: `item.reviewDecision == "APPROVED"` is `false` if the branch requires no review.
- Comparing it with `null`, in either order, tests for a value: `item.milestone != null`, `null == item.author`.
- Reading a field of a null object fails the evaluation: `item.milestone.title == "v1"` fails with `No such key: title` on an issue without a milestone. Test the object first: `item.milestone != null && item.milestone.title == "v1"`. CEL's `&&` returns `false` if either side is `false`, even if the other side fails.
- Selecting a field of a null object with `.?` gives an empty optional instead of failing: `item.?milestone.?title.orValue("none")` is `"none"` on an issue without a milestone. The null field itself counts as present, so `item.?reviewDecision.orValue("NONE")` is `null` if the branch requires no review. See [Optional values](#optional-values).
- `has(item.milestone.title)` is `false`, but `has(item.milestone)` is `true`, because the field exists. Test the value with `!= null`.

Fields of a nullable object keep their types, so a misspelled `item.milestone.titel` still rejects the edit or import. Field names after `.?` aren't checked.

```cel
item.milestone != null && item.milestone.title == "v1"
```

In the body, `{{ item.milestone != null ? item.milestone.title : "no milestone" }}` and `{{ item.?milestone.?title.orValue("no milestone") }}` both render on every issue. A null value renders as `null`.

## Evaluation failures

An evaluation failure leaves the stored loop definition unchanged:

- **`if` of an `issue` or `pr` loop.** usine opens no run for that loop on that item and leaves the item's queued runs as they are. Other loops, other items, and the poll cursor continue. **Needs attention** shows the failure with the loop and the item while it lasts, and usine logs it once per loop, item, and content hash. The first poll after a restart or an applied revision fetches failing items again, so a fixed loop evaluates them without waiting for a change.
- **`if` of a `schedule` loop.** The tick fails for that repository, and usine evaluates it again at the next wake.
- **The recheck before a queued run opens.** usine logs a warning, and the run opens as if the check had passed.
- **An `approval` condition.** The run requires approval and logs a warning. The saved decision explains the evaluation failure.
- **A `{{ ... }}` interpolation.** See [Render failures](/reference/configuration/loops/#task-templates).

## Language

The environment registers only the types and variables above. It adds no functions to the cel-js standard set and enables CEL [optional values](#optional-values).

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
| `has(object.field)` | bool | `false` if `object` is null. See [Fields that can be null](#fields-that-can-be-null). |
| `cel.bind(name, value, expression)` | any | `cel.bind(n, size(item.labels.nodes), n > 0 && n < 5)` |

### Functions

| Function | Description |
| --- | --- |
| `size(x)`, `x.size()` | Length of a string, list, or map. |
| `s.contains(t)`, `s.startsWith(t)`, `s.endsWith(t)` | Substring tests. |
| `s.matches(re)` | Regular expression test, in JavaScript `RegExp` syntax. Inline flags such as `(?i)` aren't supported. Write `[Cc][Ss][Vv]`, or convert to lowercase first. |
| `s.lowerAscii()`, `s.upperAscii()`, `s.trim()` | Case and whitespace. |
| `s.indexOf(t)`, `s.lastIndexOf(t)`, `s.substring(start, end)` | Positions and slices. Indexes start at 0. |
| `s.split(separator)` | List of strings. |
| `list.join()`, `list.join(separator)` | Joins a list of strings. |
| `string(x)`, `int(x)`, `uint(x)`, `double(x)`, `bool(x)`, `bytes(x)`, `dyn(x)` | Conversions. |
| `type(x)` | The type of a value. |
| `timestamp(s)` | Parses an ISO 8601 string, such as `item.updatedAt`. |
| `duration(s)` | Parses a duration such as `"72h"`, `"30m"`, or `"1h30m"`. |
| `t.getFullYear()`, `t.getMonth()`, `t.getDate()`, `t.getDayOfMonth()`, `t.getDayOfWeek()`, `t.getDayOfYear()`, `t.getHours()`, `t.getMinutes()`, `t.getSeconds()`, `t.getMilliseconds()` | Parts of a timestamp, in UTC or in the time zone passed as an argument. `getMonth` and `getDayOfMonth` start at 0, `getDate` at 1, and `getDayOfWeek` is 0 on Sunday. |
| `d.getHours()`, `d.getMinutes()`, `d.getSeconds()`, `d.getMilliseconds()` | Parts of a duration. |

Subtracting two timestamps gives a duration, and durations compare. No function returns the current time. A schedule loop can use `item.tick.scheduledAt`.

### Optional values

`.?` and `[?]` select a value that might be missing. Instead of failing, they give an optional, which contains a value or is empty. Every selection after a `.?` in the same chain also gives an optional.

| Syntax | Result |
| --- | --- |
| `object.?field` | The field's value, or an empty optional if `object` is null or has no such field. |
| `map.?key`, `map[?key]` | The value at `key`, or an empty optional if the key is absent. |
| `list[?index]` | The element at `index`, or an empty optional if the index is out of range: `item.labels.nodes[?0].?name.orValue("none")`. |
| `o.orValue(fallback)` | The value of `o`, or `fallback` if `o` is empty. `fallback` must have the value's type. |
| `o.or(other)` | `o` if it contains a value, otherwise the optional `other`. |
| `o.hasValue()` | `true` if `o` contains a value. |
| `o.value()` | The value of `o`. Evaluation fails if `o` is empty. |
| `optional.of(x)`, `optional.none()` | An optional that contains `x`, and an empty optional. |

An `if` must still produce a `bool`, and an interpolation a scalar, so end the chain with `orValue` or `hasValue()`. `{{ item.?milestone.?title }}` fails validation with `Expected a scalar value, got optional<string>`.

cel-js doesn't check field names after `.?`, so `item.?milestone.?titel.orValue("none") == "v1"` loads and is always `false`. In an interpolation, the same typo fails validation with `Expected a scalar value, got dyn`. In an `if`, prefer the `!= null` form, which keeps field names checked.

## Label declarations

When an instance loads, usine collects the string literals that a loop's `if` compares with a label `name` under `item.labels`, through `==`, `!=`, `in`, and the `exists`, `all`, `exists_one`, `filter`, and `map` macros. For each literal that the stored configuration doesn't declare under `labels`, it logs `Loop trigger references an undeclared GitHub label`. The loop still loads.

## Examples

An issue is ready, and no open pull request closes it yet:

```cel
item.state == "OPEN" &&
item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
!item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
```

Start human-labeled issues automatically and require approval for bot-set labels:

```cel
item.labelEvents["ready-for-agent"].actor.type != "User"
```

The approval expression returns `false` for a `User` actor and `true` for other
actor types. Missing history or a null actor causes an evaluation error, which
requires approval and logs a warning. A board move uses the App identity and
requires approval under this condition. Use `on: pr` for the same policy on pull
requests. The loop's `max_cycles` limit still applies.

A pull request is ready for review, and no outcome label is present:

```cel
item.state == "OPEN" &&
!item.isDraft &&
item.labels.nodes.exists(label, label.name == "ready-for-review") &&
!item.labels.nodes.exists(label, label.name == "review-passed") &&
!item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A review left findings to fix. The loop’s `max_cycles` limits the rounds ([Write review and fix loops](/guides/review-fix-loops/)):

```cel
item.state == "OPEN" &&
!item.isDraft &&
item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

A review passed:

```cel
item.state == "OPEN" &&
!item.isDraft &&
item.labels.nodes.exists(label, label.name == "review-passed")
```

A pull request marked for merge has a conflicting branch:

```cel
item.state == "OPEN" &&
!item.isDraft &&
item.mergeable == "CONFLICTING" &&
item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A schedule that skips weekends in its own time zone:

```cel
timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 0 &&
timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 6
```

Prompt interpolations from the same tasks:

```text
Pull request {{ item.number }} is marked `ready-to-merge` but GitHub reports its branch `{{ item.headRefName }}` as conflicting with `{{ item.baseRefName }}`.
```

## Priority expressions

A loop's [`priority`](/reference/configuration/loops/#priority) accepts an integer or a CEL expression returning `int`, using the same stream-specific `item` and `repo` variables as `trigger.if`:

```cel
item.labels.nodes.exists(l, l.name == "low-priority") ? -1 : 0
```

The scheduler evaluates priority against the saved event snapshot when the run requests a worker slot. Higher values go first; equal values use lane rank and then event arrival. The default is `0`. Evaluation errors, including results outside the safe integer range, use `0` and produce a warning. The editor checks the result type and previews the value for each stored match.
