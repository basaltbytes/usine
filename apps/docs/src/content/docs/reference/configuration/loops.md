---
title: Loops
description: Stored loop fields, triggers, selectors, tasks, approval, and queue priority.
---

Manage loops in **Configuration > Loops** or edit an existing loop with `usine config edit loop widgets/start-dev`. A loop belongs to a project and uses an agent from the instance. Its identity is `project/loop`; short names work only when unambiguous. New loops start paused. Review **Preview** before selecting **Resume**.

## Loop

The names below identify fields in the text editor. The form provides controls for the same settings. See [Import and export format](/reference/configuration/import-export/) for serialization.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| name | kebab-case name | required | Unique name within the project. |
| `trigger` | trigger | required | Stream and selection condition that start runs. |
| `agent` | agent name | required | Existing agent used for the run. |
| task | non-blank Markdown | required | Task template rendered when the trigger matches. |
| `selector` | selector | all project repositories | Repositories in the project that the loop applies to. |
| `approval` | `none`, `required`, or boolean CEL expression | `none` | Whether a new run waits for an operator approval. |
| `step` | non-empty string | `run` | Name of the run's single step, included in attempt IDs and logs. |
| `max_cycles` | integer ≥ 1 | `3` | Runs this loop can open on one item between operator resets. |
| `permissions` | `write` or `read` | `write` | Repository content access of each attempt's GitHub token. |
| `priority` | integer or integer CEL expression | `0` | Queue priority, with higher values first. |
| `outcome_labels` | list of label names | `[]` | At least one must be added to the item during the run before the agent completes. Not allowed on schedule loops. |
| `ci` | CI policy | omitted | Required checks and fix loop after an agent pushes. |

For example, choose the issue stream, agent `developer`, approval `required`, and this condition:

```cel
item.state == "OPEN" &&
item.labels.nodes.exists(label, label.name == "ready-for-agent")
```

Use a task such as:

```text
Complete issue {{ item.number }}: {{ item.title }}.
Remove ready-for-agent before editing. Open a pull request that closes the issue.
Run the repository checks and push before finishing. Do not merge.
```

## Trigger

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `on` | `issue`, `pr`, or `schedule` | required | State stream evaluated by the trigger. |
| `if` | boolean CEL expression | required | Condition evaluated against the stream's `item` and `repo` variables. |
| `cron` | five-field cron string | required for schedules | Scheduled times, accepted only with the schedule stream. |
| `tz` | IANA time zone | `UTC` | Time zone for a schedule trigger. |

For example, a weekly schedule uses cron `0 6 * * 1`, time zone `Europe/Paris`, and condition `true`. After downtime, only the latest missed tick fires, once per selected repository.

Polling evaluates changed issues and pull requests, and refreshes open pull requests for mergeability changes. A matching item state opens one run; timestamps alone do not create another state. A changed state can supersede a run before its first attempt. A false condition revokes runs with no started attempt; running attempts continue. A queued event is rechecked before opening its run; a recheck error or timeout permits the run and logs a warning.

Issue and schedule attempts start detached at the latest default-branch commit. Pull request attempts start detached at the recorded head commit. A task that pushes to a pull request must tell the agent to check out its source branch first.

## Selector

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `repos` | non-empty list of repository names | omitted | Registered repository names matched without case sensitivity. |
| `tags` | non-empty list of tags | omitted | Registry tags, any one of which matches a repository. |

Set one or both fields, without duplicates. With both, a repository must appear in `repos` and have a tag in `tags`. For example, `repos` containing `acme/widgets` and `tags` containing `backend` selects that repository only if it has the tag and belongs to the project.

## Approval

A conditional approval uses the trigger's variables. `true` requires approval; `false` starts automatically. An evaluation error requires approval and logs its reason. For example:

```cel
item.labelEvents["ready-for-agent"].actor.type != "User"
```

This requires approval for labels applied by bots, board moves made through the App, and labels with unavailable actor history. The decision is recorded with the event. Retry retains it; **Run again** evaluates the current condition against the saved payload.

## Cycle budget

Each loop counts its runs separately. A retry uses the same reservation; cancellation before the first attempt returns it. Schedule loops do not use cycle budgets. When a loop exhausts its allowance, **Cycle budget exhausted** appears in **Needs attention**, and new work on the item waits for an operator reset. Existing admitted runs can finish. Label edits and restarts preserve the budget.

The entry identifies the most recently blocked loop, including a loop blocked by another loop's exhausted allowance. If you dismiss the entry, a later blocked event raises it again. Repeated polling of the same blocked events preserves the dismissal. **Reset cycle budget** answers the item's ask and requests fresh trigger evaluation.

## Permissions

`read` gives the attempt token `contents: read` and omits `workflows` while retaining issue and pull request writes for reviews, comments, and labels. GitHub refuses code pushes with that token. A pre-push hook also explains the restriction. Failed read-only attempts create no salvage branch. `write` gives the token `contents: write` and `workflows: write`, permitting code pushes, changes under `.github/workflows/`, and pull request updates. The App and its installation must grant **Workflows: read and write**.

