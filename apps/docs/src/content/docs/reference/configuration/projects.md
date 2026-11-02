---
title: Projects and registry
description: Project membership, board lanes, managed repositories, and labels.
---

Manage projects in **Configuration > Projects**. A project groups registered repositories under one board and owns its loops. A repository can belong to at most one project; a registered repository without a project has no board or loop execution.

## Project

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | slug | required | Unique lowercase letters and digits separated by single hyphens. |
| `name` | non-blank string | required | Display name in navigation and the board. |
| `repositories` | list of repository names | required | Non-empty, ordered list of unique registered repositories. |
| `lanes` | list of lanes | `[]` | Shared board lanes in display and queue-ranking order. |

Edit one project with `usine config edit project widgets`:

```yaml
id: widgets
name: Widgets
repositories: [acme/widgets, acme/gadgets]
lanes:
  - name: Ready
    sources: [{ label: ready-for-agent }]
  - name: Review
    sources: [{ label: ready-for-review }]
  - name: Done
    sources: [{ state: pr-merged }, { state: issue-closed }]
```

## Lane

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | non-blank string | required | Unique lane name within the project. |
| `sources` | non-empty list | required | Label or item-state sources that place tasks in the lane. |
| `sources[].label` | GitHub label name | omitted | Label matched without case sensitivity and added by a board move into the lane. |
| `sources[].state` | item state | omitted | One of `issue-open`, `issue-closed`, `pr-open`, `pr-closed`, or `pr-merged`. |

Each source sets exactly one of `label` or `state`. A source can appear in only one lane of a project. For example, `{ label: ready-for-agent }` makes a lane accept board moves; `{ state: pr-merged }` makes it reflect a GitHub state.

The board places a task using its current item. Closed or merged items use the first matching state lane. Open items use the first matching label lane, then a matching state lane. During a running attempt, if no current label matches, the board also checks the labels recorded when the run matched. A task with no matching lane appears in **Unmapped**. Without authored lanes, the board shows read-only lanes for repository labels.

Moving a task into a label lane adds that lane's labels and removes the other authored lanes' labels in the current item's repository. It does not close or merge the item. Later label lanes receive higher queue rank when [loop priorities](/reference/configuration/loops/#priority) are equal.

## Registry entry

Manage registry entries in **Configuration > Repositories** or edit one with `usine config edit repository acme/widgets`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `owner/name` | required | GitHub repository name, unique without case sensitivity. |
| `tags` | list of non-blank strings | `[]` | Unique tags available to loop selectors. |

```yaml
name: acme/widgets
tags: [web, backend]
```

The GitHub App installation must include every managed repository. A loop selector narrows membership within its project and cannot select a repository outside it.

## Label declaration

Manage declarations in **Configuration > Labels** or edit one with `usine config edit label ready-for-agent`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string, up to 50 characters | required | Label name without surrounding whitespace, unique without case sensitivity. |
| `color` | six hexadecimal digits | omitted | GitHub color without the leading hash character. |
| `description` | string, up to 100 characters | omitted | Description shown on GitHub. |

```yaml
name: ready-for-agent
color: "0e8a16"
description: Ready for an agent
```

Quote colors so YAML reads them as strings. Polling creates missing declared labels and lane labels in managed repositories. Different existing colors or descriptions produce warnings; usine does not edit or delete existing GitHub labels when declarations change.
