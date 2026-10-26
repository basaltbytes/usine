---
"@usine/executor": patch
---

The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, as well as what Git ignores, even if the agent staged them. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `Retained`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.