The setting limits the attempt's token. Local children run as the orchestrator's Unix user and can access that user's other credentials. SSH attempt containers mount only their checkout and credential directory. See [Workers](/reference/configuration/workers/).

## Outcome labels

Set `outcome_labels: [review-passed, agent-review-findings]` for a review loop that must publish a verdict. Before usine accepts the agent's completion, it reads the item's label events from GitHub. One of the configured labels must have been added by a GitHub account used by any attempt in the run, at or after the run's first attempt started. Retries in the same run can reuse a verdict from an earlier attempt, even when adding the label again produces no new GitHub event. The label counts even if it was removed before the attempt settled, for example by a fix loop that removes `agent-review-findings` when it starts its run. A label left on the item from an earlier run doesn't count. Label names match without case sensitivity.

If usine can't read the label events, it checks the item's current labels instead. If no configured label counts, the attempt and run fail with `AgentFailure` and appear in **Needs attention**; the attempt keeps the agent's final message and recorded facts.

The label-event read, including bot-account lookup and all accounts used by the run, has a 15-second timeout. The current-label read has its own 15-second timeout. usine retries a read twice, after one and two seconds, after timeouts, transport failures, server errors, and other failures that GitHub does not classify as definite refusals. A missing item or a definite refusal, such as a 401, 403, or 404 response, ends the read. If the current labels can't be read either, the attempt and run fail with `AgentFailure` in **Needs attention**. Verification retries only the reads; it doesn't rerun the agent.

The empty default disables verification. The requirement is saved with the event, so retry and restart retain it; **Run again** uses the current loop setting. Outcome labels apply when the agent ends. For labels applied after CI passes, use the handoff's `on_green` actions instead. Don't list an `on_green` label in `outcome_labels`: usine checks the outcome labels when the agent ends, before the CI wait starts, so the label isn't there yet and the run fails.

A schedule loop can't set `outcome_labels` because its runs have no item to label; the loop fails to load with a schema error. Labels that differ only in letter case are rejected. A label that `usine.yaml` doesn't declare under `labels` still loads, but usine logs `Loop outcome label is not a declared GitHub label` at startup and each time it applies a configuration revision, and the loop's page in **Configuration > Loops** shows a warning next to its outcome labels.

Earlier versions accepted outcome labels on a schedule loop and labels that differ only in letter case. When usine opens a stored configuration that contains them, it removes the schedule loop's outcome labels and each repeated label, keeping the first spelling. It records the change as one configuration revision without an actor and logs `Removed stored outcome labels that the loop rules reject` for each loop. If the configuration is still invalid after this change, usine leaves the stored loops unchanged and logs `Kept stored outcome labels; the upgraded configuration is invalid` with the problems. In **Configuration > History**, a stored loop value that the current rules reject appears as YAML of its stored fields.

## Priority

Worker slots go first to reattached attempts, then waiting runs by descending priority, later authored label lane, and oldest event. Runs without a matching lane follow ranked runs of equal priority.

A priority expression must return a safe integer between -9007199254740991 and 9007199254740991. It reads the saved event snapshot when a run requests a slot. Evaluation failures use `0` and log a warning. Existing reservations keep their rank. For example:

```cel
item.labels.nodes.exists(label, label.name == "low-priority") ? -1 : 0
```

**Overview** shows the evaluated priority and number of runs ahead. **Preview** shows priorities for stored matches.

## Task templates

`{{ expression }}` inserts a scalar CEL result: string, integer, unsigned integer, double, boolean, or null. A list or object must be converted to a scalar, such as `{{ item.labels.nodes.map(label, label.name).join(", ") }}`. Each interpolation ends at the next `}}`; there is no escape for a literal opening delimiter.

Schema, expression, and reference checks run before saving. An unknown agent or selector reference rejects the revision. A nullable field can still cause an evaluation failure on a particular item. For issue and pull request triggers, **Needs attention** identifies the loop, item, and expression; other work continues. Failed items are evaluated again after an item change, restart, or applied revision. Failed schedule ticks are evaluated at the next wake.

The parent receives the event payload, rendered task, persona, and salvage information. Fixed instructions require foreground checks, pushed work, `COMMENT` reviews, and the signature `— usine agent: <name>` on GitHub prose. `[usine:blocked]` reports an unresolved blocker; `[usine:question]` asks for an operator decision.

## CI policy

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `fix_loop` | qualified loop identity | required | Active pull request loop that selects this repository and handles failed checks or merge conflicts that prevent checks from starting. |
| `timeout_seconds` | integer, 1–86400 | required | Maximum CI wait after the agent session ends. |

For example, use fix loop `widgets/act-on-findings` and timeout `1800`. The policy is saved with the event, so later configuration edits do not remove it from an existing run. [Connect review and fix loops](/guides/review-fix-loops/) describes the agent handoff and completion labels.
