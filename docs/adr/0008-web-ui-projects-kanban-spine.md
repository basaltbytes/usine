# The web UI centers projects, boards, and tasks

The UI centers work, not machinery: the overview leads with statistics, then Needs attention, running attempts, stalled items, and recent runs; the sidebar lists projects. A project opens as a board whose lanes map GitHub labels or item states, proposed from repository labels until the project configures them. Dragging a card between authored label lanes writes the label swap to GitHub, so the board is also a trigger surface. Proposed and state lanes are read-only, because labels such as `bug` aren't workflow state, and a move keeps labels outside the lane map.

Every lane stays in one row, and no task is hidden by default. Unmapped and closed-only lanes come last. Unmapped starts open while it holds an open item; closed-only lanes, and Unmapped with no open item, start folded to rails with their counts. Each browser remembers the operator's fold choice per lane.

A card is a task: the issues and pull requests that GitHub's closing references or saved run results link within one repository, with all their runs. A task is a read projection with no stored identity; runs, approvals, and cycle budgets keep their own records. Its earliest issue, or else its earliest pull request, names it.

Statistics count tasks: a task is done when its pull request merges, and its time, tokens, and price cover all its runs.

An item or a repository has one shared component that every surface uses, so a restyle changes it everywhere.

## Considered options

- **A runs console as home**: dense, but the operator thinks in projects and items.
- **Loops as home**: configuration where the work should be.
- **An intervention inbox as home**: too narrow; it became Needs attention.
- **Hiding empty lanes, Done, Unmapped, and tasks no loop matches**: hid work the operator needed, such as open pull requests.
- **Folding Unmapped by default**: hid open pull requests without a lane label until the operator opened the rail.
- **Linking items by title, branch, or a bare number**: guesses, and a bare number can name another repository's item.
