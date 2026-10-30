---
title: Expressions
description: The CEL dialect of loop conditions and prompt interpolation, the item and repo variables for each trigger, and the functions and macros available.
sidebar:
  order: 4
---

Loop files use [CEL](https://github.com/google/cel-spec) expressions in `trigger.if`, which must produce a `bool`, and in each `{{ ... }}` of the body, which must produce a `string`, `int`, `uint`, `double`, `bool`, or `null`. The `@usine/expression` package evaluates them with [`@marcbachmann/cel-js`](https://www.npmjs.com/package/@marcbachmann/cel-js) 8.0.0 ([`marcbachmann-cel.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/expression/src/marcbachmann-cel.ts#L245)).

Before saving a revision, usine type-checks every expression against its stream's variables. An unknown field, a type mismatch, or a wrong result type rejects the edit or complete import; the stored configuration stays unchanged. Evaluation happens later, against each item's payload or tick.

## Variables

Expressions can use `repo` and `item`. Their types come from the payload slices in [`payload-slices.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/payload-slices.ts#L173), and the values come from GitHub's GraphQL API, with GitHub's field names ([`queries.ts`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/polling/queries.ts#L1)).

### `repo`

The managed repository that the item or tick belongs to ([`repositoryContext`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/payload-slices.ts#L244)).

| Field | Type | Description |
| --- | --- | --- |
| `repo.name` | string | The full `owner/name`, as registered in the stored configuration. |
| `repo.owner` | string | The owner part of the name. |
| `repo.url` | string | `https://github.com/<owner>/<name>`. |

### `item` for `on: issue`

The issue payload slice ([`IssuePayload`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/github/src/polling/payload.ts#L48)). A field marked nullable can be `null` on a given item. See [Fields that can be null](#fields-that-can-be-null).

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
| `issueType.name` | string | `issueType` | `issueType` is null if the issue has no type. |
| `milestone.title` | string | `milestone` | `milestone` is null if the issue has no milestone. |
| `labels.totalCount` | int | | |
| `labels.nodes[].name` | string | | All current labels. Polling completes a truncated label connection. |
| `labelEvents` | map | | The last label-addition event for each current label with available history, indexed by label name. See [Label actors](#label-actors). |
| `labelEvents["name"].actor.login` | string | `actor` | The GitHub actor's login. For a GitHub App, this is the App slug without `[bot]`. |
| `labelEvents["name"].actor.type` | string | `actor` | GitHub's actor type, such as `Bot` or `User`. |
| `labelEvents["name"].createdAt` | string | | ISO 8601 UTC time of the last `LabeledEvent`. |
| `assignees.totalCount` | int | | |
| `assignees.nodes[].login` | string | | The first 10 assignees. |
| `comments.totalCount` | int | | |
| `comments.nodes[]` | list | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closedByPullRequestsReferences.totalCount` | int | | |
| `closedByPullRequestsReferences.nodes[]` | list | | The first 10 pull requests that close the issue, including closed ones: `number`, `state`, `isDraft`, `url`. |

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
| `headRefOid` | string | | The head commit SHA. Attempts of `pr` loops start from this commit. |
| `additions` | int | | |
| `deletions` | int | | |
| `changedFiles` | int | | |
| `reviewDecision` | string | yes | `APPROVED`, `CHANGES_REQUESTED`, or `REVIEW_REQUIRED`. Null if the branch requires no review. |
| `mergeable` | string | | `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`. GitHub computes it lazily, so the first poll after the base branch changes can return `UNKNOWN`. |
| `mergeStateStatus` | string | | GitHub's merge state, such as `CLEAN`, `BLOCKED`, `BEHIND`, or `DIRTY`. |
| `statusCheckRollup.state` | string | `statusCheckRollup` | The combined check state, such as `SUCCESS`, `FAILURE`, or `PENDING`. `statusCheckRollup` is null if the head commit has no checks. |
| `labels.totalCount` | int | | |
| `labels.nodes[].name` | string | | All current labels. Polling completes a truncated label connection. |
| `labelEvents` | map | | The last label-addition event for each current label with available history, indexed by label name. See [Label actors](#label-actors). |
| `labelEvents["name"].actor.login` | string | `actor` | The GitHub actor's login. For a GitHub App, this is the App slug without `[bot]`. |
| `labelEvents["name"].actor.type` | string | `actor` | GitHub's actor type, such as `Bot` or `User`. |
| `labelEvents["name"].createdAt` | string | | ISO 8601 UTC time of the last `LabeledEvent`. |
| `reviewRequests.totalCount` | int | | |
| `reviewRequests.nodes[].requestedReviewer.login` | string | see below | The first 10 review requests. |
| `reviews.totalCount` | int | | |
| `reviews.nodes[]` | list | | The last 20 reviews: `author.login` (`author` nullable), `state`, `body`, `submittedAt` (nullable), `commit.oid` (`commit` nullable). |
| `reviewThreads.totalCount` | int | | |
| `reviewThreads.nodes[]` | list | | The first 50 threads: `isResolved`, `isOutdated`, `path`, and `comments` with `totalCount` and the first 10 `nodes`, each with `author.login` (`author` nullable) and `body`. |
| `comments.totalCount` | int | | |
| `comments.nodes[]` | list | | The last 20 comments: `author.login` (`author` nullable), `body`, `createdAt`. |
| `closingIssuesReferences.totalCount` | int | | |
| `closingIssuesReferences.nodes[]` | list | | The first 10 issues that the pull request closes: `number`, `state`. |

`requestedReviewer` is null if the reviewer is a deleted account. A team review request has no `login`, so `login` reads as `null`.

### Label actors

Issue and pull request expressions can read `item.labelEvents["ready-for-agent"]`.
Only current labels appear in the map. Removing and reapplying a label replaces its
entry with the latest addition's actor and time. A deleted actor is `null`; a label
with no available history has no entry. Older stored payloads decode with an empty
map until polling refreshes them. Check membership with
`"ready-for-agent" in item.labelEvents` before indexing, then check `actor != null`
before reading its fields.

Polling fetches the last 100 `LabeledEvent` entries in the snapshot query. It reads
older pages only while current labels lack an event, up to ten pages in total. If
that limit prevents completing the map, the snapshot keeps the events found and
omits labels whose history is unavailable. The map's actor fields affect event
deduplication; timestamps do not. See [ADR 0007](https://github.com/basaltbytes/usine/blob/main/docs/adr/0007-polling-triggers-content-hashed-events.md) for
the content-hash rules.

The actor identifies the GitHub account that applied the label. An operator action
through the board uses the App's identity too.

### `item` for `on: schedule`

A schedule has no GitHub item. `item` contains the tick ([`tickPayload`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/schedule-triggers.ts#L193)).

| Field | Type | Description |
| --- | --- | --- |
| `item.tick.scheduledAt` | string | The time that the tick was scheduled for, in UTC, such as `2026-10-19T07:00:00.000Z`. |
| `item.tick.scheduledAtLocal` | string | The same instant in the trigger's time zone, such as `2026-10-19T09:00:00.000+02:00[Europe/Paris]`. |
| `item.tick.cron` | string | The trigger's `cron`. |
| `item.tick.tz` | string | The trigger's `tz`. |

## Fields that can be null

The fields marked nullable above are nullable in the CEL environment ([`payload-slices.ts`](https://github.com/basaltbytes/usine/blob/main/packages/config/src/payload-slices.ts)). When such a field is null:

- Comparing it with a value gives `false`: `item.reviewDecision == "APPROVED"` is `false` if the branch requires no review.
- Comparing it with `null`, in either order, tests for a value: `item.milestone != null`, `null == item.author`.
- Reading a field of a null object fails the evaluation: `item.milestone.title == "v1"` fails with `No such key: title` on an issue without a milestone. Test the object first: `item.milestone != null && item.milestone.title == "v1"`. CEL's `&&` returns `false` if either side is `false`, even if the other side fails.
- Selecting a field of a null object with `.?` gives an empty optional instead of failing: `item.?milestone.?title.orValue("none")` is `"none"` on an issue without a milestone. The null field itself counts as present, so `item.?reviewDecision.orValue("NONE")` is `null` if the branch requires no review. See [Optional values](#optional-values).
- `has(item.milestone.title)` is `false`, but `has(item.milestone)` is `true`, because the field exists. Test the value with `!= null`.

Fields of a nullable object keep their types, so a misspelled `item.milestone.titel` still rejects the edit or import. Field names after `.?` aren't checked.

```yaml title="projects/widgets/loops/plan-milestone.md"
trigger:
  on: issue
  if: item.milestone != null && item.milestone.title == "v1"
```

In the body, `{{ item.milestone != null ? item.milestone.title : "no milestone" }}` and `{{ item.?milestone.?title.orValue("no milestone") }}` both render on every issue. A null value renders as `null`.

## Evaluation failures

An evaluation failure leaves the stored loop definition unchanged:

- **`if` of an `issue` or `pr` loop.** usine opens no run for that loop on that item and leaves the item's queued runs as they are. Other loops, other items, and the poll cursor continue. **Needs attention** shows the failure with the loop and the item while it lasts, and usine logs it once per loop, item, and content hash ([`evaluation-failures.ts`](https://github.com/basaltbytes/usine/blob/main/packages/orchestrator/src/polling/evaluation-failures.ts)). The first poll after a restart or an applied revision fetches failing items again, so a fixed loop evaluates them without waiting for a change.
- **`if` of a `schedule` loop.** The tick fails for that repository, and usine evaluates it again at the next wake.
- **The recheck before a queued run opens.** usine logs a warning, and the run opens as if the check had passed ([`TriggerCondition.recheck`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/trigger-condition.ts#L87)).
- **A `{{ ... }}` interpolation.** See [Render failures](/reference/configuration/loop-files/#render-failures).

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

`.?` and `[?]` select a value that might be missing. Instead of failing, they give an optional, which either holds a value or is empty ([`ENVIRONMENT_OPTIONS`](https://github.com/basaltbytes/usine/blob/main/packages/expression/src/marcbachmann-cel.ts)). Every selection after a `.?` in the same chain also gives an optional.

| Syntax | Result |
| --- | --- |
| `object.?field` | The field's value, or an empty optional if `object` is null or has no such field. |
| `map.?key`, `map[?key]` | The value at `key`, or an empty optional if the key is absent. |
| `list[?index]` | The element at `index`, or an empty optional if the index is out of range: `item.labels.nodes[?0].?name.orValue("none")`. |
| `o.orValue(fallback)` | The value of `o`, or `fallback` if `o` is empty. `fallback` must have the value's type. |
| `o.or(other)` | `o` if it holds a value, otherwise the optional `other`. |
| `o.hasValue()` | `true` if `o` holds a value. |
| `o.value()` | The value of `o`. Evaluation fails if `o` is empty. |
| `optional.of(x)`, `optional.none()` | An optional that holds `x`, and an empty optional. |

An `if` must still produce a `bool`, and an interpolation a scalar, so end the chain with `orValue` or `hasValue()`. `{{ item.?milestone.?title }}` fails validation with `Expected a scalar value, got optional<string>`.

cel-js doesn't check field names after `.?`, so `item.?milestone.?titel.orValue("none") == "v1"` loads and is always `false`. In an interpolation, the same typo fails validation with `Expected a scalar value, got dyn`. In an `if`, prefer the `!= null` form, which keeps field names checked.

## Label declarations

When an instance loads, usine collects the string literals that a loop's `if` compares with a label `name` under `item.labels`, through `==`, `!=`, `in`, and the `exists`, `all`, `exists_one`, `filter`, and `map` macros ([`relatedStringLiterals`](https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/expression/src/marcbachmann-cel.ts#L225)). For each literal that the stored configuration doesn't declare under `labels`, it logs `Loop trigger references an undeclared GitHub label`. The loop still loads.

## Examples

An issue is ready, and no open pull request closes it yet:

```yaml title="widgets/start-dev (export format)"
if: >-
  item.state == "OPEN" &&
  item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
  !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
```

Require approval when the factory App applied `ready-for-agent`. Replace
`your-app-slug` with the App's slug, without `[bot]`:

```yaml title="projects/widgets/loops/start-app-labeled.md"
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    "ready-for-agent" in item.labelEvents &&
    item.labelEvents["ready-for-agent"].actor != null &&
    item.labelEvents["ready-for-agent"].actor.type == "Bot" &&
    item.labelEvents["ready-for-agent"].actor.login == "your-app-slug"
approval: required
agent: developer
```

`approval` is a fixed loop setting. To start human-labeled issues automatically,
use a separate loop with `approval: none` and this condition:

```yaml title="projects/widgets/loops/start-human-labeled.md"
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    "ready-for-agent" in item.labelEvents &&
    item.labelEvents["ready-for-agent"].actor != null &&
    item.labelEvents["ready-for-agent"].actor.type == "User"
approval: none
agent: developer
```

These conditions skip unknown actors and missing history. Keep other loops that
start the same work equally restrictive. Use `on: pr` for the same policy on pull
requests. Each loop's existing `max_cycles` limit still applies.

A pull request is ready for review, and no outcome label is present:

```yaml title="projects/widgets/loops/review-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "ready-for-review") &&
  !item.labels.nodes.exists(label, label.name == "review-passed") &&
  !item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A review left findings to fix. The loop's `max_cycles`, not the condition, limits the rounds ([Write review and fix loops](/guides/review-fix-loops/)):

```yaml title="projects/widgets/loops/act-on-findings.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "agent-review-findings")
```

A review passed:

```yaml title="projects/widgets/loops/finish-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.labels.nodes.exists(label, label.name == "review-passed")
```

A pull request marked for merge has a conflicting branch:

```yaml title="projects/widgets/loops/rebase-pr.md"
if: >-
  item.state == "OPEN" &&
  !item.isDraft &&
  item.mergeable == "CONFLICTING" &&
  item.labels.nodes.exists(label, label.name == "ready-to-merge")
```

A schedule that skips weekends in its own time zone:

```yaml title="projects/widgets/loops/daily-digest.md"
if: >-
  timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 0 &&
  timestamp(item.tick.scheduledAt).getDayOfWeek(item.tick.tz) != 6
```

Prompt interpolations from the same loops:

```markdown title="projects/widgets/loops/rebase-pr.md"
Pull request #{{ item.number }} is marked `ready-to-merge` but GitHub reports its branch `{{ item.headRefName }}` as conflicting with `{{ item.baseRefName }}`.
```
