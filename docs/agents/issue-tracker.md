# Issue tracker: GitHub

Issues and specs are GitHub issues. Use the `gh` CLI, which infers the repo from `git remote -v` inside a clone.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`, with a heredoc for a multi-line body.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments with `jq` and fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

If the flag is `yes`, PRs use the labels and states of issues, with `gh pr`:

- **Read a PR**: `gh pr view <number> --comments`, and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, keeping only an `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (not `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

Issues and PRs share one number space. For `#42`, run `gh pr view 42`, and if it fails, `gh issue view 42`.

## Skill phrases

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": run `gh issue view <number> --comments`.

## Wayfinding operations

For `/wayfinder`. The **map** is one issue; its **child** issues are the tickets. Active map: [#1](https://github.com/basaltbytes/usine/issues/1).

- **Map**: an issue labeled `wayfinder:map` (`gh issue create --label wayfinder:map`) with a Notes / Decisions-so-far / Fog body.
- **Child ticket**: a GitHub sub-issue of the map (`gh api` on the sub-issues endpoint), labeled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). A claimed ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), _not_ the `#number` or `node_id`. A ticket is unblocked when all its blockers are closed; `issue_dependencies_summary.blocked_by` counts open blockers only.
- **Frontier query**: list the map's open sub-issues (`gh issue list --state open`), drop those with an assignee or an open blocker (`issue_dependencies_summary.blocked_by > 0`), and take the first in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me`, as the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, `gh issue close <n>`, then append a context pointer (gist and link) to the map's Decisions-so-far.
